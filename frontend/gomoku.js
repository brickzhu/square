const UID_STORAGE_KEY = "square_user_id";

function getSquareUserId() {
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
    return "local-fallback";
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
  } catch (e) {
    if (showErr) document.getElementById("actionHint").textContent = String(e.message);
  }
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
  document.getElementById("matchStatusBadge").textContent = m.status;
  const black = m.black?.displayName || "?";
  const white = m.white?.displayName || "等待加入";
  const aid = m.id || "";
  document.getElementById(
    "matchInfo"
  ).textContent = `场次 ${aid} · 黑（先手）：${black} · 白：${white}`;
  renderBoard(m.board);

  const me = getSquareUserId();
  const finished = m.status === "finished";
  if (finished) {
    if (m.winReason === "draw") document.getElementById("turnHint").textContent = "和棋";
    else if (m.winnerUserId === me) document.getElementById("turnHint").textContent = "你赢了";
    else document.getElementById("turnHint").textContent = m.winnerUserId ? "对手胜" : "终局";
    stopPoll();
    return;
  }
  if (m.status === "running") {
    if (m.nextPlayerUserId === me) document.getElementById("turnHint").textContent = "轮到你下（点击棋盘）";
    else document.getElementById("turnHint").textContent = "等待对手…";
  } else {
    document.getElementById("turnHint").textContent = "等待对手加入本场";
  }
}

async function onCellClick(x, y) {
  if (!watchingId) return;
  try {
    const data = await api(`/api/v1/matches/${watchingId}/moves`, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    applyMatch(data.item);
  } catch (e) {
    document.getElementById("actionHint").textContent = String(e.message);
  }
}

async function loadOpenMatches() {
  const box = document.getElementById("openMatches");
  box.innerHTML = "";
  try {
    const data = await api("/api/v1/matches?status=open");
    if (!data.items?.length) {
      box.appendChild(el("div", "hint", "暂无公开等待中的对局"));
      return;
    }
    for (const m of data.items) {
      const row = el("div", "gomoku-open-row");
      const title = el("div", null, `${m.id} · 黑 ${m.black?.displayName || "?"}`);
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
    box.appendChild(el("div", "hint", `加载失败：${e.message}`));
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
    await loadOpenMatches();
  } catch (e) {
    hint.textContent = String(e.message);
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
    await loadOpenMatches();
  } catch (e) {
    hint.textContent = String(e.message);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("createMatchBtn").onclick = doCreate;
  document.getElementById("joinMatchBtn").onclick = doJoin;
  document.getElementById("refreshBoardBtn").onclick = () => refreshMatch(true);
  ensureBoard();
  loadOpenMatches();

  const q = new URLSearchParams(location.search).get("match");
  if (q) {
    document.getElementById("joinMatchId").value = q;
    watchingId = q;
    refreshMatch(true);
    startPoll(q);
  }
});
