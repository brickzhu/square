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

function isDemoMatch(m) {
  return !!(m && m.renderSpec && m.renderSpec.demo === true);
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
    // 对局不存在（404）- 停止轮询
    if (!data.item) {
      stopPoll();
      if (showErr) {
        document.getElementById("actionHint").textContent = "对局不存在，已停止刷新";
      }
      return;
    }
    applyMatch(data.item);
    if (showErr) document.getElementById("actionHint").textContent = "";
    // 对局已结束 - 停止轮询
    if (data.item.status === "finished") {
      stopPoll();
      document.getElementById("actionHint").textContent = "对局已结束";
    }
  } catch (e) {
    // 404 错误 - 对局不存在，停止轮询
    if (e.message && e.message.includes("404")) {
      stopPoll();
      if (showErr) {
        document.getElementById("actionHint").textContent = "对局不存在，已停止刷新";
      }
      return;
    }
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
  const board = el("div", "gomoku-board");
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lines.setAttribute("class", "gomoku-board-lines");
  lines.setAttribute("viewBox", "0 0 14 14");
  lines.setAttribute("preserveAspectRatio", "none");
  lines.setAttribute("aria-hidden", "true");
  for (let i = 0; i <= 14; i++) {
    const h = document.createElementNS("http://www.w3.org/2000/svg", "line");
    h.setAttribute("x1", "0");
    h.setAttribute("y1", String(i));
    h.setAttribute("x2", "14");
    h.setAttribute("y2", String(i));
    lines.appendChild(h);
    const v = document.createElementNS("http://www.w3.org/2000/svg", "line");
    v.setAttribute("x1", String(i));
    v.setAttribute("y1", "0");
    v.setAttribute("x2", String(i));
    v.setAttribute("y2", "14");
    lines.appendChild(v);
  }
  board.appendChild(lines);
  const grid = el("div", "gomoku-grid gomoku-grid--intersections");
  boardCells = [];
  for (let y = 0; y < 15; y++) {
    const row = [];
    for (let x = 0; x < 15; x++) {
      const cell = el("button", "gomoku-cell");
      cell.type = "button";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.style.setProperty("--gx", String(x));
      cell.style.setProperty("--gy", String(y));
      cell.setAttribute("aria-label", `交点 列 ${x + 1}，行 ${y + 1}`);
      cell.addEventListener("click", () => onCellClick(x, y));
      grid.appendChild(cell);
      row.push(cell);
    }
    boardCells.push(row);
  }
  board.appendChild(grid);
  host.appendChild(board);
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

function formatTurnClockHint(m) {
  const c = m.turnClock;
  if (!c || m.status !== "running") return "";
  const r = Number(c.remainingSeconds) || 0;
  const mm = Math.floor(r / 60);
  const ss = r % 60;
  const clock = `${mm}:${String(ss).padStart(2, "0")}`;
  const me = getSquareUserId();
  if (String(c.forUserId || "") === String(me)) {
    return c.warn
      ? ` · 本步剩余 ${clock}（不足1 分钟将判负）`
      : ` · 本步剩余 ${clock}`;
  }
  return ` · 对方思考中（剩余 ${clock}）`;
}

/** 终局文案：棋手与观战统一为黑方胜 / 白方胜 / 和棋 */
function finishedSummaryText(m) {
  if (m.winReason === "timeout") {
    const ws = m.winnerStone;
    if (ws === 1) return "黑方胜（对方超时未行棋）";
    if (ws === 2) return "白方胜（对方超时未行棋）";
    return "终局（有棋手超时未行棋）";
  }
  if (m.winReason === "draw") return "和棋";
  const ws = m.winnerStone;
  if (ws === 1) return "黑方胜";
  if (ws === 2) return "白方胜";
  const wid = m.winnerUserId;
  const bu = m.black?.userId;
  const wu = m.white?.userId;
  if (wid && bu && String(wid) === String(bu)) return "黑方胜";
  if (wid && wu && String(wid) === String(wu)) return "白方胜";
  return wid ? "终局（胜方已决）" : "终局";
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
    document.getElementById("turnHint").textContent = finishedSummaryText(m);
    updateInteractiveCells(m);
    stopPoll();
    return;
  }
  if (m.status === "running") {
    if (!isParticipantInMatch(m)) {
      document.getElementById("turnHint").textContent =
        "观战中（仅观看）" + formatTurnClockHint(m);
    } else if (m.nextPlayerUserId === me) {
      document.getElementById("turnHint").textContent =
        "轮到你下（点击棋盘）" + formatTurnClockHint(m);
    } else {
      document.getElementById("turnHint").textContent =
        "等待对手…" + formatTurnClockHint(m);
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

async function loadOpenMatches() {
  const box = document.getElementById("openMatches");
  box.innerHTML = "";
  try {
    const data = await api("/api/v1/matches?status=open");
    const items = (data.items || []).filter(
      (m) => !isDemoMatch(m) && (m.rule || "gomoku_15") === "gomoku_15",
    );
    if (!items.length) {
      box.appendChild(el("div", "hint", "暂无公开等待中的对局"));
      return;
    }
    for (const m of items) {
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
    box.appendChild(el("div", "hint", `加载失败：${e.message || e}`));
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
    await loadOpenMatches();
  } catch (e) {
    hint.textContent = String(e.message || e);
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
