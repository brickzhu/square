const UID_STORAGE_KEY = "square_user_id";
const CHECKERS_RULE = "checkers_chinese_star";
const HEX_DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** 121 孔星形盘，与 backend/checkers_star_geometry 一致 */
const P1_START = [[0,-4],[1,-5],[1,-4],[2,-6],[2,-5],[2,-4],[3,-7],[3,-6],[3,-5],[3,-4],[4,-8],[4,-7],[4,-6],[4,-5],[4,-4]];
const P2_START = [[-4,4],[-4,5],[-4,6],[-4,7],[-4,8],[-3,4],[-3,5],[-3,6],[-3,7],[-2,4],[-2,5],[-2,6],[-1,4],[-1,5],[0,4]];
const ALL_CELLS = [[-8,4],[-7,3],[-7,4],[-6,2],[-6,3],[-6,4],[-5,1],[-5,2],[-5,3],[-5,4],[-4,-4],[-4,-3],[-4,-2],[-4,-1],[-4,0],[-4,1],[-4,2],[-4,3],[-4,4],[-4,5],[-4,6],[-4,7],[-4,8],[-3,-4],[-3,-3],[-3,-2],[-3,-1],[-3,0],[-3,1],[-3,2],[-3,3],[-3,4],[-3,5],[-3,6],[-3,7],[-2,-4],[-2,-3],[-2,-2],[-2,-1],[-2,0],[-2,1],[-2,2],[-2,3],[-2,4],[-2,5],[-2,6],[-1,-4],[-1,-3],[-1,-2],[-1,-1],[-1,0],[-1,1],[-1,2],[-1,3],[-1,4],[-1,5],[0,-4],[0,-3],[0,-2],[0,-1],[0,0],[0,1],[0,2],[0,3],[0,4],[1,-5],[1,-4],[1,-3],[1,-2],[1,-1],[1,0],[1,1],[1,2],[1,3],[1,4],[2,-6],[2,-5],[2,-4],[2,-3],[2,-2],[2,-1],[2,0],[2,1],[2,2],[2,3],[2,4],[3,-7],[3,-6],[3,-5],[3,-4],[3,-3],[3,-2],[3,-1],[3,0],[3,1],[3,2],[3,3],[3,4],[4,-8],[4,-7],[4,-6],[4,-5],[4,-4],[4,-3],[4,-2],[4,-1],[4,0],[4,1],[4,2],[4,3],[4,4],[5,-4],[5,-3],[5,-2],[5,-1],[6,-4],[6,-3],[6,-2],[7,-4],[7,-3],[8,-4]];

function getSquareUserId() {
  try {
    const quid = new URLSearchParams(window.location.search || "").get("uid");
    if (quid && String(quid).trim()) {
      const id = String(quid).trim();
      localStorage.setItem(UID_STORAGE_KEY, id);
      return id;
    }
  } catch (_) {}
  try {
    let id = localStorage.getItem(UID_STORAGE_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(UID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `u_${Date.now()}`;
  }
}

function hexKey(q, r) {
  return `${q},${r}`;
}

/** JSON 里棋格偶发字符串，与座位数字比较前统一成 number */
function cellStone(board, k) {
  const v = board[k];
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const VALID_SET = new Set(ALL_CELLS.map(([q, r]) => hexKey(q, r)));

function parseKey(k) {
  const [a, b] = k.split(",").map(Number);
  return [a, b];
}

function hexDist(a, b) {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(-a[0] - a[1] - (-b[0] - b[1]))) / 2;
}

function cloneBoard(b) {
  return { ...b };
}

function dfsJump(board, cur, to, stone, path, visited) {
  const ck = hexKey(cur[0], cur[1]);
  for (const [dq, dr] of HEX_DIRS) {
    const mid = [cur[0] + dq, cur[1] + dr];
    const land = [cur[0] + 2 * dq, cur[1] + 2 * dr];
    const lk = hexKey(land[0], land[1]);
    if (!VALID_SET.has(lk) || visited.has(lk)) continue;
    const mk = hexKey(mid[0], mid[1]);
    if (cellStone(board, mk) === 0) continue;
    if (cellStone(board, lk) !== 0) continue;
    const nb = cloneBoard(board);
    nb[ck] = 0;
    nb[lk] = stone;
    const npath = [...path, land];
    if (land[0] === to[0] && land[1] === to[1]) return npath;
    visited.add(lk);
    const sub = dfsJump(nb, land, to, stone, npath, visited);
    if (sub) return sub;
    visited.delete(lk);
  }
  return null;
}

function findMovePath(board, from, to, stone) {
  const fk = hexKey(from[0], from[1]);
  const tk = hexKey(to[0], to[1]);
  if (cellStone(board, fk) !== stone || cellStone(board, tk) !== 0) return null;
  if (hexDist(from, to) === 1) return [from, to];
  const visited = new Set();
  return dfsJump(board, from, to, stone, [from], visited);
}

function cellPx(q, r, size) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = size * ((3 / 2) * r);
  return [x, y];
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "X-User-Id": getSquareUserId(),
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || txt || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

let watchingId = null;
let pollTimer = null;
let holeBtns = null;
let boardLayoutKey = null;
let currentMatchSnapshot = null;
let selectedCell = null;
const HOLE_SIZE = 18;
const HOLE_PX = 20;

const STONE_CLASS = ["", "checkers-hole--s1", "checkers-hole--s2", "checkers-hole--s3", "checkers-hole--s4", "checkers-hole--s5", "checkers-hole--s6"];

function defaultCampKeys2p() {
  return {
    1: P1_START.map(([q, r]) => hexKey(q, r)),
    2: P2_START.map(([q, r]) => hexKey(q, r)),
  };
}

function boardLayoutSignature(m) {
  if (!m || m.rule !== CHECKERS_RULE) return "default-2";
  const pc = m.checkersPlayerCount || 2;
  const ck = m.checkersCampKeys;
  return `${pc}:${ck ? JSON.stringify(ck) : JSON.stringify(defaultCampKeys2p())}`;
}

function resetBoardDom() {
  const host = document.getElementById("boardHost");
  if (host) host.innerHTML = "";
  holeBtns = null;
  boardLayoutKey = null;
}

function myStone(m) {
  const me = String(getSquareUserId());
  const seats = m?.checkersSeats;
  if (Array.isArray(seats) && seats.length) {
    const row = seats.find((s) => s && String(s.userId) === me);
    if (row && row.seat != null) return parseInt(String(row.seat), 10);
  }
  if (m?.black?.userId != null && String(m.black.userId) === me) return 1;
  if (m?.white?.userId != null && String(m.white.userId) === me) return 2;
  return null;
}

function isParticipantInMatch(m) {
  return myStone(m) != null;
}

function canClickBoard(m) {
  return (
    m?.status === "running" &&
    isParticipantInMatch(m) &&
    String(m.nextPlayerUserId || "") === String(getSquareUserId())
  );
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll(matchId) {
  stopPoll();
  watchingId = matchId;
  pollTimer = setInterval(() => refreshMatch(false), 900);
}

async function refreshMatch(showErr) {
  if (!watchingId) return;
  try {
    const data = await api(`/api/v1/matches/${watchingId}`);
    applyMatch(data.item);
    if (showErr) document.getElementById("actionHint").textContent = "";
  } catch (e) {
    if (showErr) document.getElementById("actionHint").textContent = String(e.message || e);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 事件委托：棋盘重建后仍有点击；避免 disabled / 冒泡异常导致无响应 */
function attachBoardHostDelegation() {
  const host = document.getElementById("boardHost");
  if (!host || host.dataset.checkersDeleg === "1") return;
  host.dataset.checkersDeleg = "1";
  host.addEventListener("click", (ev) => {
    const t = ev.target.closest(".checkers-hole");
    if (!t || t.disabled) return;
    const q = Number(t.dataset.q);
    const r = Number(t.dataset.r);
    if (Number.isNaN(q) || Number.isNaN(r)) return;
    ev.preventDefault();
    void onHoleClick(q, r);
  });
}

function ensureBoard(m) {
  const sig = boardLayoutSignature(m || currentMatchSnapshot);
  if (holeBtns && boardLayoutKey === sig) return;

  resetBoardDom();
  boardLayoutKey = sig;

  const host = document.getElementById("boardHost");
  host.innerHTML = "";
  const stage = el("div", "checkers-stage-inner");
  const pts = ALL_CELLS.map(([q, r]) => {
    const [x, y] = cellPx(q, r, HOLE_SIZE);
    return { q, r, x, y };
  });
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 22;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const ox = -minX + pad;
  const oy = -minY + pad;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  host.appendChild(stage);
  holeBtns = {};

  const snap = m || currentMatchSnapshot;
  const campKeys = snap?.checkersCampKeys || defaultCampKeys2p();
  const campSets = {};
  for (const s of Object.keys(campKeys)) {
    campSets[s] = new Set(campKeys[s]);
  }

  const half = HOLE_PX / 2;
  for (const [q, r] of ALL_CELLS) {
    const [x, y] = cellPx(q, r, HOLE_SIZE);
    const k = hexKey(q, r);
    const btn = el("button", "checkers-hole");
    btn.type = "button";
    btn.dataset.q = String(q);
    btn.dataset.r = String(r);
    btn.style.left = `${x + ox - half}px`;
    btn.style.top = `${y + oy - half}px`;
    for (const s of Object.keys(campSets)) {
      if (campSets[s].has(k)) btn.classList.add(`checkers-hole--camp-${s}`);
    }
    stage.appendChild(btn);
    holeBtns[k] = btn;
  }
}

function renderBoard(board) {
  ensureBoard(currentMatchSnapshot);
  for (const k of Object.keys(holeBtns)) {
    const btn = holeBtns[k];
    const v = cellStone(board, k);
    for (let i = 1; i <= 6; i++) btn.classList.remove(STONE_CLASS[i]);
    btn.classList.remove("checkers-hole--sel");
    if (v >= 1 && v <= 6) btn.classList.add(STONE_CLASS[v]);
  }
  if (selectedCell) {
    const sk = hexKey(selectedCell[0], selectedCell[1]);
    if (holeBtns[sk]) holeBtns[sk].classList.add("checkers-hole--sel");
  }
}

function applyMatch(m) {
  currentMatchSnapshot = m;
  if (m && m.id) {
    watchingId = m.id;
    const joinEl = document.getElementById("joinMatchId");
    if (joinEl && !joinEl.value.trim()) joinEl.value = m.id;
  }
  const board = m.board || {};
  const me = String(getSquareUserId());
  const st = myStone(m);
  if (selectedCell) {
    const sk = hexKey(selectedCell[0], selectedCell[1]);
    if (
      m.status !== "running" ||
      String(m.nextPlayerUserId || "") !== me ||
      cellStone(board, sk) !== st
    ) {
      selectedCell = null;
    }
  }

  document.getElementById("matchStatusBadge").textContent = m.status;
  const aid = m.id || "";
  const pc = m.checkersPlayerCount || 2;
  let roster = "";
  if (pc === 6 && Array.isArray(m.checkersSeats)) {
    const filled = m.checkersSeats.length;
    const lines = m.checkersSeats.map((s) => `座位${s.seat} ${s.displayName || "?"}`).join(" · ");
    roster = `六人局 ${filled}/6：${lines}`;
  } else {
    const g = m.black?.displayName || "?";
    const r = m.white?.displayName || "等待加入";
    roster = `双人局 · 先手座位1：${g} · 座位2：${r}`;
  }
  document.getElementById("matchInfo").textContent = `场次 ${aid} · ${roster}`;
  const uidView = document.getElementById("squareUidView");
  if (uidView) uidView.textContent = getSquareUserId();
  renderBoard(board);

  const finished = m.status === "finished";
  if (finished) {
    selectedCell = null;
    if (String(m.winnerUserId || "") === me) document.getElementById("turnHint").textContent = "你赢了";
    else document.getElementById("turnHint").textContent = m.winnerUserId ? "对手胜" : "终局";
    stopPoll();
    renderBoard(m.board || {});
    return;
  }
  if (m.status === "running") {
    if (!isParticipantInMatch(m)) document.getElementById("turnHint").textContent = "观战中（仅观看）";
    else if (String(m.nextPlayerUserId || "") === me)
      document.getElementById("turnHint").textContent = "轮到你：先选己方棋子，再点目标位";
    else
      document.getElementById("turnHint").textContent =
        (m.checkersPlayerCount || 2) === 6 ? "等待其他棋手行棋…" : "等待对手…";
  } else {
    const pcOpen = m.checkersPlayerCount || 2;
    const n = Array.isArray(m.checkersSeats) ? m.checkersSeats.length : m.white ? pcOpen : 1;
    if (pcOpen === 6) document.getElementById("turnHint").textContent = `等待加入（${n}/6），人满后由座位 1 先手`;
    else document.getElementById("turnHint").textContent = "等待对手加入本场";
  }
  updatePlayable(m);
}

function updatePlayable(m) {
  const running = m?.status === "running";
  const part = isParticipantInMatch(m);
  // 仅「进行中的纯观战者」禁用孔位；棋手始终可点（轮到否由 onHoleClick 提示）。避免 disabled 导致完全点不到。
  for (const k of Object.keys(holeBtns || {})) {
    holeBtns[k].disabled = !!(running && !part);
  }
}

async function onHoleClick(q, r) {
  const m = currentMatchSnapshot;
  const hint0 = document.getElementById("actionHint");
  if (!m || m.rule !== CHECKERS_RULE) {
    if (hint0) hint0.textContent = "还未载入跳棋场次，请先创建/加入或带 ?match= 打开本页。";
    return;
  }
  if (!watchingId) {
    if (m.id) watchingId = m.id;
  }
  if (!watchingId) {
    if (hint0) hint0.textContent = "缺少场次 ID：请在侧栏填写 match_… 后点「刷新」，或重新加入对局。";
    return;
  }
  if (!canClickBoard(m)) {
    const me = String(getSquareUserId());
    const part = isParticipantInMatch(m);
    const hintEl = document.getElementById("actionHint");
    if (m.status === "running" && !part) {
      hintEl.textContent =
        "你不是本局棋手：本页身份与对局座位不一致。请在侧栏填入与「创建/加入」相同的 uid，点「应用并刷新」。";
    } else if (m.status === "running" && part && String(m.nextPlayerUserId || "") !== me) {
      hintEl.textContent = "当前轮到对方行棋，请等待。";
    } else {
      hintEl.textContent = "对局未开始或已结束，无法在这里走棋。";
    }
    return;
  }
  const stone = myStone(m);
  const k = hexKey(q, r);
  const board = m.board || {};
  document.getElementById("actionHint").textContent = "";

  if (!selectedCell) {
    if (cellStone(board, k) !== stone) {
      document.getElementById("actionHint").textContent = "请先选择你的棋子。";
      return;
    }
    selectedCell = [q, r];
    renderBoard(board);
    return;
  }

  const [sq, sr] = selectedCell;
  if (sq === q && sr === r) {
    selectedCell = null;
    renderBoard(board);
    return;
  }

  const path = findMovePath(board, [sq, sr], [q, r], stone);
  if (!path) {
    document.getElementById("actionHint").textContent = "无法一步/一跳到达，请另选。";
    return;
  }

  try {
    const data = await api(`/api/v1/matches/${watchingId}/moves`, {
      method: "POST",
      body: JSON.stringify({ path: path.map(([a, b]) => [a, b]) }),
    });
    selectedCell = null;
    applyMatch(data.item);
  } catch (e) {
    document.getElementById("actionHint").textContent = String(e.message || e);
  }
}

async function loadOpenMatches() {
  const box = document.getElementById("openMatches");
  box.innerHTML = "";
  try {
    const data = await api("/api/v1/matches?status=open");
    const items = (data.items || []).filter((m) => m.rule === CHECKERS_RULE);
    if (!items.length) {
      box.appendChild(el("div", "hint", "暂无等待中的跳棋场次"));
      return;
    }
    for (const m of items) {
      const row = el("div", "gomoku-open-row");
      const pc = m.checkersPlayerCount || 2;
      const n = Array.isArray(m.checkersSeats) ? m.checkersSeats.length : 1;
      const mode = pc === 6 ? `六人 ${n}/6` : "双人";
      const title = el("div", null, `${m.id} · ${mode} · 房主 ${m.black?.displayName || "?"}`);
      const joinBtn = el("button", "btn btn--primary", "加入");
      joinBtn.type = "button";
      joinBtn.addEventListener("click", async () => {
        document.getElementById("joinMatchId").value = m.id;
        await doJoin();
      });
      row.appendChild(title);
      row.appendChild(joinBtn);
      box.appendChild(row);
    }
  } catch (e) {
    box.appendChild(el("div", "hint", `加载失败：${e.message || e}`));
  }
}

async function doCreate() {
  const hint = document.getElementById("actionHint");
  hint.textContent = "";
  const displayName = document.getElementById("playerName").value.trim() || "匿名棋士";
  const agentLabel = document.getElementById("agentLabel").value.trim();
  try {
    const pcRaw = document.getElementById("checkersPlayerMode")?.value || "2";
    const checkersPlayerCount = parseInt(pcRaw, 10) === 6 ? 6 : 2;
    const data = await api("/api/v1/matches", {
      method: "POST",
      body: JSON.stringify({
        displayName,
        agentLabel: agentLabel || undefined,
        rule: CHECKERS_RULE,
        checkersPlayerCount,
      }),
    });
    watchingId = data.item.id;
    document.getElementById("joinMatchId").value = watchingId;
    applyMatch(data.item);
    startPoll(watchingId);
    hint.textContent =
      checkersPlayerCount === 6 ? "已开六人局，把 ID 给另 5 位依次加入" : "已创建双人跳棋，把 ID 给对手加入";
    await loadOpenMatches();
  } catch (e) {
    hint.textContent = String(e.message || e);
  }
}

async function doJoin() {
  const hint = document.getElementById("actionHint");
  hint.textContent = "";
  const id = document.getElementById("joinMatchId").value.trim();
  if (!id) {
    hint.textContent = "填写场次 ID";
    return;
  }
  const displayName = document.getElementById("playerName").value.trim() || "匿名棋士";
  const agentLabel = document.getElementById("agentLabel").value.trim();
  try {
    const data = await api(`/api/v1/matches/${id}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName, agentLabel: agentLabel || undefined }),
    });
    watchingId = data.item.id;
    applyMatch(data.item);
    startPoll(watchingId);
    hint.textContent =
      (data.item?.checkersPlayerCount || 2) === 6 && data.item?.status === "open"
        ? `已入座 ${data.item?.checkersSeats?.length || 0}/6`
        : "已加入，座位1先手";
    await loadOpenMatches();
  } catch (e) {
    hint.textContent = String(e.message || e);
  }
}

function applyCheckersUidFromSidebar() {
  const input = document.getElementById("checkersUidOverride");
  const hint = document.getElementById("actionHint");
  const v = (input?.value || "").trim();
  if (!v) {
    if (hint) hint.textContent = "先填写要使用的 uid";
    return;
  }
  try {
    localStorage.setItem(UID_STORAGE_KEY, v);
  } catch (_) {}
  const u = new URL(window.location.href);
  u.searchParams.set("uid", v);
  window.location.href = u.toString();
}

window.addEventListener("DOMContentLoaded", () => {
  attachBoardHostDelegation();
  document.getElementById("createMatchBtn").onclick = doCreate;
  document.getElementById("joinMatchBtn").onclick = doJoin;
  document.getElementById("refreshBoardBtn").onclick = () => {
    const id = document.getElementById("joinMatchId")?.value?.trim();
    if (id) {
      watchingId = id;
      startPoll(id);
    }
    refreshMatch(true);
  };
  const uidApply = document.getElementById("checkersUidApplyBtn");
  if (uidApply) uidApply.onclick = applyCheckersUidFromSidebar;
  const uidOverride = document.getElementById("checkersUidOverride");
  const fromUrl = new URLSearchParams(location.search).get("uid");
  if (uidOverride && fromUrl) uidOverride.placeholder = `当前 ${fromUrl}`;
  const uidView = document.getElementById("squareUidView");
  if (uidView) uidView.textContent = getSquareUserId();

  ensureBoard(null);
  loadOpenMatches();

  const q = new URLSearchParams(location.search).get("match");
  if (q) {
    document.getElementById("joinMatchId").value = q;
    watchingId = q;
    refreshMatch(true);
    startPoll(q);
  }
});
