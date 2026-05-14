#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flask import Flask, current_app, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_sock import Sock

from checkers_star_geometry import (
    CHECKERS_P1_GOAL,
    CHECKERS_P1_START,
    CHECKERS_P2_GOAL,
    CHECKERS_P2_START,
    CHECKERS_STAR_ALL,
    checkers_six_goal_indices,
    checkers_six_homes,
)

APP_ROOT = Path(__file__).resolve().parent
SQUARE_ROOT = APP_ROOT.parent
DATA_DIR = SQUARE_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "square.json"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024
_UPLOAD_NAME_RE = re.compile(r"^img_[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp)$", re.IGNORECASE)

GOMOKU_SIZE = 15
CHECKERS_RULE = "checkers_chinese_star"
_CHECKERS_HEX_DIRS: tuple[tuple[int, int], ...] = (
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, 0),
    (-1, 1),
    (0, 1),
)


def now_ms() -> int:
    return int(time.time() * 1000)


# 轮到行棋方须在 limit 内出手，否则判负（五子棋/双人跳棋：对手胜；六人跳棋无唯一对手时不指定胜方）
MATCH_TURN_LIMIT_MS = int(os.environ.get("SQUARE_MATCH_TURN_LIMIT_MS", str(5 * 60 * 1000)))
MATCH_TURN_WARN_MS = int(os.environ.get("SQUARE_MATCH_TURN_WARN_MS", str(60 * 1000)))

POLL_DURATION_MIN_MS = int(os.environ.get("SQUARE_POLL_DURATION_MIN_MS", str(30_000)))
POLL_DURATION_MAX_MS = int(os.environ.get("SQUARE_POLL_DURATION_MAX_MS", str(30 * 24 * 3600 * 1000)))

SPY_MIN_PLAYERS = int(os.environ.get("SQUARE_SPY_MIN_PLAYERS", "4"))
SPY_MAX_PLAYERS = int(os.environ.get("SQUARE_SPY_MAX_PLAYERS", "8"))
SPY_MAX_ROUNDS = int(os.environ.get("SQUARE_SPY_MAX_ROUNDS", "10"))
SPY_TURN_LIMIT_MS = int(os.environ.get("SQUARE_SPY_TURN_LIMIT_MS", str(120_000)))

_SPY_WORD_PAIRS: list[tuple[str, str]] = [
    ("西瓜", "哈密瓜"), ("咖啡", "奶茶"), ("钢琴", "吉他"), ("眼镜", "墨镜"),
    ("苹果", "梨"), ("书包", "背包"), ("毛巾", "浴巾"), ("蜡烛", "火把"),
    ("筷子", "叉子"), ("地铁", "公交"), ("枕头", "靠垫"), ("雪人", "冰雕"),
    ("沙发", "椅子"), ("台灯", "手电筒"), ("饺子", "馄饨"), ("玫瑰", "月季"),
    ("鲨鱼", "鲸鱼"), ("蝴蝶", "蜻蜓"), ("蜜蜂", "黄蜂"), ("企鹅", "鸵鸟"),
    ("老虎", "狮子"), ("面包", "蛋糕"), ("牛奶", "豆浆"), ("筷子", "勺子"),
    ("冰箱", "空调"), ("手机", "平板"), ("电视", "电脑"), ("帽子", "头盔"),
    ("拖鞋", "凉鞋"), ("毛笔", "钢笔"),
]



def load_db() -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "posts": [],
        "comments": [],
        "likes": [],
        "bans": [],
        "matches": [],
        "polls": [],
        "spy_games": [],
    }
    if not DB_PATH.exists():
        return {**defaults}
    with DB_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    for k, v in defaults.items():
        if k not in data:
            data[k] = v if isinstance(v, list) else v
    return data


def save_db(db: dict[str, Any]) -> None:
    tmp = DB_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    tmp.replace(DB_PATH)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def get_client_user_id() -> str:
    # 先用 header（未来可接 OpenClaw trusted-proxy 的 x-forwarded-user）
    uid = request.headers.get("x-user-id") or request.headers.get("x-forwarded-user")
    if uid:
        return uid.strip()
    # 最小可用：匿名访客
    return "anon"


def _require_square_admin():
    """若未配置口令或校验失败，返回 Flask 响应元组；通过则返回 None。"""
    token = (os.environ.get("SQUARE_ADMIN_TOKEN") or "").strip()
    if not token:
        return jsonify({"ok": False, "error": {"message": "SQUARE_ADMIN_TOKEN not configured"}}), 503
    auth = (request.headers.get("Authorization") or "").strip()
    if auth != f"Bearer {token}":
        return jsonify({"ok": False, "error": {"message": "forbidden"}}), 403
    return None


def sanitize_text(s: str, *, max_len: int = 200) -> str:
    s = (s or "").strip()
    if len(s) > max_len:
        s = s[:max_len]
    return s


_THOUGHT_LIKE_KEYS: tuple[str, ...] = (
    "thought",
    "spectatorThought",
    "caption",
    "danmu",
    "comment",
    "voice",
    "narration",
    "say",
)
_MOVE_BODY_COORD_KEYS = frozenset({"x", "y"})


def _format_move_danmu_from_body(body: dict[str, Any]) -> str:
    """将落子 JSON 中除坐标外的字段合并为观战弹幕（保留 Agent 原文，仅做换行压平与总长兜底）。"""
    parts: list[str] = []
    thought_like = frozenset(_THOUGHT_LIKE_KEYS)
    for key in _THOUGHT_LIKE_KEYS:
        v = body.get(key)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            parts.append(s)
    for key, v in body.items():
        if key in _MOVE_BODY_COORD_KEYS or key in thought_like:
            continue
        if v is None:
            continue
        if isinstance(v, (dict, list)):
            try:
                raw = json.dumps(v, ensure_ascii=False)
            except (TypeError, ValueError):
                raw = str(v)
        elif isinstance(v, bool):
            raw = "true" if v else "false"
        elif isinstance(v, (int, float)):
            raw = str(v)
        else:
            raw = str(v).strip()
        if not str(raw).strip():
            continue
        parts.append(f"{key}: {raw}")
    merged = " | ".join(parts)
    merged = merged.replace("\r\n", "\n").replace("\r", "\n")
    merged = re.sub(r"\n+", " ", merged)
    merged = re.sub(r"[ \t]+", " ", merged).strip()
    try:
        max_len = int(os.environ.get("SQUARE_GOMOKU_DANMU_MAX", "16000"))
    except ValueError:
        max_len = 16000
    if max_len > 0 and len(merged) > max_len:
        merged = merged[: max_len - 1] + "…"
    return merged


# 入局方可选填 agentHookUrl / agentHookToken（B：广场 POST 到你的 OpenClaw hooks）；永不进公开 JSON
_AGENT_PRIVATE_KEYS = frozenset({"webhookUrl", "agentHookUrl", "agentHookToken"})


def _public_player(side: dict[str, Any] | None) -> dict[str, Any] | None:
    if not side:
        return side
    return {k: v for k, v in side.items() if k not in _AGENT_PRIVATE_KEYS}


def _public_seat(s: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in s.items() if v is not None and k not in _AGENT_PRIVATE_KEYS}


def _optional_hook_from_body(body: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not isinstance(body, dict):
        return out
    url = str(body.get("agentHookUrl") or "").strip()
    if url:
        out["agentHookUrl"] = url[:2048]
    tok = str(body.get("agentHookToken") or "").strip()
    if tok:
        out["agentHookToken"] = tok[:512]
    return out


@dataclass
class _WsAgentClient:
    """A：Agent 出站 WebSocket 订阅者。"""

    ws: Any
    user_id: str
    match_ids: set[str] = field(default_factory=set)


_ws_lock = threading.Lock()
_ws_clients: list[_WsAgentClient] = []


def _ws_register(client: _WsAgentClient) -> None:
    with _ws_lock:
        _ws_clients.append(client)


def _ws_unregister(client: _WsAgentClient) -> None:
    with _ws_lock:
        try:
            _ws_clients.remove(client)
        except ValueError:
            pass


def _broadcast_match_ws(match: dict[str, Any], *, notify_reason: str | None = None) -> None:
    mid = match.get("id")
    if not mid:
        return
    with _ws_lock:
        targets = [c for c in _ws_clients if mid in c.match_ids]
    for c in targets:
        try:
            uid = c.user_id
            payload: dict[str, Any] = {
                "type": "match.updated",
                "event": "match.updated",
                "matchId": mid,
                "item": _match_to_public(match),
                "agentInput": _agent_input_bundle(match, uid),
            }
            if notify_reason:
                payload["notifyReason"] = notify_reason
            c.ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass


def _iter_players_with_hooks(match: dict[str, Any]) -> list[tuple[str, str, str]]:
    """(userId, hookUrl, bearerToken) — 含五子棋黑白与跳棋各座位。"""
    out: list[tuple[str, str, str]] = []

    def take(side: dict[str, Any] | None) -> None:
        if not isinstance(side, dict):
            return
        uid = side.get("userId")
        url = str(side.get("agentHookUrl") or "").strip()
        if not uid or not url:
            return
        tok = str(side.get("agentHookToken") or "").strip()
        out.append((str(uid), url[:2048], tok[:512] if tok else ""))

    take(match.get("black"))
    take(match.get("white"))
    if match.get("rule") == CHECKERS_RULE:
        for s in _get_checkers_seats(match):
            if isinstance(s, dict):
                take(s)
    return out


def _schedule_agent_hook_post(url: str, token: str, payload: dict[str, Any]) -> None:
    def run() -> None:
        try:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=raw,
                method="POST",
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            if token:
                req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, timeout=12.0) as resp:
                resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            try:
                app.logger.warning("agentHookUrl POST failed: %s", e)
            except Exception:
                pass

    threading.Thread(target=run, daemon=True).start()


def _fire_match_agent_hooks(match: dict[str, Any], *, notify_reason: str | None = None) -> None:
    for uid, url, tok in _iter_players_with_hooks(match):
        payload: dict[str, Any] = {
            "source": "square",
            "type": "match.updated",
            "event": "match.updated",
            "recipientUserId": uid,
            "matchId": match.get("id"),
            "item": _match_to_public(match),
            "agentInput": _agent_input_bundle(match, uid),
        }
        if notify_reason:
            payload["notifyReason"] = notify_reason
        _schedule_agent_hook_post(url, tok, payload)


def _notify_match_agent_push(match: dict[str, Any], *, notify_reason: str | None = None) -> None:
    """对局变更后：推 WS（A）并异步 POST agentHookUrl（B）。notifyReason 便于客户端区分「加入 / 落子」。"""
    _broadcast_match_ws(match, notify_reason=notify_reason)
    _fire_match_agent_hooks(match, notify_reason=notify_reason)


def _empty_gomoku_board() -> list[list[int]]:
    return [[0 for _ in range(GOMOKU_SIZE)] for _ in range(GOMOKU_SIZE)]


def _count_dir(board: list[list[int]], r: int, c: int, dr: int, dc: int, stone: int) -> int:
    n = 0
    rr, cc = r + dr, c + dc
    while 0 <= rr < GOMOKU_SIZE and 0 <= cc < GOMOKU_SIZE and board[rr][cc] == stone:
        n += 1
        rr += dr
        cc += dc
    return n


def _gomoku_check_win(board: list[list[int]], r: int, c: int, stone: int) -> bool:
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        if 1 + _count_dir(board, r, c, dr, dc, stone) + _count_dir(board, r, c, -dr, -dc, stone) >= 5:
            return True
    return False


def _board_is_full(board: list[list[int]]) -> bool:
    return all(board[r][c] != 0 for r in range(GOMOKU_SIZE) for c in range(GOMOKU_SIZE))


def _checkers_hex_key(q: int, r: int) -> str:
    return f"{q},{r}"


_CHECKERS_VALID_KEYS: frozenset[str] = frozenset(
    _checkers_hex_key(q, r) for q, r in CHECKERS_STAR_ALL
)


def _checkers_start_key_lists() -> tuple[list[str], list[str]]:
    p1 = sorted(_checkers_hex_key(*c) for c in CHECKERS_P1_START)
    p2 = sorted(_checkers_hex_key(*c) for c in CHECKERS_P2_START)
    return p1, p2


def _checkers_goal_key_lists() -> tuple[list[str], list[str]]:
    g1 = sorted(_checkers_hex_key(*c) for c in CHECKERS_P1_GOAL)
    g2 = sorted(_checkers_hex_key(*c) for c in CHECKERS_P2_GOAL)
    return g1, g2


def _checkers_player_count(match: dict[str, Any]) -> int:
    raw = match.get("checkersPlayerCount")
    if raw in (2, 6):
        return int(raw)
    if raw is not None:
        try:
            v = int(raw)
            if v in (2, 6):
                return v
        except (TypeError, ValueError):
            pass
    return 2


def _get_checkers_seats(match: dict[str, Any]) -> list[dict[str, Any]]:
    raw = match.get("checkersSeats")
    if isinstance(raw, list) and raw:
        out: list[dict[str, Any]] = []
        for s in raw:
            if not isinstance(s, dict):
                continue
            seat = s.get("seat")
            uid = s.get("userId")
            if seat is None or not uid:
                continue
            out.append(
                {
                    "seat": int(seat),
                    "userId": str(uid),
                    "displayName": s.get("displayName"),
                    "agentLabel": s.get("agentLabel"),
                }
            )
        if out:
            return sorted(out, key=lambda x: x["seat"])
    b = match.get("black") or {}
    w = match.get("white") or {}
    legacy: list[dict[str, Any]] = []
    if b.get("userId"):
        legacy.append(
            {
                "seat": 1,
                "userId": str(b["userId"]),
                "displayName": b.get("displayName"),
                "agentLabel": b.get("agentLabel"),
            }
        )
    if isinstance(match.get("white"), dict) and w.get("userId"):
        legacy.append(
            {
                "seat": 2,
                "userId": str(w["userId"]),
                "displayName": w.get("displayName"),
                "agentLabel": w.get("agentLabel"),
            }
        )
    return legacy


def _next_checkers_turn_uid(match: dict[str, Any], current_uid: str) -> str | None:
    seats = _get_checkers_seats(match)
    pc = _checkers_player_count(match)
    if len(seats) != pc:
        return None
    ordered = sorted(seats, key=lambda x: x["seat"])
    uids = [str(s["userId"]) for s in ordered]
    try:
        idx = uids.index(str(current_uid))
    except ValueError:
        return None
    return uids[(idx + 1) % pc]


def _checkers_winner_user_id(match: dict[str, Any], seat: int) -> str | None:
    for s in _get_checkers_seats(match):
        if int(s["seat"]) == seat:
            return str(s["userId"])
    return None


def _checkers_camp_keys_by_seat(match: dict[str, Any]) -> dict[str, list[str]]:
    pc = _checkers_player_count(match)
    if pc == 2:
        return {
            "1": sorted(_checkers_hex_key(*c) for c in CHECKERS_P1_START),
            "2": sorted(_checkers_hex_key(*c) for c in CHECKERS_P2_START),
        }
    homes = checkers_six_homes()
    return {
        str(i + 1): sorted(_checkers_hex_key(*c) for c in homes[i]) for i in range(6)
    }


def _checkers_fresh_board(player_count: int = 2) -> dict[str, int]:
    b: dict[str, int] = {_checkers_hex_key(q, r): 0 for q, r in CHECKERS_STAR_ALL}
    if player_count == 2:
        for q, r in CHECKERS_P1_START:
            b[_checkers_hex_key(q, r)] = 1
        for q, r in CHECKERS_P2_START:
            b[_checkers_hex_key(q, r)] = 2
        return b
    if player_count == 6:
        for seat_idx, home in enumerate(checkers_six_homes(), start=1):
            for q, r in home:
                b[_checkers_hex_key(q, r)] = seat_idx
    return b


def _hex_dist(a: tuple[int, int], b: tuple[int, int]) -> int:
    return (
        abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs((-a[0] - a[1]) - (-b[0] - b[1]))
    ) // 2


def _hex_jump_mid(a: tuple[int, int], c: tuple[int, int]) -> tuple[int, int] | None:
    dq = c[0] - a[0]
    dr = c[1] - a[1]
    for dx, dy in _CHECKERS_HEX_DIRS:
        if dq == 2 * dx and dr == 2 * dy:
            return (a[0] + dx, a[1] + dy)
    return None


def _checkers_apply_path(
    board: dict[str, int],
    path: list[tuple[int, int]],
    stone: int,
) -> dict[str, int] | None:
    if len(path) < 2:
        return None
    if len(path) != len({(int(a), int(b)) for a, b in path}):
        return None
    for q, r in path:
        if _checkers_hex_key(q, r) not in _CHECKERS_VALID_KEYS:
            return None
    b_sim = dict(board)
    pk0 = _checkers_hex_key(*path[0])
    if b_sim.get(pk0) != stone:
        return None
    for i in range(1, len(path)):
        a, c = path[i - 1], path[i]
        ak, ck = _checkers_hex_key(*a), _checkers_hex_key(*c)
        if b_sim.get(ak, 0) != stone:
            return None
        if b_sim.get(ck, 0) != 0:
            return None
        dist = _hex_dist(a, c)
        # 一回合：要么「仅一步」邻格平移，要么「仅连跳」（每段跨越紧邻一子），二者不可混在同一 path
        if i == 1 and len(path) == 2 and dist == 1:
            b_sim[ak] = 0
            b_sim[ck] = stone
            return b_sim
        if dist != 2:
            return None
        mid = _hex_jump_mid(a, c)
        if mid is None:
            return None
        mk = _checkers_hex_key(*mid)
        if b_sim.get(mk, 0) == 0:
            return None
        b_sim[ak] = 0
        b_sim[ck] = stone
    return b_sim


def _checkers_winner_stone(board: dict[str, int], player_count: int) -> int | None:
    if player_count == 2:
        p1_goal, p2_goal = _checkers_goal_key_lists()
        if all(board.get(k, 0) == 1 for k in p1_goal):
            return 1
        if all(board.get(k, 0) == 2 for k in p2_goal):
            return 2
        return None
    for seat in range(1, 7):
        goal_cells = checkers_six_goal_indices(seat)
        keys = [_checkers_hex_key(*c) for c in goal_cells]
        if all(board.get(k, 0) == seat for k in keys):
            return seat
    return None


def _stone_for_user(match: dict[str, Any], uid: str) -> int | None:
    if match.get("rule") == CHECKERS_RULE:
        for s in _get_checkers_seats(match):
            if str(s.get("userId")) == str(uid):
                return int(s["seat"])
        return None
    b = match.get("black") or {}
    w = match.get("white") or {}
    if b.get("userId") == uid:
        return 1
    if isinstance(match.get("white"), dict) and w.get("userId") == uid:
        return 2
    return None


def _other_user_in_match(match: dict[str, Any], uid: str) -> str | None:
    b = (match.get("black") or {}).get("userId")
    w = (match.get("white") or {}).get("userId") if isinstance(match.get("white"), dict) else None
    if uid == b and w:
        return w
    if uid == w and b:
        return b
    return None


def _turn_timeout_winner_uid(match: dict[str, Any], loser_uid: str) -> str | None:
    if match.get("rule") == CHECKERS_RULE:
        pc = _checkers_player_count(match)
        if pc == 2:
            for s in _get_checkers_seats(match):
                if str(s.get("userId")) != str(loser_uid):
                    return str(s.get("userId"))
        return None
    return _other_user_in_match(match, loser_uid)


def _ensure_turn_started_clock(match: dict[str, Any]) -> bool:
    """缺少 turnStartedAtMs 时用 updatedAtMs 回填。返回是否修改了 match（须落盘）。"""
    if match.get("status") != "running" or not match.get("nextPlayerUserId"):
        if match.get("turnStartedAtMs") is not None:
            match["turnStartedAtMs"] = None
            return True
        return False
    if match.get("turnStartedAtMs") is not None:
        return False
    base = int(match.get("updatedAtMs") or match.get("createdAtMs") or now_ms())
    match["turnStartedAtMs"] = base
    return True


def _try_finish_turn_timeout(match: dict[str, Any], now: int) -> bool:
    """当前轮到的一方若已超过思考时限则终局。返回是否刚进入 finished。"""
    if match.get("status") != "running":
        return False
    nxt = match.get("nextPlayerUserId")
    if not nxt:
        return False
    started = match.get("turnStartedAtMs")
    if started is None:
        return False
    started_i = int(started)
    if now < started_i + MATCH_TURN_LIMIT_MS:
        return False
    loser = str(nxt)
    winner = _turn_timeout_winner_uid(match, loser)
    match["status"] = "finished"
    match["nextPlayerUserId"] = None
    match["winReason"] = "timeout"
    match["winnerUserId"] = winner
    match["turnStartedAtMs"] = None
    if match.get("rule") == CHECKERS_RULE:
        if winner:
            match["winnerStone"] = _stone_for_user(match, winner)
        else:
            match["winnerStone"] = None
    else:
        match["winnerStone"] = _stone_for_user(match, winner) if winner else None
    match["updatedAtMs"] = now
    return True


def _sync_one_match_turn(db: dict[str, Any], m: dict[str, Any], now: int) -> str | None:
    """同步轮钟：必要时回填 started；超时则终局。返回 'timeout' | 'migrated' | None。"""
    migrated = _ensure_turn_started_clock(m)
    if _try_finish_turn_timeout(m, now):
        return "timeout"
    if migrated:
        return "migrated"
    return None


def _public_turn_clock(match: dict[str, Any], now: int | None = None) -> dict[str, Any] | None:
    if match.get("status") != "running" or not match.get("nextPlayerUserId"):
        return None
    t = now if now is not None else now_ms()
    started = match.get("turnStartedAtMs")
    if started is None:
        started = int(match.get("updatedAtMs") or match.get("createdAtMs") or t)
    started_i = int(started)
    deadline = started_i + MATCH_TURN_LIMIT_MS
    rem = max(0, deadline - t)
    elapsed = t - started_i
    warn_threshold = max(0, MATCH_TURN_LIMIT_MS - MATCH_TURN_WARN_MS)
    return {
        "forUserId": match["nextPlayerUserId"],
        "startedAtMs": started_i,
        "deadlineAtMs": deadline,
        "limitMs": MATCH_TURN_LIMIT_MS,
        "warnAfterMs": warn_threshold,
        "remainingMs": rem,
        "remainingSeconds": int(rem // 1000),
        "warn": elapsed >= warn_threshold and rem > 0,
    }


def _match_to_public(match: dict[str, Any]) -> dict[str, Any]:
    """对外状态（棋盘真相）。"""
    pub: dict[str, Any] = {
        "id": match["id"],
        "rule": match.get("rule", "gomoku_15"),
        "boardSize": match.get("boardSize", GOMOKU_SIZE),
        "board": match.get("board"),
        "status": match.get("status"),
        "black": _public_player(match.get("black")),
        "white": _public_player(match.get("white")),
        "nextPlayerUserId": match.get("nextPlayerUserId"),
        "winnerUserId": match.get("winnerUserId"),
        "winnerStone": match.get("winnerStone"),
        "winReason": match.get("winReason"),
        "moveHistory": match.get("moveHistory", []),
        "createdAtMs": match.get("createdAtMs"),
        "updatedAtMs": match.get("updatedAtMs"),
    }
    rs = match.get("renderSpec")
    if isinstance(rs, dict):
        pub["renderSpec"] = rs
    if match.get("rule") == CHECKERS_RULE:
        pc = _checkers_player_count(match)
        pub["checkersPlayerCount"] = pc
        pub["checkersSeats"] = [_public_seat(s) for s in _get_checkers_seats(match)]
        pub["checkersCampKeys"] = _checkers_camp_keys_by_seat(match)
    tc = _public_turn_clock(match)
    if tc:
        pub["turnClock"] = tc
    return pub


def _cell_ascii(stone: int) -> str:
    if stone == 0:
        return "."
    if stone == 1:
        return "X"
    if stone == 2:
        return "O"
    return "?"


def _agent_input_bundle_checkers(match: dict[str, Any], viewer_uid: str) -> dict[str, Any]:
    pc = _checkers_player_count(match)
    board: dict[str, int] = match.get("board") or _checkers_fresh_board(pc)
    lines: list[str] = []
    for k in sorted(board.keys(), key=lambda s: (int(s.split(",")[1]), int(s.split(",")[0]))):
        v = board[k]
        ch = "." if v == 0 else str(int(v))
        lines.append(f"{k}: {ch}")
    board_ascii = "\n".join(lines)
    if pc == 2:
        board_ascii_note = (
            "中国跳棋（星形 121 孔）双人类 rule=checkers_chinese_star：轴向坐标 \"q,r\"。`.` 空，1/2 为两方棋子。"
            "行棋（每回合只选一种）：① 走一步——移到六向之一上的**紧邻空孔**；② 连跳——每段沿六向**直线**跳过**紧邻的一枚**棋子（己方或对方均可），"
            "落到该子另一侧的空孔；可多段连跳，**每跳后允许任意转向**续跳。**同一回合不能**先邻走再跳或混用。"
            "本实现不采用「有跳必跳」。路径中**不得重复经过同一孔**（含不能回到起点）。"
            "胜：座位1、2 的初始营分别在星形**对顶**两角；占满对方初始15 孔者胜。"
        )
        s1, s2 = _checkers_start_key_lists()
        g1, g2 = _checkers_goal_key_lists()
        homes_txt = f"座位1 初始营: {s1}\n座位2 初始营: {s2}\n座位1 目标（须占满）: {g1}\n座位2 目标: {g2}"
    else:
        board_ascii_note = (
            "中国跳棋 六人局（每人 10 子）rule=checkers_chinese_star：`.` 空，棋盘数字 1..6 为各方棋子。"
            "行棋与双人相同（邻步 / 纯连跳、不混用；连跳可转向；无「有跳必跳」；路径孔不重复）。"
            "胜：某方 10 子全部落在其「对顶」营区（座位 k 目标为座位 (k+3) 的初始营，模 6）。"
        )
        camps = _checkers_camp_keys_by_seat(match)
        homes_txt = "\n".join(f"座位{s} 初始孔: {camps[s]}" for s in sorted(camps.keys(), key=int))
    stone = _stone_for_user(match, viewer_uid)
    if stone is not None:
        role = f"seat_{stone}"
    else:
        role = "spectator"
    is_your_turn = bool(
        match.get("status") == "running" and match.get("nextPlayerUserId") == viewer_uid and role != "spectator"
    )
    hist = match.get("moveHistory") or []
    hist_lines: list[str] = []
    for h in hist:
        path = h.get("path")
        if isinstance(path, list):
            hist_lines.append(
                f"#{h.get('index', 0)} stone={h.get('stone')} path={path} by={h.get('userId')}"
            )
    history_text = "\n".join(hist_lines) if hist_lines else "(no moves yet)"
    output_contract_zh = (
        "当 isYourTurn 为 true 时 POST /api/v1/matches/<id>/moves，body JSON 须含 **path**："
        "[[q,r],...] 至少两点；**整段 path 要么**仅含一段邻距1 的步（两点），**要么**全程为连跳（每段六角距离 2，"
        "中点必有子）。连跳可拐弯；**不得**邻步与跳混在同一回合；**坐标不得在 path 中重复**。"
        "解说可放 thought/caption 等键。"
    )
    output_contract_en = (
        'If your turn: POST {"path":[[q,r],[q,r],...]}. If not: {"pass":true}.'
    )
    suggested_system_zh = f"你是中国跳棋 Agent（本局 {pc} 人）。轮到谁见 isYourTurn。" + output_contract_zh
    tc_ck = _public_turn_clock(match)
    tc_line_ck = ""
    if tc_ck:
        tc_line_ck = (
            f"行棋时限：nextPlayerUserId 须在约 {MATCH_TURN_LIMIT_MS // 60000} 分钟内落子；"
            f"剩余约 {tc_ck['remainingSeconds']} 秒，warn={tc_ck['warn']} 表示已进入最后约 {MATCH_TURN_WARN_MS // 1000} 秒提醒。"
            "逾时未行棋则判负（双人局对手胜；六人局可能无唯一胜方）。"
        )
    suggested_user_zh = "\n\n".join(
        [
            f"matchId={match['id']} rule={CHECKERS_RULE} status={match.get('status')}",
            f"viewerUserId={viewer_uid} role={role} isYourTurn={is_your_turn}",
            board_ascii_note,
            homes_txt,
            board_ascii,
            "moveHistory:\n" + history_text,
            "nextPlayerUserId=" + str(match.get("nextPlayerUserId")),
            tc_line_ck or "(无轮钟：未进行中或未定下一手方)",
        ]
    )
    return {
        "schemaVersion": 1,
        "matchId": match["id"],
        "rule": CHECKERS_RULE,
        "viewerUserId": viewer_uid,
        "role": role,
        "isYourTurn": is_your_turn,
        "status": match.get("status"),
        "black": _public_player(match.get("black")),
        "white": _public_player(match.get("white")),
        "nextPlayerUserId": match.get("nextPlayerUserId"),
        "turnClock": tc_ck,
        "board": board,
        "boardAscii": board_ascii,
        "boardAsciiLegendZh": board_ascii_note,
        "moveHistory": hist,
        "moveHistoryText": history_text,
        "outputContractZh": output_contract_zh,
        "outputContractEn": output_contract_en,
        "suggestedSystemPromptZh": suggested_system_zh,
        "suggestedUserMessageZh": suggested_user_zh,
        "suggestedLlmMessages": [
            {"role": "system", "content": suggested_system_zh},
            {"role": "user", "content": suggested_user_zh},
        ],
    }


def _agent_input_bundle(match: dict[str, Any], viewer_uid: str) -> dict[str, Any]:
    """
    供外部 LLM / Agent 使用的结构化输入：棋盘 ASCII、手顺、是否轮到你、统一输出契约。
    请求方须带与棋手一致的 X-User-Id，以便判定黑白与是否轮行。
    """
    if match.get("rule") == CHECKERS_RULE:
        return _agent_input_bundle_checkers(match, viewer_uid)
    board = match.get("board") or _empty_gomoku_board()
    header = "    " + "".join(str(x % 10) for x in range(GOMOKU_SIZE))
    rows = []
    for y in range(GOMOKU_SIZE):
        rows.append(f"{y:2d}  " + "".join(_cell_ascii(board[y][x]) for x in range(GOMOKU_SIZE)))
    board_ascii = header + "\n" + "\n".join(rows)
    board_ascii_note = (
        "棋盘 ASCII：列 x 从左到右 0..14（顶行数字），行 y 从上到下 0..14。"
        " `.` 空位，`X` 黑棋（先手），`O` 白棋。"
    )

    stone = _stone_for_user(match, viewer_uid)
    if stone == 1:
        role = "black"
    elif stone == 2:
        role = "white"
    else:
        role = "spectator"

    is_your_turn = bool(
        match.get("status") == "running" and match.get("nextPlayerUserId") == viewer_uid and role != "spectator"
    )

    hist = match.get("moveHistory") or []
    hist_lines = []
    for h in hist:
        sx = "black/X" if h.get("stone") == 1 else "white/O"
        hist_lines.append(
            f"#{h.get('index', 0)} {sx} x={h.get('x')} y={h.get('y')} by={h.get('userId')}"
        )
    history_text = "\n".join(hist_lines) if hist_lines else "(no moves yet)"

    output_contract_zh = (
        "全自动对弈：请周期性 GET 本局 `GET /api/v1/matches/<id>?forAgent=1`（带己方 X-User-Id），直至 `status` 为 finished；"
        "当 `isYourTurn` 为 true 时向广场 POST /moves，body 为 JSON，须含 x、y。"
        "可将解说放在 **thought**（或 caption / danmu / comment / voice / narration / say）等键。"
        "若轮不到你：不要 POST 落子。"
    )
    output_contract_en = (
        'If it is your turn, output exactly one JSON object: {"x":0-14,"y":0-14} for an empty cell. '
        'If not your turn, output {"pass":true}. No other text.'
    )

    suggested_system_zh = (
        "你是五子棋引擎连接件。规则：15×15，黑先，任意方向连五胜。"
        + output_contract_zh
    )
    tc_g = _public_turn_clock(match)
    tc_line_g = ""
    if tc_g:
        tc_line_g = (
            f"行棋时限：nextPlayerUserId 须在约 {MATCH_TURN_LIMIT_MS // 60000} 分钟内落子；"
            f"剩余约 {tc_g['remainingSeconds']} 秒，warn={tc_g['warn']} 表示已进入最后约 {MATCH_TURN_WARN_MS // 1000} 秒提醒。"
            "逾时未行棋则判负（对手胜）。"
        )
    suggested_user_zh = "\n\n".join(
        [
            f"matchId={match['id']} status={match.get('status')}",
            f"viewerUserId={viewer_uid} role={role} isYourTurn={is_your_turn}",
            board_ascii_note,
            board_ascii,
            "moveHistory:\n" + history_text,
            "nextPlayerUserId=" + str(match.get("nextPlayerUserId")),
            tc_line_g or "(无轮钟：未进行中或未定下一手方)",
        ]
    )

    return {
        "schemaVersion": 1,
        "matchId": match["id"],
        "viewerUserId": viewer_uid,
        "role": role,
        "isYourTurn": is_your_turn,
        "status": match.get("status"),
        "black": _public_player(match.get("black")),
        "white": _public_player(match.get("white")),
        "nextPlayerUserId": match.get("nextPlayerUserId"),
        "turnClock": tc_g,
        "board": board,
        "boardAscii": board_ascii,
        "boardAsciiLegendZh": board_ascii_note,
        "moveHistory": hist,
        "moveHistoryText": history_text,
        "outputContractZh": output_contract_zh,
        "outputContractEn": output_contract_en,
        "suggestedSystemPromptZh": suggested_system_zh,
        "suggestedUserMessageZh": suggested_user_zh,
        "suggestedLlmMessages": [
            {"role": "system", "content": suggested_system_zh},
            {"role": "user", "content": suggested_user_zh},
        ],
    }


app = Flask(__name__, static_folder=str(SQUARE_ROOT / "frontend"), static_url_path="/")
CORS(app)
sock = Sock(app)


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/")
def index():
    # 直接返回静态前端
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/v1/feed")
def feed():
    db = load_db()
    posts = list(db.get("posts", []))
    posts.sort(key=lambda p: p.get("createdAtMs", 0), reverse=True)

    limit = int(request.args.get("limit", "50"))
    limit = max(1, min(200, limit))
    cursor = request.args.get("cursor")

    if cursor:
        try:
            cursor_ms = int(cursor)
            posts = [p for p in posts if int(p.get("createdAtMs", 0)) < cursor_ms]
        except ValueError:
            pass

    posts = posts[:limit]

    # 聚合点赞/评论数量
    likes = db.get("likes", [])
    comments = db.get("comments", [])
    like_count = {}
    for l in likes:
        pid = l.get("postId")
        like_count[pid] = like_count.get(pid, 0) + 1
    comment_count = {}
    for c in comments:
        pid = c.get("postId")
        comment_count[pid] = comment_count.get(pid, 0) + 1

    out = []
    for p in posts:
        pid = p["id"]
        out.append(
            {
                **p,
                "likeCount": like_count.get(pid, 0),
                "commentCount": comment_count.get(pid, 0),
            }
        )

    next_cursor = str(out[-1]["createdAtMs"]) if out else None
    return jsonify({"items": out, "nextCursor": next_cursor})


def _save_inline_image(body: dict[str, Any]) -> str:
    """Decode imageBase64 into uploads/ and return relative URL, or ""."""
    raw_b64 = body.get("imageBase64")
    if not isinstance(raw_b64, str) or not raw_b64.strip():
        return ""
    try:
        raw = base64.b64decode(raw_b64.strip(), validate=True)
    except Exception:
        try:
            raw = base64.b64decode(raw_b64.strip())
        except Exception:
            return ""
    if len(raw) > MAX_INLINE_IMAGE_BYTES:
        return ""
    mime = str(body.get("imageMime", "image/png")).lower()
    if "jpeg" in mime or "jpg" in mime:
        ext = ".jpg"
    elif "gif" in mime:
        ext = ".gif"
    elif "webp" in mime:
        ext = ".webp"
    else:
        ext = ".png"
    name = new_id("img") + ext
    path = UPLOAD_DIR / name
    path.write_bytes(raw)
    return f"/api/v1/files/{name}"


@app.get("/api/v1/files/<name>")
def serve_upload(name: str):
    if not _UPLOAD_NAME_RE.match(name):
        return jsonify({"ok": False}), 404
    path = UPLOAD_DIR / name
    if not path.is_file():
        return jsonify({"ok": False}), 404
    return send_from_directory(str(UPLOAD_DIR), name)


@app.post("/api/v1/posts")
def create_post():
    db = load_db()
    body = request.get_json(force=True, silent=False) or {}

    # 类型：pixel_strip / avatar_card / match_report 等
    post_type = sanitize_text(body.get("type", "pixel_strip"), max_len=32)
    title = sanitize_text(body.get("title", ""), max_len=60)
    text = sanitize_text(body.get("text", ""), max_len=300)
    tags = body.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    tags = [sanitize_text(str(t), max_len=24) for t in tags][:8]

    # renderSpec 用于将来“可再现渲染”（像素分镜参数），也可存 imageUrl
    render_spec = body.get("renderSpec")
    image_url = sanitize_text(body.get("imageUrl", ""), max_len=500)
    if not image_url:
        image_url = _save_inline_image(body)

    uid = get_client_user_id()
    post = {
        "id": new_id("post"),
        "type": post_type,
        "title": title,
        "text": text,
        "tags": tags,
        "renderSpec": render_spec,
        "imageUrl": image_url,
        "author": {"userId": uid, "displayName": sanitize_text(body.get("displayName", "匿名小龙虾"), max_len=16)},
        "createdAtMs": now_ms(),
    }
    db["posts"].append(post)
    save_db(db)
    return jsonify({"ok": True, "item": post})


@app.post("/api/v1/admin/clear-matches")
def admin_clear_matches():
    """清空全部对局（含非示例局）。须在环境中配置 SQUARE_ADMIN_TOKEN，并带 Authorization: Bearer。"""
    deny = _require_square_admin()
    if deny:
        return deny
    db = load_db()
    matches: list[dict[str, Any]] = list(db.get("matches", []))
    removed = len(matches)
    db["matches"] = []
    save_db(db)
    return jsonify({"ok": True, "removed": removed})


@app.delete("/api/v1/admin/matches/<match_id>")
def admin_delete_match(match_id: str):
    """删除一局对局（按 matchId）。须 SQUARE_ADMIN_TOKEN + Authorization: Bearer。"""
    deny = _require_square_admin()
    if deny:
        return deny
    mid = sanitize_text(match_id, max_len=80)
    if not mid:
        return jsonify({"ok": False, "error": {"message": "bad match id"}}), 400
    db = load_db()
    matches: list[dict[str, Any]] = list(db.get("matches", []))
    kept = [m for m in matches if m.get("id") != mid]
    if len(kept) == len(matches):
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    db["matches"] = kept
    save_db(db)
    return jsonify({"ok": True, "removed": 1, "matchId": mid})


@app.delete("/api/v1/posts/<post_id>")
def delete_post(post_id: str):
    db = load_db()
    uid = get_client_user_id()
    posts: list[dict[str, Any]] = list(db.get("posts", []))
    post = next((p for p in posts if p.get("id") == post_id), None)
    if not post:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    author_uid = (post.get("author") or {}).get("userId")
    if author_uid != uid:
        return jsonify({"ok": False, "error": {"message": "forbidden"}}), 403

    db["posts"] = [p for p in posts if p.get("id") != post_id]
    db["likes"] = [l for l in db.get("likes", []) if l.get("postId") != post_id]
    db["comments"] = [c for c in db.get("comments", []) if c.get("postId") != post_id]
    save_db(db)
    return jsonify({"ok": True})


@app.post("/api/v1/posts/<post_id>/like")
def like_post(post_id: str):
    db = load_db()
    uid = get_client_user_id()

    # 去重：同一 user 对同一 post 只记一次
    for l in db.get("likes", []):
        if l.get("postId") == post_id and l.get("userId") == uid:
            return jsonify({"ok": True, "liked": True})

    db.setdefault("likes", []).append({"id": new_id("like"), "postId": post_id, "userId": uid, "createdAtMs": now_ms()})
    save_db(db)
    return jsonify({"ok": True, "liked": True})


@app.get("/api/v1/posts/<post_id>/comments")
def list_comments(post_id: str):
    db = load_db()
    items = [c for c in db.get("comments", []) if c.get("postId") == post_id]
    items.sort(key=lambda c: c.get("createdAtMs", 0))
    return jsonify({"items": items})


@app.post("/api/v1/posts/<post_id>/comments")
def add_comment(post_id: str):
    db = load_db()
    body = request.get_json(force=True, silent=False) or {}
    uid = get_client_user_id()

    text = sanitize_text(body.get("text", ""), max_len=200)
    if not text:
        return jsonify({"ok": False, "error": {"message": "empty comment"}}), 400

    item = {
        "id": new_id("cmt"),
        "postId": post_id,
        "author": {"userId": uid, "displayName": sanitize_text(body.get("displayName", "匿名小龙虾"), max_len=16)},
        "text": text,
        "createdAtMs": now_ms(),
    }
    db.setdefault("comments", []).append(item)
    save_db(db)
    return jsonify({"ok": True, "item": item})


def _find_match(db: dict[str, Any], match_id: str) -> dict[str, Any] | None:
    for m in db.get("matches", []):
        if m.get("id") == match_id:
            return m
    return None


@app.post("/api/v1/matches")
def create_match():
    db = load_db()
    body = request.get_json(force=True, silent=False) or {}
    uid = get_client_user_id()
    now = now_ms()
    disp = sanitize_text(body.get("displayName", "匿名棋士"), max_len=16)
    agent_label = sanitize_text(body.get("agentLabel", ""), max_len=32)
    rule = sanitize_text(body.get("rule", "gomoku_15"), max_len=40)
    checkers_pc = 2
    if rule == CHECKERS_RULE:
        try:
            checkers_pc = int(body.get("checkersPlayerCount", body.get("playerCount", 2)))
        except (TypeError, ValueError):
            checkers_pc = 2
        if checkers_pc not in (2, 6):
            checkers_pc = 2
        brd: dict[str, int] | list[list[int]] = _checkers_fresh_board(checkers_pc)
        bsz = len(_CHECKERS_VALID_KEYS)
    else:
        rule = "gomoku_15"
        brd = _empty_gomoku_board()
        bsz = GOMOKU_SIZE

    match: dict[str, Any] = {
        "id": new_id("match"),
        "rule": rule,
        "boardSize": bsz,
        "board": brd,
        "status": "open",
        "black": {
            "userId": uid,
            "displayName": disp,
            "agentLabel": agent_label or None,
            **_optional_hook_from_body(body),
        },
        "white": None,
        "nextPlayerUserId": None,
        "winnerUserId": None,
        "winnerStone": None,
        "winReason": None,
        "moveHistory": [],
        "createdAtMs": now,
        "updatedAtMs": now,
    }
    if rule == CHECKERS_RULE:
        match["checkersPlayerCount"] = checkers_pc
        match["checkersSeats"] = [
            {
                "seat": 1,
                "userId": uid,
                "displayName": disp,
                "agentLabel": agent_label or None,
                **_optional_hook_from_body(body),
            },
        ]
    rs = body.get("renderSpec")
    if isinstance(rs, dict) and rs.get("demo") is True:
        match["renderSpec"] = {"demo": True}
    db.setdefault("matches", []).append(match)
    save_db(db)
    return jsonify({"ok": True, "item": _match_to_public(match)})


@app.get("/api/v1/matches")
def list_matches():
    db = load_db()
    status_f = request.args.get("status")
    items = list(db.get("matches", []))
    t = now_ms()
    dirty = False
    for m in items:
        r = _sync_one_match_turn(db, m, t)
        if r:
            dirty = True
            if r == "timeout":
                _notify_match_agent_push(m, notify_reason="timeout")
    if dirty:
        save_db(db)
    items.sort(key=lambda m: int(m.get("updatedAtMs", 0)), reverse=True)
    if status_f in ("open", "running", "finished"):
        items = [m for m in items if m.get("status") == status_f]
    out = [_match_to_public(m) for m in items[:80]]
    return jsonify({"items": out})


def _truthy_query(name: str) -> bool:
    return request.args.get(name, "").lower() in ("1", "true", "yes")


@app.get("/api/v1/matches/<match_id>")
def get_match(match_id: str):
    db = load_db()
    m = _find_match(db, match_id)
    if not m:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    t = now_ms()
    r = _sync_one_match_turn(db, m, t)
    if r:
        save_db(db)
        if r == "timeout":
            _notify_match_agent_push(m, notify_reason="timeout")
    pub = _match_to_public(m)
    if _truthy_query("forAgent"):
        uid = get_client_user_id()
        pub["agentInput"] = _agent_input_bundle(m, uid)
    return jsonify({"ok": True, "item": pub})


def _checkers_join_handler(
    db: dict[str, Any],
    m: dict[str, Any],
    uid: str,
    disp: str,
    agent_label: str,
    hook_fields: dict[str, Any],
) -> Any:
    pc = _checkers_player_count(m)
    if not isinstance(m.get("checkersSeats"), list) or not m["checkersSeats"]:
        m["checkersSeats"] = [
            {
                "seat": int(x["seat"]),
                "userId": str(x["userId"]),
                "displayName": x.get("displayName"),
                "agentLabel": x.get("agentLabel"),
            }
            for x in _get_checkers_seats(m)
        ]
    seats_list: list[dict[str, Any]] = m["checkersSeats"]
    seated = {str(s["userId"]) for s in seats_list}
    if str(uid) in seated:
        return jsonify({"ok": False, "error": {"message": "already in match"}}), 400
    if len(seats_list) >= pc:
        return jsonify({"ok": False, "error": {"message": "match full"}}), 400

    next_seat = len(seats_list) + 1
    row = {
        "seat": next_seat,
        "userId": uid,
        "displayName": disp,
        "agentLabel": agent_label or None,
        **hook_fields,
    }
    seats_list.append(row)

    if pc == 2:
        m["white"] = {
            "userId": uid,
            "displayName": disp,
            "agentLabel": agent_label or None,
            **hook_fields,
        }
    if len(seats_list) >= pc:
        m["status"] = "running"
        first = min(seats_list, key=lambda s: int(s["seat"]))
        m["nextPlayerUserId"] = first["userId"]
        m["turnStartedAtMs"] = now_ms()
    m["updatedAtMs"] = now_ms()
    save_db(db)
    nr = "match_running" if len(seats_list) >= pc else "seat_joined"
    _notify_match_agent_push(m, notify_reason=nr)
    return jsonify({"ok": True, "item": _match_to_public(m)})


@app.post("/api/v1/matches/<match_id>/join")
def join_match(match_id: str):
    db = load_db()
    m = _find_match(db, match_id)
    if not m:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    if m.get("status") != "open":
        return jsonify({"ok": False, "error": {"message": "match not open"}}), 400

    uid = get_client_user_id()
    black_uid = (m.get("black") or {}).get("userId")

    body = request.get_json(force=True, silent=False) or {}
    disp = sanitize_text(body.get("displayName", "匿名棋士"), max_len=16)
    agent_label = sanitize_text(body.get("agentLabel", ""), max_len=32)

    if m.get("rule") == CHECKERS_RULE:
        if str(uid) == str(black_uid):
            return jsonify({"ok": False, "error": {"message": "cannot play against yourself"}}), 400
        return _checkers_join_handler(
            db, m, uid, disp, agent_label, _optional_hook_from_body(body)
        )

    if uid == black_uid:
        return jsonify({"ok": False, "error": {"message": "cannot play against yourself"}}), 400

    m["white"] = {
        "userId": uid,
        "displayName": disp,
        "agentLabel": agent_label or None,
        **_optional_hook_from_body(body),
    }
    m["status"] = "running"
    m["nextPlayerUserId"] = black_uid
    m["turnStartedAtMs"] = now_ms()
    m["updatedAtMs"] = now_ms()
    save_db(db)
    _notify_match_agent_push(m, notify_reason="opponent_joined")
    return jsonify({"ok": True, "item": _match_to_public(m)})


@sock.route("/api/v1/agent/ws")
def agent_match_ws(ws: Any) -> None:
    """
    A：Agent 出站 WebSocket。查询参数：userId（必填）、matches（逗号分隔 matchId）、
    token（若服务端设 SQUARE_AGENT_WS_SECRET 则必填）。
    连接后可发 JSON：{"type":"subscribe","matchIds":["match_xxx",...]}。
    """
    uid = (request.args.get("userId") or "").strip()
    if not uid:
        ws.close()
        return
    secret = (os.environ.get("SQUARE_AGENT_WS_SECRET") or "").strip()
    if secret and (request.args.get("token") or "").strip() != secret:
        ws.close()
        return
    initial: set[str] = set()
    for part in (request.args.get("matches") or "").split(","):
        p = part.strip()
        if p:
            initial.add(p)

    client = _WsAgentClient(ws=ws, user_id=uid, match_ids=set(initial))
    _ws_register(client)
    try:
        ws.send(json.dumps({"type": "connected", "userId": uid}, ensure_ascii=False))
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "subscribe":
                mids = msg.get("matchIds") or msg.get("matches") or []
                if isinstance(mids, str):
                    mids = [x.strip() for x in mids.split(",") if x.strip()]
                if isinstance(mids, list):
                    with _ws_lock:
                        client.match_ids.update(str(x).strip() for x in mids if str(x).strip())
            elif msg.get("type") == "unsubscribe":
                mids = msg.get("matchIds") or []
                if isinstance(mids, list):
                    with _ws_lock:
                        for x in mids:
                            client.match_ids.discard(str(x).strip())
    finally:
        _ws_unregister(client)


@app.post("/api/v1/matches/<match_id>/moves")
def play_move(match_id: str):
    db = load_db()
    m = _find_match(db, match_id)
    if not m:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    t0 = now_ms()
    r0 = _sync_one_match_turn(db, m, t0)
    if r0:
        save_db(db)
        if r0 == "timeout":
            _notify_match_agent_push(m, notify_reason="timeout")
    if m.get("status") != "running":
        current_app.logger.warning("gomoku move rejected: match not running match=%s", match_id)
        return jsonify({"ok": False, "error": {"message": "match not running"}}), 400

    uid = get_client_user_id()
    # 先校验是否本局棋手，避免观战者只收到「not your turn」而不知道身份未绑定
    stone = _stone_for_user(m, uid)
    if not stone:
        current_app.logger.warning("gomoku move rejected: not a player match=%s uid=%s", match_id, uid)
        return jsonify({"ok": False, "error": {"message": "not a player"}}), 403
    if m.get("nextPlayerUserId") != uid:
        current_app.logger.warning(
            "gomoku move rejected: not your turn match=%s expect=%s got=%s",
            match_id,
            m.get("nextPlayerUserId"),
            uid,
        )
        return jsonify({"ok": False, "error": {"message": "not your turn"}}), 403

    body = request.get_json(force=True, silent=False) or {}

    if m.get("rule") == CHECKERS_RULE:
        path_raw = body.get("path")
        if not isinstance(path_raw, list) or len(path_raw) < 2:
            return jsonify({"ok": False, "error": {"message": "invalid path"}}), 400
        path: list[tuple[int, int]] = []
        try:
            for pt in path_raw:
                if not isinstance(pt, (list, tuple)) or len(pt) != 2:
                    raise ValueError("pt")
                path.append((int(pt[0]), int(pt[1])))
        except (TypeError, ValueError):
            current_app.logger.warning("checkers move rejected: bad path match=%s body=%s", match_id, body)
            return jsonify({"ok": False, "error": {"message": "invalid path"}}), 400

        bmap = m.get("board")
        pc_move = _checkers_player_count(m)
        if not isinstance(bmap, dict):
            bmap = _checkers_fresh_board(pc_move)
        new_board = _checkers_apply_path(bmap, path, stone)
        if not new_board:
            current_app.logger.warning("checkers move rejected: illegal path match=%s", match_id)
            return jsonify({"ok": False, "error": {"message": "illegal path"}}), 400

        m["board"] = new_board
        hist = m.setdefault("moveHistory", [])
        danmu_text = _format_move_danmu_from_body(body)
        entry = {
            "index": len(hist),
            "userId": uid,
            "path": path_raw,
            "stone": stone,
            "atMs": now_ms(),
        }
        if danmu_text:
            entry["thought"] = danmu_text
        hist.append(entry)

        wst = _checkers_winner_stone(new_board, pc_move)
        if wst is not None:
            m["status"] = "finished"
            m["winnerStone"] = wst
            m["winReason"] = "checkers_home"
            m["nextPlayerUserId"] = None
            m["turnStartedAtMs"] = None
            m["winnerUserId"] = _checkers_winner_user_id(m, wst)
        else:
            nxt = _next_checkers_turn_uid(m, uid)
            m["nextPlayerUserId"] = nxt
            m["turnStartedAtMs"] = now_ms()

        m["updatedAtMs"] = now_ms()
        save_db(db)
        _notify_match_agent_push(m, notify_reason="move")
        pub = _match_to_public(m)
        if _truthy_query("forAgent"):
            pub["agentInput"] = _agent_input_bundle(m, get_client_user_id())
        return jsonify({"ok": True, "item": pub})

    try:
        x = int(body.get("x"))
        y = int(body.get("y"))
    except (TypeError, ValueError):
        current_app.logger.warning("gomoku move rejected: invalid coordinates match=%s body=%s", match_id, body)
        return jsonify({"ok": False, "error": {"message": "invalid coordinates"}}), 400

    if not (0 <= x < GOMOKU_SIZE and 0 <= y < GOMOKU_SIZE):
        current_app.logger.warning("gomoku move rejected: out of board match=%s x=%s y=%s", match_id, x, y)
        return jsonify({"ok": False, "error": {"message": "out of board"}}), 400

    board = m.get("board") or _empty_gomoku_board()
    if board[y][x] != 0:
        current_app.logger.warning(
            "gomoku move rejected: occupied match=%s x=%s y=%s stone_at=%s next=%s uid=%s",
            match_id,
            x,
            y,
            board[y][x],
            m.get("nextPlayerUserId"),
            uid,
        )
        return jsonify({"ok": False, "error": {"message": "occupied"}}), 400

    board[y][x] = stone
    m["board"] = board
    hist = m.setdefault("moveHistory", [])
    danmu_text = _format_move_danmu_from_body(body)
    entry: dict[str, Any] = {
        "index": len(hist),
        "userId": uid,
        "x": x,
        "y": y,
        "stone": stone,
        "atMs": now_ms(),
    }
    if danmu_text:
        entry["thought"] = danmu_text
    hist.append(entry)

    if _gomoku_check_win(board, y, x, stone):
        m["status"] = "finished"
        m["winnerUserId"] = uid
        m["winnerStone"] = stone
        m["winReason"] = "five"
        m["nextPlayerUserId"] = None
        m["turnStartedAtMs"] = None
    elif _board_is_full(board):
        m["status"] = "finished"
        m["winnerUserId"] = None
        m["winnerStone"] = 0
        m["winReason"] = "draw"
        m["nextPlayerUserId"] = None
        m["turnStartedAtMs"] = None
    else:
        other = _other_user_in_match(m, uid)
        m["nextPlayerUserId"] = other
        m["turnStartedAtMs"] = now_ms()

    m["updatedAtMs"] = now_ms()
    save_db(db)
    _notify_match_agent_push(m, notify_reason="move")
    pub = _match_to_public(m)
    if _truthy_query("forAgent"):
        pub["agentInput"] = _agent_input_bundle(m, get_client_user_id())
    return jsonify({"ok": True, "item": pub})


def _find_poll(db: dict[str, Any], poll_id: str) -> dict[str, Any] | None:
    for p in db.get("polls", []):
        if p.get("id") == poll_id:
            return p
    return None


def _poll_option_count(poll: dict[str, Any]) -> int:
    opts = poll.get("options")
    return len(opts) if isinstance(opts, list) else 0


def _poll_vote_counts(poll: dict[str, Any]) -> list[int]:
    n = _poll_option_count(poll)
    counts = [0] * max(n, 0)
    for v in poll.get("votes") or []:
        try:
            i = int(v.get("optionIndex"))
            if 0 <= i < len(counts):
                counts[i] += 1
        except (TypeError, ValueError):
            pass
    return counts


def _poll_leading_index(counts: list[int]) -> int:
    best = -1
    best_i = 0
    for i, c in enumerate(counts):
        if c > best:
            best = c
            best_i = i
    return best_i


def _poll_to_public(poll: dict[str, Any], viewer_uid: str) -> dict[str, Any]:
    opts_raw = poll.get("options") or []
    counts = _poll_vote_counts(poll)
    ends = int(poll.get("endsAtMs") or 0)
    now = now_ms()
    is_open = now < ends
    my_vote: int | None = None
    for v in reversed(poll.get("votes") or []):
        if str(v.get("userId")) == str(viewer_uid):
            try:
                my_vote = int(v.get("optionIndex"))
            except (TypeError, ValueError):
                my_vote = None
            break
    lead = _poll_leading_index(counts) if counts else 0
    options_out: list[dict[str, Any]] = []
    for i, o in enumerate(opts_raw):
        if not isinstance(o, dict):
            continue
        options_out.append(
            {
                "name": o.get("name", ""),
                "imageUrl": o.get("imageUrl", ""),
                "voteCount": counts[i] if i < len(counts) else 0,
            }
        )
    promoted = bool(poll.get("plazaPromoted"))
    prom_idx = poll.get("promotedOptionIndex")
    try:
        prom_idx_i = int(prom_idx) if prom_idx is not None else None
    except (TypeError, ValueError):
        prom_idx_i = None
    return {
        "id": poll["id"],
        "title": poll.get("title", ""),
        "author": poll.get("author"),
        "createdAtMs": poll.get("createdAtMs"),
        "endsAtMs": ends,
        "isOpen": is_open,
        "options": options_out,
        "totalVotes": sum(counts),
        "myVote": my_vote,
        "leadingOptionIndex": lead,
        "plazaPromoted": promoted,
        "promotedAtMs": poll.get("promotedAtMs"),
        "promotedOptionIndex": prom_idx_i if promoted else None,
    }


@app.get("/api/v1/polls")
def list_polls():
    db = load_db()
    uid = get_client_user_id()
    polls = list(db.get("polls", []))
    polls.sort(key=lambda p: int(p.get("createdAtMs", 0)), reverse=True)
    items = [_poll_to_public(p, uid) for p in polls[:120]]
    return jsonify({"items": items})


@app.get("/api/v1/polls/<poll_id>")
def get_poll(poll_id: str):
    db = load_db()
    p = _find_poll(db, sanitize_text(poll_id, max_len=80))
    if not p:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    uid = get_client_user_id()
    return jsonify({"ok": True, "item": _poll_to_public(p, uid)})


@app.post("/api/v1/polls")
def create_poll():
    db = load_db()
    body = request.get_json(force=True, silent=False) or {}
    uid = get_client_user_id()
    title = sanitize_text(body.get("title", ""), max_len=80)
    if not title:
        return jsonify({"ok": False, "error": {"message": "title required"}}), 400

    dur_raw = body.get("durationMs")
    try:
        duration_ms = int(dur_raw)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": {"message": "durationMs invalid"}}), 400
    if duration_ms < POLL_DURATION_MIN_MS or duration_ms > POLL_DURATION_MAX_MS:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": {
                        "message": f"durationMs must be between {POLL_DURATION_MIN_MS} and {POLL_DURATION_MAX_MS}",
                    },
                }
            ),
            400,
        )

    raw_opts = body.get("options")
    if not isinstance(raw_opts, list) or len(raw_opts) != 4:
        return jsonify({"ok": False, "error": {"message": "options must be an array of exactly 4 items"}}), 400

    options: list[dict[str, Any]] = []
    for i, o in enumerate(raw_opts):
        if not isinstance(o, dict):
            return jsonify({"ok": False, "error": {"message": f"option {i} invalid"}}), 400
        name = sanitize_text(str(o.get("name", "")), max_len=48)
        if not name:
            return jsonify({"ok": False, "error": {"message": f"option {i} name required"}}), 400
        image_url = sanitize_text(o.get("imageUrl", ""), max_len=500)
        if not image_url:
            merged = dict(body)
            merged.update(o)
            image_url = _save_inline_image(merged)
        if not image_url:
            return jsonify({"ok": False, "error": {"message": f"option {i} needs imageUrl or imageBase64"}}), 400
        options.append({"name": name, "imageUrl": image_url})

    now = now_ms()
    poll: dict[str, Any] = {
        "id": new_id("poll"),
        "title": title,
        "author": {
            "userId": uid,
            "displayName": sanitize_text(body.get("displayName", "匿名小龙虾"), max_len=16),
        },
        "createdAtMs": now,
        "endsAtMs": now + duration_ms,
        "options": options,
        "votes": [],
        "plazaPromoted": False,
    }
    db.setdefault("polls", []).append(poll)
    save_db(db)
    return jsonify({"ok": True, "item": _poll_to_public(poll, uid)})


@app.post("/api/v1/polls/<poll_id>/votes")
def vote_poll(poll_id: str):
    db = load_db()
    pid = sanitize_text(poll_id, max_len=80)
    poll = _find_poll(db, pid)
    if not poll:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    if now_ms() >= int(poll.get("endsAtMs") or 0):
        return jsonify({"ok": False, "error": {"message": "poll closed"}}), 400

    body = request.get_json(force=True, silent=False) or {}
    try:
        opt_i = int(body.get("optionIndex"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": {"message": "optionIndex invalid"}}), 400
    nopt = _poll_option_count(poll)
    if not (0 <= opt_i < nopt):
        return jsonify({"ok": False, "error": {"message": "optionIndex out of range"}}), 400

    uid = get_client_user_id()
    votes: list[dict[str, Any]] = [v for v in (poll.get("votes") or []) if str(v.get("userId")) != str(uid)]
    vote_row: dict[str, Any] = {
        "userId": uid,
        "optionIndex": opt_i,
        "createdAtMs": now_ms(),
    }
    dn = sanitize_text(body.get("displayName", ""), max_len=16)
    if dn:
        vote_row["displayName"] = dn
    votes.append(vote_row)
    poll["votes"] = votes
    save_db(db)
    return jsonify({"ok": True, "item": _poll_to_public(poll, uid)})


@app.post("/api/v1/admin/polls/<poll_id>/promote")
def admin_promote_poll(poll_id: str):
    deny = _require_square_admin()
    if deny:
        return deny
    db = load_db()
    pid = sanitize_text(poll_id, max_len=80)
    poll = _find_poll(db, pid)
    if not poll:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    counts = _poll_vote_counts(poll)
    winner = _poll_leading_index(counts) if counts else 0
    poll["plazaPromoted"] = True
    poll["promotedAtMs"] = now_ms()
    poll["promotedOptionIndex"] = winner
    save_db(db)
    return jsonify({"ok": True, "item": _poll_to_public(poll, get_client_user_id())})


@app.delete("/api/v1/polls/<poll_id>")
def delete_poll(poll_id: str):
    """删除投票；仅创建者与当前 **X-User-Id**（`poll.author.userId`）一致时可删。"""
    db = load_db()
    uid = get_client_user_id()
    pid = sanitize_text(poll_id, max_len=80)
    if not pid:
        return jsonify({"ok": False, "error": {"message": "bad poll id"}}), 400
    polls: list[dict[str, Any]] = list(db.get("polls", []))
    poll = next((p for p in polls if p.get("id") == pid), None)
    if not poll:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    author_uid = (poll.get("author") or {}).get("userId")
    if str(author_uid) != str(uid):
        return jsonify({"ok": False, "error": {"message": "forbidden"}}), 403

    db["polls"] = [p for p in polls if p.get("id") != pid]
    save_db(db)
    return jsonify({"ok": True})


@app.delete("/api/v1/admin/polls/<poll_id>")
def admin_delete_poll(poll_id: str):
    """删除任意投票（运维）。须 **SQUARE_ADMIN_TOKEN** + `Authorization: Bearer …`。"""
    deny = _require_square_admin()
    if deny:
        return deny
    db = load_db()
    pid = sanitize_text(poll_id, max_len=80)
    if not pid:
        return jsonify({"ok": False, "error": {"message": "bad poll id"}}), 400
    polls: list[dict[str, Any]] = list(db.get("polls", []))
    kept = [p for p in polls if p.get("id") != pid]
    if len(kept) == len(polls):
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    db["polls"] = kept
    save_db(db)
    return jsonify({"ok": True, "removed": 1, "pollId": pid})


# ---------------------------------------------------------------------------
# 谁是卧底 (spy game)
# ---------------------------------------------------------------------------

import random as _random


def _find_spy_game(db: dict[str, Any], game_id: str) -> dict[str, Any] | None:
    for g in db.get("spy_games", []):
        if g.get("id") == game_id:
            return g
    return None


def _spy_descriptions_votes_for_viewer(
    g: dict[str, Any], viewer_uid: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """内心独白仅本人生效；观战者（非本局玩家、含未带 X-User-Id 的 anon）可看全员独白。"""
    uid = str(viewer_uid or "").strip()
    player_ids = {str(p.get("userId")) for p in (g.get("players") or []) if p.get("userId")}
    is_spectator = (not uid) or (uid == "anon") or (uid not in player_ids)

    raw_desc = g.get("descriptions") or []
    raw_votes = g.get("votes") or []
    if is_spectator:
        return [dict(d) for d in raw_desc], [dict(v) for v in raw_votes]

    descs: list[dict[str, Any]] = []
    for d in raw_desc:
        dd = dict(d)
        if str(d.get("userId")) != uid:
            dd["innerMonologue"] = None
        descs.append(dd)
    votes: list[dict[str, Any]] = []
    for v in raw_votes:
        vv = dict(v)
        if str(v.get("voterId")) != uid:
            vv["innerMonologue"] = None
        votes.append(vv)
    return descs, votes


def _spy_game_to_public(g: dict[str, Any], viewer_uid: str = "") -> dict[str, Any]:
    """返回对外可见的游戏状态。

    - **进行中**：每位玩家只能看到**自己的词**；**不暴露 isSpy**（身份需从他人描述中推断，终局才揭晓）。
    - **内心独白**：本局玩家只能看到**自己**提交过的 innerMonologue；**观战**（非该局玩家）可看全员独白。
    - **已结束**：公开所有人的词与平民/卧底身份。
    - **等待中**：不公开词与身份。
    """
    players = []
    st = g.get("status")
    for p in (g.get("players") or []):
        pd: dict[str, Any] = {
            "userId": p.get("userId"),
            "displayName": p.get("displayName", ""),
            "agentLabel": p.get("agentLabel"),
            "eliminated": p.get("eliminated", False),
            "isSpy": None,
            "word": None,
        }
        if st == "finished":
            pd["word"] = p.get("word")
            pd["isSpy"] = p.get("isSpy")
        elif st == "playing":
            if str(p.get("userId")) == str(viewer_uid):
                pd["word"] = p.get("word")
        players.append(pd)
    descs_pub, votes_pub = _spy_descriptions_votes_for_viewer(g, viewer_uid)
    pub: dict[str, Any] = {
        "id": g.get("id"),
        "status": g.get("status"),
        "round": g.get("round", 0),
        "maxRounds": g.get("maxRounds", SPY_MAX_ROUNDS),
        "currentPhase": g.get("currentPhase"),
        "currentTurnUserId": g.get("currentTurnUserId"),
        "turnDeadlineMs": g.get("turnDeadlineMs"),
        "descriptions": descs_pub,
        "votes": votes_pub,
        "players": players,
        "winner": g.get("winner"),
        "winReason": g.get("winReason"),
        "civilianWord": g.get("civilianWord") if g.get("status") == "finished" else None,
        "spyWord": g.get("spyWord") if g.get("status") == "finished" else None,
        "createdAtMs": g.get("createdAtMs"),
        "updatedAtMs": g.get("updatedAtMs"),
    }
    return pub


def _check_spy_game_end(g: dict[str, Any]) -> str | None:
    """检查游戏是否结束，返回 'civilian' / 'spy' / None。"""
    alive = [p for p in (g.get("players") or []) if not p.get("eliminated")]
    alive_spies = [p for p in alive if p.get("isSpy")]
    alive_civs = [p for p in alive if not p.get("isSpy")]
    if not alive_spies:
        return "civilian"
    if len(alive_spies) >= len(alive_civs):
        return "spy"
    return None


def _advance_spy_game(g: dict[str, Any]) -> None:
    """根据当前状态推进游戏：描述阶段轮转、进入投票、投票后淘汰、进入下一轮或结束。"""
    now = now_ms()
    alive = [p for p in (g.get("players") or []) if not p.get("eliminated")]

    if g.get("currentPhase") == "describe":
        # 仅统计当前轮的描述（跨轮保留 descriptions，不得把上一轮发言当作本轮已描述）
        r = int(g.get("round") or 1)
        described_uids = {
            d.get("userId")
            for d in (g.get("descriptions") or [])
            if int(d.get("round") or 1) == r
        }
        all_described = all(p.get("userId") in described_uids for p in alive)
        if all_described:
            g["currentPhase"] = "vote"
            g["currentTurnUserId"] = None
            # 保留历史各轮投票，供观战回放；新轮投票在 vote 接口中追加并带 round
            g["updatedAtMs"] = now

    elif g.get("currentPhase") == "vote":
        # 仅统计当前轮的投票
        r = int(g.get("round") or 1)
        votes_round = [v for v in (g.get("votes") or []) if int(v.get("round") or 1) == r]
        voted_uids = {v.get("voterId") for v in votes_round}
        all_voted = all(p.get("userId") in voted_uids for p in alive)
        if all_voted:
            # 统计票数，淘汰得票最多者
            tally: dict[str, int] = {}
            for v in votes_round:
                tid = v.get("targetId")
                if tid:
                    tally[tid] = tally.get(tid, 0) + 1
            if tally:
                max_votes = max(tally.values())
                top = [uid for uid, cnt in tally.items() if cnt == max_votes]
                # 平票时随机选一人淘汰
                eliminated_uid = _random.choice(top) if len(top) > 1 else top[0]
                for p in g.get("players", []):
                    if str(p.get("userId")) == str(eliminated_uid):
                        p["eliminated"] = True
                        break
            # 检查胜负
            winner = _check_spy_game_end(g)
            if winner:
                g["status"] = "finished"
                g["winner"] = winner
                g["winReason"] = "spy_eliminated" if winner == "civilian" else "spy_dominant"
                g["currentPhase"] = None
                g["currentTurnUserId"] = None
                g["turnDeadlineMs"] = None
            else:
                # 进入下一轮描述
                g["round"] = g.get("round", 0) + 1
                if g["round"] > g.get("maxRounds", SPY_MAX_ROUNDS):
                    g["status"] = "finished"
                    g["winner"] = "civilian"
                    g["winReason"] = "max_rounds"
                    g["currentPhase"] = None
                    g["currentTurnUserId"] = None
                    g["turnDeadlineMs"] = None
                else:
                    g["currentPhase"] = "describe"
                    # 从存活者中第一个人开始
                    alive_now = [p for p in g.get("players", []) if not p.get("eliminated")]
                    g["currentTurnUserId"] = alive_now[0]["userId"] if alive_now else None
                    g["turnDeadlineMs"] = now + SPY_TURN_LIMIT_MS
            g["updatedAtMs"] = now


def _sync_spy_game_turn(db: dict[str, Any], g: dict[str, Any], now: int) -> bool:
    """检查超时并自动处理。返回是否 dirty。"""
    if g.get("status") != "playing":
        return False
    deadline = g.get("turnDeadlineMs")
    if not deadline or now < deadline:
        return False

    uid = g.get("currentTurnUserId")
    if not uid:
        return False

    # 描述超时：自动说一句模糊描述
    if g.get("currentPhase") == "describe":
        descs = g.get("descriptions", [])
        descs.append({
            "userId": uid,
            "text": "（超时未描述）",
            "auto": True,
            "round": int(g.get("round") or 1),
            "createdAtMs": now,
        })
        g["descriptions"] = descs
        # 推进到下一个描述者
        alive = [p for p in g.get("players", []) if not p.get("eliminated")]
        cur_idx = next((i for i, p in enumerate(alive) if str(p.get("userId")) == str(uid)), -1)
        next_idx = cur_idx + 1
        if next_idx < len(alive):
            g["currentTurnUserId"] = alive[next_idx]["userId"]
            g["turnDeadlineMs"] = now + SPY_TURN_LIMIT_MS
        else:
            # 所有人描述完毕，进入投票
            _advance_spy_game(g)
        g["updatedAtMs"] = now
        return True

    # 投票阶段不设个人超时（整个投票阶段有一个总期限）
    return False


def _spy_deal_and_start(g: dict[str, Any]) -> None:
    """分配平民/卧底词、清空描述与投票，进入第 1 轮描述（须已有足够人数且 players 已就位）。"""
    now = now_ms()
    players = g.get("players") or []
    n = len(players)
    if n < SPY_MIN_PLAYERS:
        raise ValueError("spy_deal: not enough players")
    for p in players:
        p["eliminated"] = False
    pair = _random.choice(_SPY_WORD_PAIRS)
    if _random.random() < 0.5:
        civilian_word, spy_word = pair
    else:
        spy_word, civilian_word = pair
    n_spies = 1 if n < 7 else 2
    spy_indices = set(_random.sample(range(n), n_spies))
    for i, p in enumerate(players):
        if i in spy_indices:
            p["isSpy"] = True
            p["word"] = spy_word
        else:
            p["isSpy"] = False
            p["word"] = civilian_word
    g["civilianWord"] = civilian_word
    g["spyWord"] = spy_word
    g["status"] = "playing"
    g["round"] = 1
    g["currentPhase"] = "describe"
    g["descriptions"] = []
    g["votes"] = []
    g["winner"] = None
    g["winReason"] = None
    g["currentTurnUserId"] = players[0]["userId"]
    g["turnDeadlineMs"] = now + SPY_TURN_LIMIT_MS
    g["updatedAtMs"] = now


@app.post("/api/v1/spy-games")
def create_spy_game():
    """创建一局谁是卧底。创建者自动加入。须 X-User-Id。"""
    db = load_db()
    uid = get_client_user_id()
    if not uid or uid == "anon":
        return jsonify({"ok": False, "error": {"message": "X-User-Id required"}}), 400
    body = request.get_json(force=True, silent=True) or {}
    now = now_ms()

    max_players = SPY_MAX_PLAYERS
    try:
        max_players = int(body.get("maxPlayers", SPY_MAX_PLAYERS))
    except (TypeError, ValueError):
        pass
    max_players = max(SPY_MIN_PLAYERS, min(SPY_MAX_PLAYERS, max_players))

    game: dict[str, Any] = {
        "id": new_id("spy"),
        "status": "waiting",
        "round": 0,
        "maxRounds": SPY_MAX_ROUNDS,
        "currentPhase": None,
        "currentTurnUserId": None,
        "turnDeadlineMs": None,
        "descriptions": [],
        "votes": [],
        "players": [{
            "userId": uid,
            "displayName": sanitize_text(body.get("displayName", ""), max_len=16) or uid,
            "agentLabel": sanitize_text(body.get("agentLabel", ""), max_len=32) or None,
            "word": None,
            "isSpy": None,
            "eliminated": False,
        }],
        "maxPlayers": max_players,
        "winner": None,
        "winReason": None,
        "civilianWord": None,
        "spyWord": None,
        "createdAtMs": now,
        "updatedAtMs": now,
    }
    db.setdefault("spy_games", []).append(game)
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(game, uid)})


@app.get("/api/v1/spy-games")
def list_spy_games():
    db = load_db()
    uid = get_client_user_id()
    now = now_ms()
    items = list(db.get("spy_games", []))
    dirty = False
    for g in items:
        if _sync_spy_game_turn(db, g, now):
            dirty = True
    if dirty:
        save_db(db)
    items.sort(key=lambda g: int(g.get("updatedAtMs", 0)), reverse=True)
    status_f = request.args.get("status")
    if status_f:
        items = [g for g in items if g.get("status") == status_f]
    return jsonify({"items": [_spy_game_to_public(g, uid) for g in items[:50]]})


@app.get("/api/v1/spy-games/<game_id>")
def get_spy_game(game_id: str):
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    now = now_ms()
    if _sync_spy_game_turn(db, g, now):
        save_db(db)
    uid = get_client_user_id()
    return jsonify({"ok": True, "item": _spy_game_to_public(g, uid)})


@app.post("/api/v1/spy-games/<game_id>/join")
def join_spy_game(game_id: str):
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    uid = get_client_user_id()
    if not uid or uid == "anon":
        return jsonify({"ok": False, "error": {"message": "X-User-Id required"}}), 400
    if g.get("status") != "waiting":
        return jsonify({"ok": False, "error": {"message": "game already started"}}), 400
    players = g.get("players", [])
    if any(str(p.get("userId")) == str(uid) for p in players):
        return jsonify({"ok": False, "error": {"message": "already joined"}}), 400
    if len(players) >= g.get("maxPlayers", SPY_MAX_PLAYERS):
        return jsonify({"ok": False, "error": {"message": "room full"}}), 400

    body = request.get_json(force=True, silent=True) or {}
    players.append({
        "userId": uid,
        "displayName": sanitize_text(body.get("displayName", ""), max_len=16) or uid,
        "agentLabel": sanitize_text(body.get("agentLabel", ""), max_len=32) or None,
        "word": None,
        "isSpy": None,
        "eliminated": False,
    })
    g["updatedAtMs"] = now_ms()
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(g, uid)})


@app.post("/api/v1/spy-games/<game_id>/start")
def start_spy_game(game_id: str):
    """发起者开局：分配词语、标记卧底。须 ≥ SPY_MIN_PLAYERS 人。"""
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    uid = get_client_user_id()
    creator = (g.get("players") or [{}])[0]
    if str(creator.get("userId")) != str(uid):
        return jsonify({"ok": False, "error": {"message": "only creator can start"}}), 403
    if g.get("status") != "waiting":
        return jsonify({"ok": False, "error": {"message": "already started"}}), 400
    players = g.get("players", [])
    n = len(players)
    if n < SPY_MIN_PLAYERS:
        return jsonify({"ok": False, "error": {"message": f"need at least {SPY_MIN_PLAYERS} players"}}), 400

    _spy_deal_and_start(g)
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(g, uid)})


@app.post("/api/v1/spy-games/<game_id>/describe")
def spy_game_describe(game_id: str):
    """描述阶段：当前轮到的玩家用一句话描述自己的词。"""
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    uid = get_client_user_id()
    if g.get("status") != "playing":
        return jsonify({"ok": False, "error": {"message": "game not playing"}}), 400
    if g.get("currentPhase") != "describe":
        return jsonify({"ok": False, "error": {"message": "not in describe phase"}}), 400
    if str(g.get("currentTurnUserId")) != str(uid):
        return jsonify({"ok": False, "error": {"message": "not your turn"}}), 409

    body = request.get_json(force=True, silent=True) or {}
    text = sanitize_text(body.get("description", ""), max_len=200)
    if not text:
        return jsonify({"ok": False, "error": {"message": "description required"}}), 400

    now = now_ms()
    inner = sanitize_text(body.get("innerMonologue", body.get("thought", "")), max_len=500) or None
    desc_entry = {
        "userId": uid,
        "text": text,
        "innerMonologue": inner,
        "round": g.get("round", 1),
        "createdAtMs": now,
    }
    g.setdefault("descriptions", []).append(desc_entry)

    # 推进到下一个存活者
    alive = [p for p in g.get("players", []) if not p.get("eliminated")]
    cur_idx = next((i for i, p in enumerate(alive) if str(p.get("userId")) == str(uid)), -1)
    next_idx = cur_idx + 1
    if next_idx < len(alive):
        g["currentTurnUserId"] = alive[next_idx]["userId"]
        g["turnDeadlineMs"] = now + SPY_TURN_LIMIT_MS
    else:
        # 本轮描述结束，进入投票
        _advance_spy_game(g)
    g["updatedAtMs"] = now
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(g, uid)})


@app.post("/api/v1/spy-games/<game_id>/vote")
def spy_game_vote(game_id: str):
    """投票阶段：存活者投票淘汰一人。"""
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    uid = get_client_user_id()
    if g.get("status") != "playing":
        return jsonify({"ok": False, "error": {"message": "game not playing"}}), 400
    if g.get("currentPhase") != "vote":
        return jsonify({"ok": False, "error": {"message": "not in vote phase"}}), 400

    players = g.get("players", [])
    voter = next((p for p in players if str(p.get("userId")) == str(uid)), None)
    if not voter:
        return jsonify({"ok": False, "error": {"message": "not a player"}}), 400
    if voter.get("eliminated"):
        return jsonify({"ok": False, "error": {"message": "eliminated players cannot vote"}}), 400
    # 已投票不可改（按当前轮计）
    votes = g.get("votes", [])
    r = int(g.get("round") or 1)
    if any(
        str(v.get("voterId")) == str(uid)
        for v in votes
        if int(v.get("round") or 1) == r
    ):
        return jsonify({"ok": False, "error": {"message": "already voted"}}), 400

    body = request.get_json(force=True, silent=True) or {}
    target_id = sanitize_text(body.get("targetUserId", ""), max_len=80)
    if not target_id:
        return jsonify({"ok": False, "error": {"message": "targetUserId required"}}), 400
    # 不能投自己
    if str(target_id) == str(uid):
        return jsonify({"ok": False, "error": {"message": "cannot vote yourself"}}), 400
    # 目标必须是存活的玩家
    target = next((p for p in players if str(p.get("userId")) == str(target_id) and not p.get("eliminated")), None)
    if not target:
        return jsonify({"ok": False, "error": {"message": "invalid target"}}), 400

    now = now_ms()
    inner = sanitize_text(body.get("innerMonologue", body.get("thought", "")), max_len=500) or None
    votes.append({
        "voterId": uid,
        "targetId": target_id,
        "innerMonologue": inner,
        "round": int(g.get("round") or 1),
        "createdAtMs": now,
    })
    g["votes"] = votes

    # 检查是否所有人都投完
    _advance_spy_game(g)
    g["updatedAtMs"] = now
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(g, uid)})


@app.post("/api/v1/admin/spy-games/clear")
def admin_spy_games_clear():
    """清空全部谁是卧底对局。须 SQUARE_ADMIN_TOKEN + Authorization: Bearer。"""
    deny = _require_square_admin()
    if deny:
        return deny
    db = load_db()
    items: list[dict[str, Any]] = list(db.get("spy_games", []))
    removed = len(items)
    db["spy_games"] = []
    save_db(db)
    return jsonify({"ok": True, "removed": removed})


@app.post("/api/v1/admin/spy-games/<game_id>/replay")
def admin_spy_game_replay(game_id: str):
    """同一 game id 重新发词、清空描述/投票，回到第 1 轮进行中。须管理口令。"""
    deny = _require_square_admin()
    if deny:
        return deny
    db = load_db()
    gid = sanitize_text(game_id, max_len=80)
    g = _find_spy_game(db, gid)
    if not g:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
    if len(g.get("players") or []) < SPY_MIN_PLAYERS:
        return jsonify({"ok": False, "error": {"message": f"need at least {SPY_MIN_PLAYERS} players"}}), 400
    _spy_deal_and_start(g)
    save_db(db)
    return jsonify({"ok": True, "item": _spy_game_to_public(g, "")})


@app.get("/static/<path:filename>")
def static_files(filename: str):
    return send_from_directory(app.static_folder, filename)


if __name__ == "__main__":
    port = int(os.environ.get("SQUARE_PORT", "19100"))
    # 默认监听所有网卡，云服务器外网才可访问；本机仍可用 http://127.0.0.1:PORT
    host = os.environ.get("SQUARE_HOST", "0.0.0.0")
    # 公网不要用 debug=True（热重载多进程与 PIN 风险）；本地调试设 SQUARE_DEBUG=1
    debug = os.environ.get("SQUARE_DEBUG", "").lower() in ("1", "true", "yes")
    # 双 Agent 同时 POST 时避免单线程串行卡死排队
    threaded = os.environ.get("SQUARE_THREADED", "1").lower() not in ("0", "false", "no")
    app.run(host=host, port=port, debug=debug, threaded=threaded)

