const UID_STORAGE_KEY = "square_user_id";

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
let boardCells = null;
let lastHistoryLen = 0;
let danmuMatchId = null;
let currentMatchSnapshot = null;

function isParticipantInMatch(m) {
  const me = getSquareUserId();
  return !!(m && (m.black?.userId === me || m.white?.userId === me));
}

function canClickBoardToMove(m) {
  return (
    m?.status === "running" &&
    isParticipantInMatch(m) &&
    m.nextPlayerUserId === getSquareUserId()
  );
}

function updateInteractiveCells(m) {
  if (!boardCells) return;
  const playable = canClickBoardToMove(m);
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const cell = boardCells[y][x];
      cell.disabled = !playable;
      cell.classList.toggle("gomoku-cell--no-play", !playable);
    }
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
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

function emitDanmu(text, stone) {
  const layer = document.getElementById("danmuLayer");
  if (!layer || !text) return;
  const row = el("div", "gomoku-danmu");
  if (stone === 1) row.classList.add("gomoku-danmu--black");
  else row.classList.add("gomoku-danmu--white");
  row.textContent = text;
  const topPct = 10 + Math.random() * 75;
  row.style.top = `${topPct}%`;
  const sec = 9 + Math.random() * 7;
  row.style.animationDuration = `${sec}s`;
  row.style.webkitAnimationDuration = `${sec}s`;
  layer.appendChild(row);
  const fallbackMs = Math.min((sec + 2.5) * 1000, 32000);
  let tid = window.setTimeout(finish, fallbackMs);
  function finish() {
    if (tid != null) {
      window.clearTimeout(tid);
      tid = null;
    }
    if (row.parentNode) row.remove();
  }
  row.addEventListener("animationend", finish, { once: true });
  row.addEventListener("webkitAnimationEnd", finish, { once: true });
}

function ensureBoard() {
  const host = document.getElementById("boardHost");
  if (boardCells) return;
  host.innerHTML = "";
  const grid = el("div", "gomoku-grid");
  boardCells = [];
  for (let y = 0; y < 15; y++) {
    const row = [];
    for (let x = 0; x < 15; x++) {
      const cell = el("button", "gomoku-cell");
      cell.type = "button";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.setAttribute("aria-label", `格子 ${x + 1},${y + 1}`);
      cell.addEventListener("click", () => onCellClick(x, y));
      grid.appendChild(cell);
      row.push(cell);
    }
    boardCells.push(row);
  }
  host.appendChild(grid);
}

function renderBoard(board) {
  ensureBoard();
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const v = board[y][x];
      const cell = boardCells[y][x];
      cell.classList.remove("gomoku-cell--black", "gomoku-cell--white");
      if (v === 1) cell.classList.add("gomoku-cell--black");
      if (v === 2) cell.classList.add("gomoku-cell--white");
    }
  }
}

function applyMatch(m) {
  currentMatchSnapshot = m;
  document.getElementById("matchStatusBadge").textContent = m.status;
  const black = m.black?.displayName || "?";
  const white = m.white?.displayName || "等待加入";
  const aid = m.id || "";
  if (danmuMatchId !== aid) {
    danmuMatchId = aid;
    lastHistoryLen = 0;
    const lyr = document.getElementById("danmuLayer");
    if (lyr) lyr.innerHTML = "";
  }
  document.getElementById(
    "matchInfo"
  ).textContent = `场次 ${aid} · 黑（先手）：${black} · 白：${white}`;
  renderBoard(m.board);

  const hist = m.moveHistory || [];
  for (let i = lastHistoryLen; i < hist.length; i++) {
    const h = hist[i];
    const label = h.stone === 1 ? "黑" : h.stone === 2 ? "白" : "?";
    const n = typeof h.index === "number" ? h.index + 1 : i + 1;
    const line = `第${n}手 · ${label} (${h.x},${h.y})`;
    const extra = h.thought && String(h.thought).trim();
    emitDanmu(extra || line, h.stone);
  }
  lastHistoryLen = hist.length;

  const me = getSquareUserId();
  const finished = m.status === "finished";
  if (finished) {
    if (m.winReason === "draw") document.getElementById("turnHint").textContent = "和棋";
    else if (m.winnerUserId === me) document.getElementById("turnHint").textContent = "你赢了";
    else document.getElementById("turnHint").textContent = m.winnerUserId ? "对手胜" : "终局";
    updateInteractiveCells(m);
    stopPoll();
    return;
  }
  if (m.status === "running") {
    if (!isParticipantInMatch(m)) {
      document.getElementById("turnHint").textContent = "观战中（仅观看）";
    } else if (m.nextPlayerUserId === me) {
      document.getElementById("turnHint").textContent = "轮到你下（点击棋盘）";
    } else {
      document.getElementById("turnHint").textContent = "等待对手…";
    }
  } else {
    document.getElementById("turnHint").textContent = "等待对手加入本场";
  }
  updateInteractiveCells(m);
}

async function onCellClick(x, y) {
  if (!watchingId || !currentMatchSnapshot) return;
  if (!canClickBoardToMove(currentMatchSnapshot)) {
    const hint = document.getElementById("actionHint");
    if (!isParticipantInMatch(currentMatchSnapshot)) {
      hint.textContent = "你不是本局棋手，无法在此落子。";
    } else {
      hint.textContent = "当前还未轮到你行棋。";
    }
    return;
  }
  document.getElementById("actionHint").textContent = "";
  try {
    const data = await api(`/api/v1/matches/${watchingId}/moves`, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    applyMatch(data.item);
  } catch (e) {
    document.getElementById("actionHint").textContent = String(e.message || e);
  }
}

async function doCreate() {
  const hint = document.getElementById("actionHint");
  hint.textContent = "";
  const displayName = document.getElementById("playerName").value.trim() || "匿名棋士";
  const agentLabel = document.getElementById("agentLabel").value.trim();
  try {
    const data = await api("/api/v1/matches", {
      method: "POST",
      body: JSON.stringify({ displayName, agentLabel: agentLabel || undefined }),
    });
    watchingId = data.item.id;
    document.getElementById("joinMatchId").value = watchingId;
    applyMatch(data.item);
    startPoll(watchingId);
    hint.textContent = "已创建，把你的场次 ID 给对手加入";
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
    hint.textContent = "已加入，黑棋先手";
  } catch (e) {
    hint.textContent = String(e.message || e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("createMatchBtn").onclick = doCreate;
  document.getElementById("joinMatchBtn").onclick = doJoin;
  document.getElementById("refreshBoardBtn").onclick = () => refreshMatch(true);
  ensureBoard();

  const q = new URLSearchParams(location.search).get("match");
  if (q) {
    document.getElementById("joinMatchId").value = q;
    watchingId = q;
    refreshMatch(true);
    startPoll(q);
  }
});
