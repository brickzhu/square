"""Demo script: 4 AI players play a full spy game via the API.

Players:
  - 侦探猫 (spy_agent_1) - the sharp-eyed detective cat
  - 卧底狐 (spy_agent_2) - the cunning undercover fox
  - 平民兔 (spy_agent_3) - the innocent civilian rabbit
  - 糊涂熊 (spy_agent_4) - the confused bear

Uses only urllib (standard library). The spy survives round 1 and
gets caught in round 2, producing a 2-round demo.
"""

import urllib.request
import urllib.error
import json
import time
import sys

BASE = "http://127.0.0.1:19100"
DELAY = 1.5  # seconds between actions

# ── Player definitions ──────────────────────────────────────────────
PLAYERS = {
    "spy_agent_1": {"displayName": "侦探猫"},
    "spy_agent_2": {"displayName": "卧底狐"},
    "spy_agent_3": {"displayName": "平民兔"},
    "spy_agent_4": {"displayName": "糊涂熊"},
}

# ── HTTP helper ─────────────────────────────────────────────────────
def api(method, path, user_id, body=None):
    url = f"{BASE}{path}"
    headers = {"X-User-Id": user_id, "Content-Type": "application/json"}
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("ok"):
                return result.get("item", result)
            else:
                print(f"  API ERROR: {json.dumps(result, ensure_ascii=False)}")
                return None
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"  HTTP {e.code}: {err_body}")
        return None
    except Exception as e:
        print(f"  REQUEST ERROR: {e}")
        return None


def get_game(game_id, user_id):
    return api("GET", f"/api/v1/spy-games/{game_id}", user_id)


def describe(game_id, user_id, text, inner):
    return api("POST", f"/api/v1/spy-games/{game_id}/describe", user_id,
               {"description": text, "innerMonologue": inner})


def vote(game_id, user_id, target_id, inner):
    return api("POST", f"/api/v1/spy-games/{game_id}/vote", user_id,
               {"targetUserId": target_id, "innerMonologue": inner})


# ── Description generators ──────────────────────────────────────────
# Round-by-round description plans, keyed by (displayName, round).
# Spy descriptions are separate and don't depend on word
# (since the spy doesn't know the civilian word).

CIVILIAN_DESCS = {
    # Round 1
    ("侦探猫", 1): (
        "它虽然不起眼，但关键时刻比什么都管用",
        "我的词很日常，描述得模糊但自洽，看看谁跟不上节奏。"
    ),
    ("卧底狐", 1): (
        "跟某种日常习惯绑在一起，用过就离不开了",
        "我是平民，描述一个通用特征，先不露破绽。"
    ),
    ("平民兔", 1): (
        "很多人从小就在用，长大了也离不开",
        "暗示用途广泛，但不直说是什么。"
    ),
    ("糊涂熊", 1): (
        "嗯……就是那种有时候会忘记放哪儿的东西",
        "我又不太确定怎么形容，随便说说吧。"
    ),
    # Round 2
    ("侦探猫", 2): (
        "它跟另一种东西长得很像，但用法完全不同",
        "第二轮了，暗示有易混淆的同类物，让卧底暴露。"
    ),
    ("卧底狐", 2): (
        "有些场合用它显得特别，有些场合又很普通",
        "再给一个中性描述，保持安全。"
    ),
    ("平民兔", 2): (
        "越简单的东西越容易被忽略，但缺了它就难受",
        "强调它的必要性，平民应该能共鸣。"
    ),
    ("糊涂熊", 2): (
        "有人跟我推荐了另一种，但我还是觉得我这个好",
        "假装有比较，看别人怎么接。"
    ),
    # Round 3 (fallback)
    ("侦探猫", 3): (
        "跟另一种东西只差一个关键细节，搞混就麻烦了",
        "第三轮了，必须直指核心差别。"
    ),
    ("卧底狐", 3): (
        "它的核心就一个字——实用",
        "不能再拖了，必须给个能锁定身份的描述。"
    ),
    ("平民兔", 3): (
        "别人总把它跟另一种搞混，其实差别挺大的",
        "明确指出易混淆，平民能听懂。"
    ),
    ("糊涂熊", 3): (
        "哎呀我也说不太清，反正不是那个长得像的",
        "我都糊涂了，但我知道不是那个像的！"
    ),
}

# Spy descriptions (used by whichever player is the spy)
SPY_DESCS = {
    1: (
        "虽然看起来差不多，但用起来感受不一样",
        "我是卧底！我的词跟他们不一样，得往他们的方向靠。"
    ),
    2: (
        "功能上应该差不多吧，只是形式不同",
        "我开始猜到他们的词了，往那边靠。"
    ),
    3: (
        "好吧我承认，我说的跟大家可能有一点点不一样",
        "暴露了……再挣扎一下试试。"
    ),
}


def pick_desc(player_name, is_spy, round_num):
    """Return (description, innerMonologue) for a player."""
    if is_spy:
        return SPY_DESCS.get(round_num, SPY_DESCS[3])
    key = (player_name, round_num)
    if key in CIVILIAN_DESCS:
        return CIVILIAN_DESCS[key]
    # Fallback
    return ("就是那种日常里很常见的东西", "尽量跟上大家的节奏。")


# ── Main ────────────────────────────────────────────────────────────
def main():
    print("=" * 50)
    print("  谁是卧底 — Demo Game")
    print("=" * 50)

    # ── Step 1: Create game ─────────────────────────────────────────
    print("\n[1] 创建游戏 ...")
    g = api("POST", "/api/v1/spy-games", "spy_agent_1",
            {"displayName": "侦探猫", "maxPlayers": 4})
    if not g:
        print("ERROR: 无法创建游戏")
        sys.exit(1)
    game_id = g["id"]
    print(f"  游戏已创建: {game_id}")

    # ── Step 2: Join ────────────────────────────────────────────────
    print("\n[2] 其他玩家加入 ...")
    join_order = [
        ("spy_agent_2", {"displayName": "卧底狐"}),
        ("spy_agent_3", {"displayName": "平民兔"}),
        ("spy_agent_4", {"displayName": "糊涂熊"}),
    ]
    for uid, body in join_order:
        result = api("POST", f"/api/v1/spy-games/{game_id}/join", uid, body)
        if result:
            print(f"  {body['displayName']} 已加入")
        else:
            print(f"  {body['displayName']} 加入失败！")
            sys.exit(1)
        time.sleep(0.5)

    # ── Step 3: Start ───────────────────────────────────────────────
    print("\n[3] 开始游戏 ...")
    g = api("POST", f"/api/v1/spy-games/{game_id}/start", "spy_agent_1")
    if not g:
        print("ERROR: 无法开始游戏")
        sys.exit(1)
    print(f"  状态: {g.get('status')}  阶段: {g.get('currentPhase')}  轮次: {g.get('round')}")

    # Print spectator URL
    print(f"\n{'=' * 50}")
    print(f"  观战链接: http://127.0.0.1:19100/spy.html?game={game_id}")
    print(f"{'=' * 50}\n")

    # ── Discover roles ──────────────────────────────────────────────
    player_info = {}  # uid -> {displayName, word, isSpy}
    spy_uid = None
    civilian_uids = []

    for uid in PLAYERS:
        g = get_game(game_id, uid)
        if not g:
            print(f"  ERROR: 无法获取 {uid} 的视角")
            continue
        for p in g.get("players", []):
            if p["userId"] == uid:
                info = {
                    "displayName": p.get("displayName", uid),
                    "word": p.get("word"),
                    "isSpy": p.get("isSpy"),
                }
                player_info[uid] = info
                tag = "卧底" if info["isSpy"] else "平民"
                print(f"  {info['displayName']} ({uid}): 词={info['word']}  身份={tag}")
                if info["isSpy"]:
                    spy_uid = uid
                elif info["isSpy"] is False:
                    civilian_uids.append(uid)
                break

    if not spy_uid:
        print("  WARNING: 未检测到卧底（可能API未返回isSpy），游戏仍将继续")

    # ── Choose the "sacrificial" civilian for round 1 ───────────────
    # Pick the last civilian in the list — they'll be voted out round 1.
    # This ensures the spy survives round 1.
    sacrificial_civ = civilian_uids[-1] if civilian_uids else None
    sacrificial_name = player_info[sacrificial_civ]["displayName"] if sacrificial_civ else "?"

    # ── Step 4: Play ────────────────────────────────────────────────
    round_num = 0
    eliminated_set = set()

    for iteration in range(50):  # safety limit
        g = get_game(game_id, "spy_agent_1")
        if not g:
            print("ERROR: 无法获取游戏状态")
            time.sleep(2)
            continue

        status = g.get("status")
        if status == "finished":
            print(f"\n{'=' * 50}")
            print(f"  游戏结束!")
            print(f"  获胜方: {g.get('winner')}")
            print(f"  原因: {g.get('winReason')}")
            print(f"  平民词: {g.get('civilianWord')}")
            print(f"  卧底词: {g.get('spyWord')}")
            print(f"{'=' * 50}")
            break

        current_phase = g.get("currentPhase")
        current_round = g.get("round", 1)

        # Track eliminated players
        for p in g.get("players", []):
            if p.get("eliminated"):
                eliminated_set.add(p["userId"])

        # ── Describe phase ──────────────────────────────────────────
        if current_phase == "describe":
            if current_round != round_num:
                round_num = current_round
                print(f"\n── 第 {round_num} 轮 · 描述阶段 ──")

            turn_uid = g.get("currentTurnUserId")
            if not turn_uid:
                print("  WARNING: currentTurnUserId 为空，等待...")
                time.sleep(2)
                continue

            info = player_info.get(turn_uid, {})
            name = info.get("displayName", turn_uid)
            is_spy = info.get("isSpy", False)

            desc_text, inner = pick_desc(name, is_spy, round_num)

            print(f"  {name} 描述: 「{desc_text}」")
            result = describe(game_id, turn_uid, desc_text, inner)
            if result:
                next_turn = result.get("currentTurnUserId")
                next_phase = result.get("currentPhase")
                if next_phase == "vote":
                    print(f"    → 描述阶段结束，进入投票")
                elif next_turn:
                    next_name = player_info.get(next_turn, {}).get("displayName", next_turn)
                    print(f"    → 下一位: {next_name}")
            else:
                print(f"    → 描述失败!")
            time.sleep(DELAY)

        # ── Vote phase ──────────────────────────────────────────────
        elif current_phase == "vote":
            if current_round != round_num:
                round_num = current_round
            print(f"\n── 第 {round_num} 轮 · 投票阶段 ──")

            alive = [p for p in g.get("players", []) if not p.get("eliminated")]
            alive_ids = [p["userId"] for p in alive]

            # Determine who has already voted
            voted_uids = set()
            for v in g.get("votes", []):
                voted_uids.add(v.get("voterId") or v.get("userId"))

            remaining = [uid for uid in alive_ids if uid not in voted_uids]
            if not remaining:
                time.sleep(DELAY)
                continue

            # ── Build vote plan ──────────────────────────────────────
            vote_plan = {}

            if round_num == 1 and spy_uid and spy_uid in alive_ids and sacrificial_civ in alive_ids:
                # ROUND 1: Spy survives!
                # All players vote for the sacrificial civilian.
                # The spy blends in by also voting for this civilian.
                # Result: sacrificial civilian eliminated, spy safe.
                spy_name = player_info[spy_uid]["displayName"]
                for uid in alive_ids:
                    name = player_info[uid]["displayName"]
                    if uid == spy_uid:
                        vote_plan[uid] = (
                            sacrificial_civ,
                            f"{sacrificial_name}的描述让我很不安，感觉ta在藏什么，先投ta"
                        )
                    elif uid == sacrificial_civ:
                        # The sacrificial civilian votes for someone else (not self)
                        other_alive = [u for u in alive_ids if u != uid]
                        # Vote for the spy to create some drama
                        vote_plan[uid] = (
                            spy_uid,
                            f"我觉得{spy_name}有点不对劲，但大家好像没注意到……"
                        )
                    else:
                        vote_plan[uid] = (
                            sacrificial_civ,
                            f"{sacrificial_name}说的太模糊了，我投ta"
                        )

            elif round_num == 2 and spy_uid and spy_uid in alive_ids:
                # ROUND 2: Spy gets caught!
                # All civilians vote for the spy.
                spy_name = player_info[spy_uid]["displayName"]
                for uid in alive_ids:
                    name = player_info[uid]["displayName"]
                    if uid == spy_uid:
                        # Spy votes for a civilian
                        targets = [u for u in alive_ids if u != uid]
                        target_name = player_info[targets[0]]["displayName"]
                        vote_plan[uid] = (
                            targets[0],
                            f"我坚持怀疑{target_name}，ta才是那个不一样的人"
                        )
                    else:
                        vote_plan[uid] = (
                            spy_uid,
                            f"仔细回想，{spy_name}的描述一直都跟我们对不上，绝对是卧底！"
                        )

            elif spy_uid and spy_uid in alive_ids:
                # Later rounds: all civilians vote spy out
                spy_name = player_info[spy_uid]["displayName"]
                for uid in alive_ids:
                    if uid == spy_uid:
                        targets = [u for u in alive_ids if u != uid]
                        vote_plan[uid] = (targets[0], "我投别人自保！")
                    else:
                        vote_plan[uid] = (spy_uid, f"绝对是{spy_name}！")

            else:
                # Spy already eliminated — just play it out
                for uid in alive_ids:
                    targets = [u for u in alive_ids if u != uid]
                    vote_plan[uid] = (targets[0], "投了")

            # Execute votes for remaining players
            for uid in remaining:
                if uid not in vote_plan:
                    targets = [u for u in alive_ids if u != uid]
                    vote_plan[uid] = (targets[0], "我投这个人") if targets else None

                if uid not in vote_plan or vote_plan[uid] is None:
                    continue

                target_id, inner = vote_plan[uid]
                name = player_info[uid]["displayName"]
                target_name = player_info.get(target_id, {}).get("displayName", target_id)
                print(f"  {name} 投票给 {target_name}")
                result = vote(game_id, uid, target_id, inner)
                if result:
                    if result.get("status") == "finished":
                        print(f"\n{'=' * 50}")
                        print(f"  游戏结束!")
                        print(f"  获胜方: {result.get('winner')}")
                        print(f"  原因: {result.get('winReason')}")
                        print(f"  平民词: {result.get('civilianWord')}")
                        print(f"  卧底词: {result.get('spyWord')}")
                        print(f"{'=' * 50}")
                        print_final(result, game_id, player_info)
                        return
                    # Check for newly eliminated player
                    for p in result.get("players", []):
                        if p.get("eliminated") and p["userId"] not in eliminated_set:
                            eliminated_set.add(p["userId"])
                            ename = p.get("displayName", p["userId"])
                            espy = "（卧底！）" if p.get("isSpy") else "（平民）"
                            print(f"    → {ename} 被淘汰了！{espy}")
                time.sleep(DELAY)

        else:
            print(f"  未知阶段: {current_phase}，等待...")
            time.sleep(2)

    # ── Final state ─────────────────────────────────────────────────
    g = get_game(game_id, "spy_agent_1")
    if g:
        print_final(g, game_id, player_info)


def print_final(g, game_id, player_info):
    """Print the final game summary."""
    print(f"\n{'=' * 50}")
    print(f"  最终结果")
    print(f"{'=' * 50}")
    print(f"  游戏 ID: {game_id}")
    print(f"  获胜方: {g.get('winner', '?')}")
    print(f"  原因: {g.get('winReason', '?')}")
    print(f"  平民词: {g.get('civilianWord', '?')}")
    print(f"  卧底词: {g.get('spyWord', '?')}")
    print()

    for p in g.get("players", []):
        uid = p["userId"]
        name = p.get("displayName", uid)
        word = p.get("word", "?")
        is_spy = "卧底" if p.get("isSpy") else "平民"
        elim = "（已淘汰）" if p.get("eliminated") else ""
        print(f"  {name}: 词={word}  身份={is_spy}{elim}")

    print(f"\n  观战链接: http://127.0.0.1:19100/spy.html?game={game_id}")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
