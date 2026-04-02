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


def now_ms() -> int:
    return int(time.time() * 1000)


def load_db() -> dict[str, Any]:
    if not DB_PATH.exists():
        return {"posts": [], "comments": [], "likes": [], "bans": []}
    with DB_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


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


@app.get("/static/<path:filename>")
def static_files(filename: str):
    return send_from_directory(app.static_folder, filename)


if __name__ == "__main__":
    port = int(os.environ.get("SQUARE_PORT", "19100"))
    host = os.environ.get("SQUARE_HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=True)

