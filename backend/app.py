#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flask import Flask, current_app, jsonify, request, send_from_directory
from flask_cors import CORS

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


def load_db() -> dict[str, Any]:
    defaults: dict[str, Any] = {"posts": [], "comments": [], "likes": [], "bans": [], "matches": []}
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


def _public_player(side: dict[str, Any] | None) -> dict[str, Any] | None:
    if not side:
        return side
    # 历史数据或旧字段中可能含 webhookUrl，对外永不返回
    return {k: v for k, v in side.items() if k != "webhookUrl"}


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
        if b_sim.get(ck, 0) != 0:
            return None
        dist = _hex_dist(a, c)
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
    if match.get("rule") == CHECKERS_RULE:
        pc = _checkers_player_count(match)
        pub["checkersPlayerCount"] = pc
        pub["checkersSeats"] = [
            {k: v for k, v in s.items() if v is not None} for s in _get_checkers_seats(match)
        ]
        pub["checkersCampKeys"] = _checkers_camp_keys_by_seat(match)
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
            "一步：走邻格；或沿六向直线连跳（跳过紧邻一子落空地，可连跳）。"
            "胜：双方初始营在星形「对顶」两角；1 方占满 2 方初始营胜，反之亦然。"
        )
        s1, s2 = _checkers_start_key_lists()
        g1, g2 = _checkers_goal_key_lists()
        homes_txt = f"座位1 初始营: {s1}\n座位2 初始营: {s2}\n座位1 目标（须占满）: {g1}\n座位2 目标: {g2}"
    else:
        board_ascii_note = (
            "中国跳棋 六人局（每人 10 子）rule=checkers_chinese_star：`.` 空，棋盘数字 1..6 为各方棋子。"
            "行棋与双人相同。胜：某方 10 子全部落在其「对顶」营区（与对方初始区分处相对的一组孔）。"
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
        "[[q,r],...] 至少两点；相邻为平移一格；或每一步为跨越一子的一跳，可同一回合连跳。"
        "解说可放 thought/caption 等键。"
    )
    output_contract_en = (
        'If your turn: POST {"path":[[q,r],[q,r],...]}. If not: {"pass":true}.'
    )
    suggested_system_zh = f"你是中国跳棋 Agent（本局 {pc} 人）。轮到谁见 isYourTurn。" + output_contract_zh
    suggested_user_zh = "\n\n".join(
        [
            f"matchId={match['id']} rule={CHECKERS_RULE} status={match.get('status')}",
            f"viewerUserId={viewer_uid} role={role} isYourTurn={is_your_turn}",
            board_ascii_note,
            homes_txt,
            board_ascii,
            "moveHistory:\n" + history_text,
            "nextPlayerUserId=" + str(match.get("nextPlayerUserId")),
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
    suggested_user_zh = "\n\n".join(
        [
            f"matchId={match['id']} status={match.get('status')}",
            f"viewerUserId={viewer_uid} role={role} isYourTurn={is_your_turn}",
            board_ascii_note,
            board_ascii,
            "moveHistory:\n" + history_text,
            "nextPlayerUserId=" + str(match.get("nextPlayerUserId")),
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


@app.post("/api/v1/demo")
def create_demo_posts():
    """
    生成一些示例帖子，方便第一次打开就有内容。
    """
    db = load_db()
    uid = get_client_user_id()
    now = now_ms()

    samples = [
        ("幼年自我 · 第 1 天", "我没有变厉害，我只是开始照顾自己了。", ["幼年自我", "开始"]),
        ("幼年自我 · 第 3 天", "我学会把难受说出来，而不是硬撑。", ["情绪", "表达"]),
        ("幼年自我 · 第 5 天", "今天只做了一点点，但这一点点很重要。", ["自律", "小步"]),
        ("幼年自我 · 第 7 天", "我愿意对自己温柔一点。", ["温柔", "成长"]),
        ("广场 · 小摊位", "把你的像素分镜 URL 粘贴到发布框里试试。", ["提示", "像素"]),
        ("练习 · 边界感", "我可以拒绝，但我依然是个好人。", ["边界", "自信"]),
        ("练习 · 微运动", "散步 10 分钟，世界没有变，但我轻了一点。", ["外形", "能量"]),
        ("练习 · 小确幸", "今天的光落在桌角，我突然很想活得慢一点。", ["小确幸", "情绪"]),
    ]

    created = []
    for i, (title, text, tags) in enumerate(samples):
        post = {
            "id": new_id("post"),
            "type": "pixel_strip",
            "title": title,
            "text": text,
            "tags": tags,
            "renderSpec": {"demo": True},
            "imageUrl": "",  # 先留空：避免外链图片不稳定
            "author": {"userId": uid, "displayName": "广场小猫"},
            "createdAtMs": now - i * 60000,
        }
        db["posts"].append(post)
        created.append(post)

    save_db(db)
    return jsonify({"ok": True, "count": len(created), "items": created})


def _is_demo_post(p: dict[str, Any]) -> bool:
    spec = p.get("renderSpec")
    return isinstance(spec, dict) and spec.get("demo") is True


@app.post("/api/v1/demo/clear")
def clear_demo_posts():
    """删除示例帖及其点赞、评论（renderSpec.demo）。"""
    db = load_db()
    posts: list[dict[str, Any]] = list(db.get("posts", []))
    demo_ids = {p["id"] for p in posts if _is_demo_post(p)}
    if not demo_ids:
        return jsonify({"ok": True, "removed": 0})

    db["posts"] = [p for p in posts if p["id"] not in demo_ids]
    db["likes"] = [l for l in db.get("likes", []) if l.get("postId") not in demo_ids]
    db["comments"] = [c for c in db.get("comments", []) if c.get("postId") not in demo_ids]
    save_db(db)
    return jsonify({"ok": True, "removed": len(demo_ids)})


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
            {"seat": 1, "userId": uid, "displayName": disp, "agentLabel": agent_label or None},
        ]
    db.setdefault("matches", []).append(match)
    save_db(db)
    return jsonify({"ok": True, "item": _match_to_public(match)})


@app.get("/api/v1/matches")
def list_matches():
    db = load_db()
    status_f = request.args.get("status")
    items = list(db.get("matches", []))
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
    }
    seats_list.append(row)

    if pc == 2:
        m["white"] = {
            "userId": uid,
            "displayName": disp,
            "agentLabel": agent_label or None,
        }
    if len(seats_list) >= pc:
        m["status"] = "running"
        first = min(seats_list, key=lambda s: int(s["seat"]))
        m["nextPlayerUserId"] = first["userId"]
    m["updatedAtMs"] = now_ms()
    save_db(db)
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
        return _checkers_join_handler(db, m, uid, disp, agent_label)

    if uid == black_uid:
        return jsonify({"ok": False, "error": {"message": "cannot play against yourself"}}), 400

    m["white"] = {
        "userId": uid,
        "displayName": disp,
        "agentLabel": agent_label or None,
    }
    m["status"] = "running"
    m["nextPlayerUserId"] = black_uid
    m["updatedAtMs"] = now_ms()
    save_db(db)
    return jsonify({"ok": True, "item": _match_to_public(m)})


@app.post("/api/v1/matches/<match_id>/moves")
def play_move(match_id: str):
    db = load_db()
    m = _find_match(db, match_id)
    if not m:
        return jsonify({"ok": False, "error": {"message": "not found"}}), 404
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
            m["winnerUserId"] = _checkers_winner_user_id(m, wst)
        else:
            nxt = _next_checkers_turn_uid(m, uid)
            m["nextPlayerUserId"] = nxt

        m["updatedAtMs"] = now_ms()
        save_db(db)
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
    elif _board_is_full(board):
        m["status"] = "finished"
        m["winnerUserId"] = None
        m["winnerStone"] = 0
        m["winReason"] = "draw"
        m["nextPlayerUserId"] = None
    else:
        other = _other_user_in_match(m, uid)
        m["nextPlayerUserId"] = other

    m["updatedAtMs"] = now_ms()
    save_db(db)
    pub = _match_to_public(m)
    if _truthy_query("forAgent"):
        pub["agentInput"] = _agent_input_bundle(m, get_client_user_id())
    return jsonify({"ok": True, "item": pub})


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

