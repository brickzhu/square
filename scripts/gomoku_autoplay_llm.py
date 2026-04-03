#!/usr/bin/env python3
"""
单进程全自动：两个固定 X-User-Id 轮流请求广场，轮到自己时用 OpenAI 兼容 Chat API 决定落子，直到终局。
用于「两个 IM Agent 不会自己循环」时的自动化验收；也可只起一个进程代替两边人工催步。

依赖：仅标准库（urllib）。

前置：广场已启动；若尚未建局，脚本可自动 create + join。

环境变量：
  SQUARE_BASE_URL   默认 http://127.0.0.1:19100
  USER_A            黑方 X-User-Id（须与 USER_B 不同）
  USER_B            白方
  OPENAI_API_KEY    必填（或同时设 OPENAI_BASE_URL 走中转）
  OPENAI_BASE_URL   默认 https://api.openai.com/v1
  OPENAI_MODEL      默认 gpt-4o-mini
  POLL_SEC          轮询间隔秒，默认 0.8
  MATCH_ID          若已开战可指定 match_…，否则自动创建+加入

示例：
  export USER_A=a111 USER_B=b222 OPENAI_API_KEY=sk-...
  export SQUARE_BASE_URL=http://127.0.0.1:19100
  python scripts/gomoku_autoplay_llm.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid


def _json_req(method: str, url: str, *, user_id: str, body: dict | None = None, timeout: float = 60) -> dict:
    payload = None
    headers = {"X-User-Id": user_id, "Content-Type": "application/json"}
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        try:
            j = json.loads(err) if err else {}
            msg = j.get("error", {}).get("message", err)
        except json.JSONDecodeError:
            msg = err or str(e)
        raise RuntimeError(f"HTTP {e.code}: {msg}") from e


def _chat_complete(base: str, key: str, model: str, messages: list[dict]) -> str:
    url = base.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 64,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"] or ""


def _parse_move(text: str) -> tuple[int, int]:
    text = text.strip()
    m = re.search(r"\{\s*\"x\"\s*:\s*(\d+)\s*,\s*\"y\"\s*:\s*(\d+)\s*\}", text)
    if not m:
        m = re.search(r"\{\s*\"y\"\s*:\s*(\d+)\s*,\s*\"x\"\s*:\s*(\d+)\s*\}", text)
        if m:
            y, x = int(m.group(1)), int(m.group(2))
            return x, y
        raise ValueError(f"no {{x,y}} in model output: {text[:200]}")
    return int(m.group(1)), int(m.group(2))


def main() -> int:
    base = os.environ.get("SQUARE_BASE_URL", "http://127.0.0.1:19100").rstrip("/")
    ua = os.environ.get("USER_A", "").strip() or f"agent_{uuid.uuid4().hex[:12]}"
    ub = os.environ.get("USER_B", "").strip() or f"agent_{uuid.uuid4().hex[:12]}"
    if ua == ub:
        print("USER_A and USER_B must differ", file=sys.stderr)
        return 1
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        print("OPENAI_API_KEY required", file=sys.stderr)
        return 1
    oa_base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    poll = float(os.environ.get("POLL_SEC", "0.8"))
    mid = os.environ.get("MATCH_ID", "").strip()

    if not mid:
        r = _json_req("POST", f"{base}/api/v1/matches", user_id=ua, body={"displayName": "Auto-A", "agentLabel": "llm-loop"})
        mid = r["item"]["id"]
        print(f"created {mid}")
        _json_req("POST", f"{base}/api/v1/matches/{mid}/join", user_id=ub, body={"displayName": "Auto-B", "agentLabel": "llm-loop"})
        print("joined, playing…")
    else:
        print(f"using existing match {mid}")

    step = 0
    while True:
        st0 = _json_req("GET", f"{base}/api/v1/matches/{mid}", user_id=ua)
        item0 = st0["item"]
        if item0["status"] == "finished":
            print(f"finished: {item0.get('winReason')} winner={item0.get('winnerUserId')}")
            print(f"view: {base}/gomoku.html?match={mid}")
            return 0

        played = False
        for uid, name in ((ua, "A/black"), (ub, "B/white")):
            st = _json_req("GET", f"{base}/api/v1/matches/{mid}?forAgent=1", user_id=uid)
            item = st["item"]
            if item["status"] == "finished":
                print(f"finished: {item.get('winReason')} winner={item.get('winnerUserId')}")
                print(f"view: {base}/gomoku.html?match={mid}")
                return 0
            ai = item.get("agentInput") or {}
            if not ai.get("isYourTurn"):
                continue
            msgs = ai.get("suggestedLlmMessages") or []
            if not msgs:
                print("missing suggestedLlmMessages", file=sys.stderr)
                return 1
            raw = _chat_complete(oa_base, key, model, msgs)
            x, y = _parse_move(raw)
            step += 1
            print(f"step {step} {name} model -> ({x},{y})")
            _json_req("POST", f"{base}/api/v1/matches/{mid}/moves", user_id=uid, body={"x": x, "y": y})
            played = True
            break

        if not played:
            time.sleep(poll)


if __name__ == "__main__":
    raise SystemExit(main())
