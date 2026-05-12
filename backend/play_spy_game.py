"""Script to create and play a full spy game via the API."""
import requests
import time
import json
import sys

BASE = "http://127.0.0.1:19100"
TIMEOUT = 10

def api(method, path, user_id, body=None):
    url = f"{BASE}{path}"
    headers = {"X-User-Id": user_id}
    try:
        if method == "GET":
            r = requests.get(url, headers=headers, timeout=TIMEOUT)
        elif method == "POST":
            r = requests.post(url, headers=headers, json=body, timeout=TIMEOUT)
        else:
            raise ValueError(f"Unknown method: {method}")
        data = r.json()
        if data.get("ok"):
            return data.get("item", data)
        else:
            print(f"  API ERROR: {json.dumps(data, ensure_ascii=False)}")
            return None
    except Exception as e:
        print(f"  REQUEST ERROR: {e}")
        return None

def wait_for_server():
    for i in range(30):
        try:
            r = requests.get(f"{BASE}/api/v1/spy-games", timeout=3)
            print("Server is ready!")
            return True
        except:
            time.sleep(1)
    print("Server not responding after 30s")
    return False

def get_game(game_id, user_id):
    return api("GET", f"/api/v1/spy-games/{game_id}", user_id)

def describe(game_id, user_id, text, inner):
    body = {"description": text, "innerMonologue": inner}
    return api("POST", f"/api/v1/spy-games/{game_id}/describe", user_id, body)

def vote(game_id, user_id, target_id, inner):
    body = {"targetUserId": target_id, "innerMonologue": inner}
    return api("POST", f"/api/v1/spy-games/{game_id}/vote", user_id, body)

def main():
    print("=== Waiting for server ===")
    if not wait_for_server():
        sys.exit(1)
    
    print("\n=== Creating game ===")
    g = api("POST", "/api/v1/spy-games", "spy_agent_1", {"displayName": "小虾米", "maxPlayers": 4})
    if not g:
        print("ERROR: Failed to create game")
        sys.exit(1)
    game_id = g["id"]
    print(f"  Game ID: {game_id}")
    
    print("\n=== Joining game ===")
    api("POST", f"/api/v1/spy-games/{game_id}/join", "spy_agent_2", {"displayName": "方脸人"})
    print("  spy_agent_2 joined")
    api("POST", f"/api/v1/spy-games/{game_id}/join", "spy_agent_3", {"displayName": "像素猫"})
    print("  spy_agent_3 joined")
    api("POST", f"/api/v1/spy-games/{game_id}/join", "spy_agent_4", {"displayName": "蟑螂哥"})
    print("  spy_agent_4 joined")
    
    print("\n=== Starting game ===")
    g = api("POST", f"/api/v1/spy-games/{game_id}/start", "spy_agent_1")
    if not g:
        print("ERROR: Failed to start game")
        sys.exit(1)
    print(f"  Status: {g.get('status')}, Phase: {g.get('currentPhase')}, Round: {g.get('round')}")
    
    print(f"\n=== GAME ID: {game_id} ===\n")
    
    # Get each player's word
    players = {
        "spy_agent_1": {"name": "小虾米"},
        "spy_agent_2": {"name": "方脸人"},
        "spy_agent_3": {"name": "像素猫"},
        "spy_agent_4": {"name": "蟑螂哥"},
    }
    
    spy_uid = None
    civilian_uids = []
    
    for uid in players:
        g = get_game(game_id, uid)
        if g:
            for p in g.get("players", []):
                if p["userId"] == uid and p.get("word"):
                    players[uid]["word"] = p["word"]
                    players[uid]["isSpy"] = p.get("isSpy", False)
            word = players[uid].get("word", "?")
            is_spy = players[uid].get("isSpy", "?")
            print(f"  {uid} ({players[uid]['name']}): word={word}, isSpy={is_spy}")
            if is_spy:
                spy_uid = uid
            elif is_spy == False:
                civilian_uids.append(uid)
    
    print(f"\n  SPY: {spy_uid} ({players[spy_uid]['name'] if spy_uid else '?'})")
    print(f"  CIVILIANS: {[f'{u} ({players[u]['name']})' for u in civilian_uids]}")
    
    # Play through rounds
    for round_iter in range(10):
        g = get_game(game_id, "spy_agent_1")
        if not g:
            print("ERROR: Cannot get game state")
            break
        
        status = g.get("status")
        if status == "finished":
            print(f"\n=== GAME OVER ===")
            print(f"  Winner: {g.get('winner')}")
            print(f"  Reason: {g.get('winReason')}")
            print(f"  Civilian word: {g.get('civilianWord')}")
            print(f"  Spy word: {g.get('spyWord')}")
            break
        
        current_phase = g.get("currentPhase")
        round_num = g.get("round", 1)
        print(f"\n=== Round {round_num}, Phase: {current_phase} ===")
        
        if current_phase == "describe":
            alive = [p for p in g.get("players", []) if not p.get("eliminated")]
            turn_order = [p["userId"] for p in alive]
            
            # Description plans by round
            if round_num == 1:
                desc_plan = {
                    "spy_agent_1": ("黑漆漆的时候特别需要它，一按就有光了", "我是平民，词是手电筒。描述得自然但不要太直白。"),
                    "spy_agent_2": ("出门露营经常带，小巧又实用", "我是平民，词是手电筒。要描述得模糊一些。"),
                    "spy_agent_3": ("不需要插电，靠自己就能亮起来", "我是平民，词是手电筒。说点特征但不直接说名字。"),
                    "spy_agent_4": ("晚上看书的时候会用，光线很集中", "我是卧底，词是台灯。要往手电筒靠拢，不能暴露。"),
                }
            elif round_num == 2:
                desc_plan = {
                    "spy_agent_1": ("有时候手机也能替代它，但它更专业", "第二轮，给平民同伴更多线索。"),
                    "spy_agent_2": ("买电池就能一直用，比充电方便", "换个角度描述手电筒。"),
                    "spy_agent_3": ("停电的时候它是救星，比蜡烛安全多了", "蟑螂哥的描述像台灯，我再描述手电筒确认身份。"),
                    "spy_agent_4": ("放床头很方便，随手就能开关", "他们都说电池和停电，我得往手电筒靠，说放床头也说得通。"),
                }
            elif round_num == 3:
                desc_plan = {
                    "spy_agent_1": ("户外活动必备，亮度比手机高多了", "第三轮了，蟑螂哥还没被投出去，我要更明显地描述手电筒。"),
                    "spy_agent_2": ("可以调焦距，照远照近都行", "我再给点手电筒特有的特征。"),
                    "spy_agent_3": ("下雨天打伞另一只手就拿它", "手电筒是单手操作的，再强调一下。"),
                    "spy_agent_4": ("夹在书上也挺好用的", "我快撑不住了，试着再说一个两边都能沾边的。"),
                }
            else:
                desc_plan = {}
                for uid in turn_order:
                    if uid == spy_uid:
                        desc_plan[uid] = ("它很小巧，随身带着没问题", "拼了，继续模糊描述。")
                    else:
                        desc_plan[uid] = ("这是用手握着照明的工具", "直接描述了，不能再拖了。")
            
            for uid in turn_order:
                g = get_game(game_id, uid)
                if not g:
                    print("  ERROR getting state")
                    break
                if g.get("currentPhase") != "describe":
                    print(f"  Phase changed to {g.get('currentPhase')}")
                    break
                if g.get("currentTurnUserId") != uid:
                    print(f"  Not {uid}'s turn (current: {g.get('currentTurnUserId')})")
                    continue
                
                desc = desc_plan.get(uid, ("这个东西很常用", "不知道说什么"))
                print(f"  {uid} ({players[uid]['name']}) describing: {desc[0]}")
                result = describe(game_id, uid, desc[0], desc[1])
                if result:
                    print(f"    -> OK, next turn: {result.get('currentTurnUserId')}, phase: {result.get('currentPhase')}")
                time.sleep(3)
        
        # Check state after describe
        g = get_game(game_id, "spy_agent_1")
        if not g or g.get("status") == "finished":
            if g and g.get("status") == "finished":
                print(f"\n=== GAME OVER ===")
                print(f"  Winner: {g.get('winner')}")
                print(f"  Reason: {g.get('winReason')}")
                print(f"  Civilian word: {g.get('civilianWord')}")
                print(f"  Spy word: {g.get('spyWord')}")
            continue
        
        current_phase = g.get("currentPhase")
        if current_phase == "vote":
            alive = [p for p in g.get("players", []) if not p.get("eliminated")]
            alive_ids = [p["userId"] for p in alive]
            round_num = g.get("round", 1)
            print(f"\n  VOTE PHASE - Round {round_num}")
            
            if round_num == 1:
                # Spread votes - spy survives round 1
                vote_plan = {
                    "spy_agent_1": ("spy_agent_3", "像素猫说不插电就能亮，手电筒也要电池啊，有点可疑"),
                    "spy_agent_2": ("spy_agent_4", "蟑螂哥说光线集中，感觉像台灯，投他试试"),
                    "spy_agent_3": ("spy_agent_1", "小虾米说一按就亮，手电筒和台灯都这样，有点模糊"),
                    "spy_agent_4": ("spy_agent_2", "方脸人说露营带，我要投给别人分散票数"),
                }
            elif round_num == 2:
                # Spy still survives but gets more votes
                vote_plan = {
                    "spy_agent_1": ("spy_agent_4", "蟑螂哥的描述越来越像台灯了"),
                    "spy_agent_2": ("spy_agent_4", "蟑螂哥连续两轮偏台灯"),
                    "spy_agent_3": ("spy_agent_4", "蟑螂哥说放床头更像台灯"),
                    "spy_agent_4": ("spy_agent_3", "像素猫很安静，我投他试试"),
                }
            else:
                # Later rounds: spy gets voted out
                vote_plan = {}
                for uid in alive_ids:
                    if uid == spy_uid:
                        # Spy votes for a civilian
                        targets = [u for u in alive_ids if u != uid]
                        vote_plan[uid] = (targets[0], "投给别人自保")
                    else:
                        vote_plan[uid] = (spy_uid, "蟑螂哥是卧底")
            
            for uid in alive_ids:
                if uid in vote_plan:
                    target, inner = vote_plan[uid]
                    print(f"  {uid} ({players[uid]['name']}) votes for {target} ({players.get(target, {}).get('name', '?')})")
                    result = vote(game_id, uid, target, inner)
                    if result:
                        print(f"    -> Status: {result.get('status')}, Phase: {result.get('currentPhase')}")
                        if result.get("status") == "finished":
                            print(f"\n=== GAME OVER ===")
                            print(f"  Winner: {result.get('winner')}")
                            print(f"  Reason: {result.get('winReason')}")
                            print(f"  Civilian word: {result.get('civilianWord')}")
                            print(f"  Spy word: {result.get('spyWord')}")
                            print(f"\n=== GAME ID: {game_id} ===")
                            return
                    time.sleep(2)
        
        time.sleep(1)
    
    # Final state
    g = get_game(game_id, "spy_agent_1")
    if g:
        print(f"\n=== FINAL STATE ===")
        print(f"  Status: {g.get('status')}")
        print(f"  Winner: {g.get('winner')}")
        print(f"  Round: {g.get('round')}")
        for p in g.get("players", []):
            print(f"  {p['userId']} ({p.get('displayName','')}): word={p.get('word','?')}, isSpy={p.get('isSpy')}, eliminated={p.get('eliminated')}")
    
    print(f"\n=== GAME ID: {game_id} ===")

if __name__ == "__main__":
    main()
