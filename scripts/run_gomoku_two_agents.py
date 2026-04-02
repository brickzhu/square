#!/usr/bin/env python3
"""
双「Agent」自弈演示：随机合法落子，直到分出胜负或和棋。
需先启动 Square：cd backend && python app.py

用法：
  python scripts/run_gomoku_two_agents.py
  SQUARE_BASE_URL=http://127.0.0.1:19100 python scripts/run_gomoku_two_agents.py

环境变量（可选）：
  SQUARE_BASE_URL   默认 http://127.0.0.1:19100
  USER_A / USER_B   两个棋手的 X-User-Id（默认随机 uuid）
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
import uuid


def _json_req(method: str, url: str, *, user_id: str, body: dict | None = None, timeout: float = 30) -> dict:
    data = None
    headers = {"X-User-Id": user_id, "Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
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


def pick_move(board: list[list[int]]) -> tuple[int, int]:
    empties = [(x, y) for y in range(15) for x in range(15) if board[y][x] == 0]
    if not empties:
        raise RuntimeError("board full")
    return random.choice(empties)


def main() -> int:
    base = os.environ.get("SQUARE_BASE_URL", "http://127.0.0.1:19100").rstrip("/")
    ua = os.environ.get("USER_A", "").strip() or f"agent_{uuid.uuid4().hex[:12]}"
    ub = os.environ.get("USER_B", "").strip() or f"agent_{uuid.uuid4().hex[:12]}"
    if ua == ub:
        print("USER_A and USER_B must differ", file=sys.stderr)
        return 1

    print(f"BASE={base}\nUSER_A (black)={ua}\nUSER_B (white)={ub}\n")

    r = _json_req("POST", f"{base}/api/v1/matches", user_id=ua, body={"displayName": "Agent-A", "agentLabel": "demo-a"})
    mid = r["item"]["id"]
    print(f"created match {mid}")
    _json_req(
        "POST",
        f"{base}/api/v1/matches/{mid}/join",
        user_id=ub,
        body={"displayName": "Agent-B", "agentLabel": "demo-b"},
    )
    print("joined, black moves first. playing…\n")

    step = 0
    while True:
        st = _json_req("GET", f"{base}/api/v1/matches/{mid}", user_id=ua)
        item = st["item"]
        if item["status"] == "finished":
            reason = item.get("winReason")
            w = item.get("winnerUserId")
            print(f"finished: reason={reason} winnerUserId={w}")
            print("last board rows (0=black 2=white):", json.dumps(item["board"], ensure_ascii=False)[:200], "…")
            break

        uid_turn = item["nextPlayerUserId"]
        board = item["board"]
        x, y = pick_move(board)
        step += 1
        who = "A(black)" if uid_turn == ua else "B(white)"
        print(f"step {step} {who} -> ({x},{y})")
        _json_req(
            "POST",
            f"{base}/api/v1/matches/{mid}/moves",
            user_id=uid_turn,
            body={"x": x, "y": y},
        )
        time.sleep(0.12)

    print(f"\nwatch in browser: {base}/gomoku.html?match={mid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
