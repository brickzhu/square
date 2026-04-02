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

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS


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


def _stone_for_user(match: dict[str, Any], uid: str) -> int | None:
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
    return {
        "id": match["id"],
        "rule": match.get("rule", "gomoku_15"),
        "boardSize": match.get("boardSize", GOMOKU_SIZE),
        "board": match.get("board"),
        "status": match.get("status"),
        "black": match.get("black"),
        "white": match.get("white"),
        "nextPlayerUserId": match.get("nextPlayerUserId"),
        "winnerUserId": match.get("winnerUserId"),
        "winnerStone": match.get("winnerStone"),
        "winReason": match.get("winReason"),
        "moveHistory": match.get("moveHistory", []),
        "createdAtMs": match.get("createdAtMs"),
        "updatedAtMs": match.get("updatedAtMs"),
    }


def _cell_ascii(stone: int) -> str:
    if stone == 0:
        return "."
    if stone == 1:
        return "X"
    if stone == 2:
        return "O"
    return "?"


def _agent_input_bundle(match: dict[str, Any], viewer_uid: str) -> dict[str, Any]:
    """
    供外部 LLM / Agent 使用的结构化输入：棋盘 ASCII、手顺、是否轮到你、统一输出契约。
    请求方须带与棋手一致的 X-User-Id，以便判定黑白与是否轮行。
    """
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
        "若「是否轮到你」为 true：只输出一行合法 JSON，不要 Markdown、不要解释。"
        '格式：{"x":<0-14整数>,"y":<0-14整数>}，且该格必须当前为空。'
        "若轮不到你：只输出 {\"pass\":true} 。"
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
        "black": match.get("black"),
        "white": match.get("white"),
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

    match = {
        "id": new_id("match"),
        "rule": "gomoku_15",
        "boardSize": GOMOKU_SIZE,
        "board": _empty_gomoku_board(),
        "status": "open",
        "black": {"userId": uid, "displayName": disp, "agentLabel": agent_label or None},
        "white": None,
        "nextPlayerUserId": None,
        "winnerUserId": None,
        "winnerStone": None,
        "winReason": None,
        "moveHistory": [],
        "createdAtMs": now,
        "updatedAtMs": now,
    }
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
    if uid == black_uid:
        return jsonify({"ok": False, "error": {"message": "cannot play against yourself"}}), 400

    body = request.get_json(force=True, silent=False) or {}
    disp = sanitize_text(body.get("displayName", "匿名棋士"), max_len=16)
    agent_label = sanitize_text(body.get("agentLabel", ""), max_len=32)

    m["white"] = {"userId": uid, "displayName": disp, "agentLabel": agent_label or None}
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
        return jsonify({"ok": False, "error": {"message": "match not running"}}), 400

    uid = get_client_user_id()
    if m.get("nextPlayerUserId") != uid:
        return jsonify({"ok": False, "error": {"message": "not your turn"}}), 403

    body = request.get_json(force=True, silent=False) or {}
    try:
        x = int(body.get("x"))
        y = int(body.get("y"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": {"message": "invalid coordinates"}}), 400

    if not (0 <= x < GOMOKU_SIZE and 0 <= y < GOMOKU_SIZE):
        return jsonify({"ok": False, "error": {"message": "out of board"}}), 400

    stone = _stone_for_user(m, uid)
    if not stone:
        return jsonify({"ok": False, "error": {"message": "not a player"}}), 403

    board = m.get("board") or _empty_gomoku_board()
    if board[y][x] != 0:
        return jsonify({"ok": False, "error": {"message": "occupied"}}), 400

    board[y][x] = stone
    m["board"] = board
    hist = m.setdefault("moveHistory", [])
    hist.append({"index": len(hist), "userId": uid, "x": x, "y": y, "stone": stone, "atMs": now_ms()})

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
    host = os.environ.get("SQUARE_HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=True)

