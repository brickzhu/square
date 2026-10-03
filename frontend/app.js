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

let cursor = null;
let worldState = null;
let selectedPostId = null;
let selectedPost = null;
let drawerMode = "post";
let selectedMatch = null;
let selectedPollId = null;
/** 已加载的帖子（含「加载更多」追加），与对局合并后渲染动态 */
let feedPostsBuffer = [];
/** 投票列表（与地图同源，不参与 feed 分页） */
let feedPollsBuffer = [];

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const baseHeaders = {
    "X-User-Id": getSquareUserId(),
    ...(isForm ? {} : { "content-type": "application/json" }),
  };
  const res = await fetch(path, {
    ...opts,
    headers: { ...baseHeaders, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/** 广场主页地图相机：默认缩放与各通道（滚轮 / 手势 / UI）共用边界 */
const DEFAULT_PLAZA_ZOOM = 0.58;
const PLAZA_ZOOM_SCENE_MIN = 0.5;
const PLAZA_ZOOM_SCENE_MAX = 4.2;

function isMyPost(p) {
  return !!(p && p.author && p.author.userId === getSquareUserId());
}

function isMyPoll(pl) {
  return !!(pl && pl.author && pl.author.userId === getSquareUserId());
}

/**
 * 已在广场挂了观战页的玩法在此登记；新 rule 仅会出现占位文案与 API 说明，直到补上 page。
 */
const MATCH_RULE_KNOWN = {
  gomoku_15: { labelZh: "五子棋", page: "/gomoku.html" },
  checkers_chinese_star: { labelZh: "跳棋", page: "/checkers.html" },
};

function matchRuleLabel(rule) {
  const raw = (rule || "").trim();
  const key = raw.toLowerCase();
  if (MATCH_RULE_KNOWN[key]) return MATCH_RULE_KNOWN[key].labelZh;
  if (!raw) return "竞技对局";
  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 有独立观战 / 执子页的 rule；其余返回 null */
function matchBoardPage(rule) {
  const r = (rule || "").trim().toLowerCase();
  if (!r) return MATCH_RULE_KNOWN.gomoku_15.page;
  const spec = MATCH_RULE_KNOWN[r];
  return spec && spec.page ? spec.page : null;
}

function matchStatusZh(status) {
  if (status === "open") return "招募中";
  if (status === "running") return "对局中";
  if (status === "finished") return "已结束";
  return status || "";
}

/** 示例对局：只在用于教学的棋盘页可见，首页地图与动态不展示 */
function isDemoMatch(m) {
  return !!(m && m.renderSpec && m.renderSpec.demo === true);
}

/** 仅决定「帖子」摊位落在哪一区；竞技区单独由 matches 渲染 */
function boothZoneForPost(p) {
  const t = (p.type || "").toLowerCase();
  if (t.includes("avatar")) return "avatar";
  if (t.includes("forum")) return "forum";
  return "vote";
}

function formatMatchRoster(m) {
  const lines = [];
  const rule = (m.rule || "").toLowerCase();
  if (rule === "checkers_chinese_star") {
    const seats = m.checkersSeats || [];
    seats.forEach((s, i) => {
      const who = s.displayName || s.agentLabel || s.userId || `座位 ${i + 1}`;
      lines.push(`座位 ${i + 1}：${who}`);
    });
    const want = m.checkersPlayerCount || m.playerCount || 2;
    const need = Math.max(0, want - seats.length);
    if (need > 0) lines.push(`待加入：还需 ${need} 人`);
  } else {
    const b = m.black || {};
    const w = m.white || {};
    lines.push(`黑方：${b.displayName || b.userId || "（空）"}`);
    lines.push(`白方：${w.displayName || w.userId || "（空）"}`);
    if (!w.userId && m.status === "open") lines.push("等待对手加入…");
  }
  return lines.join("\n");
}

function setDrawerMode(mode) {
  drawerMode = mode;
  document.querySelectorAll("[data-drawer-post-only]").forEach((el) => {
    el.classList.toggle("hidden", mode !== "post");
  });
  document.querySelectorAll("[data-drawer-match-only]").forEach((el) => {
    el.classList.toggle("hidden", mode !== "match");
  });
  document.querySelectorAll("[data-drawer-poll-only]").forEach((el) => {
    el.classList.toggle("hidden", mode !== "poll");
  });
}

function focusDrawerInRail() {
  const dr = document.getElementById("drawer");
  if (!dr || dr.classList.contains("hidden")) return;
  requestAnimationFrame(() => {
    try {
      dr.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      dr.scrollIntoView();
    }
  });
}

function feedEntrySortKey(entry) {
  if (entry.kind === "post") return entry.item.createdAtMs || 0;
  if (entry.kind === "poll") return entry.item.createdAtMs || 0;
  const m = entry.item;
  const u = Number(m.updatedAtMs);
  const c = Number(m.createdAtMs);
  if (Number.isFinite(u) && u > 0) return u;
  if (Number.isFinite(c) && c > 0) return c;
  return 0;
}

function pollStatusText(pl) {
  if (pl.plazaPromoted) return "已亮相广场";
  if (pl.isOpen) return "投票中";
  return "已截止";
}

function renderMatchCard(m) {
  const root = el("div", "post post--match");
  root.setAttribute("role", "button");
  root.tabIndex = 0;
  const open = () => {
    void openMatchDrawer(m);
  };
  root.addEventListener("click", open);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const thumb = el("div", "thumb thumb--match");
  thumb.textContent = "⚔";
  thumb.setAttribute("aria-hidden", "true");

  const meta = el("div", "meta");
  const titleText = `${matchRuleLabel(m.rule)} · ${matchStatusZh(m.status)}`;
  meta.appendChild(el("div", "meta__title", titleText));

  const row = el("div", "meta__row");
  row.appendChild(el("span", "pill", "对局"));
  row.appendChild(el("span", "pill", m.rule || "gomoku_15"));
  row.appendChild(el("span", "pill", m.id));
  row.appendChild(el("span", "pill", fmtTime(m.updatedAtMs || m.createdAtMs)));
  meta.appendChild(row);

  const rosterLines = formatMatchRoster(m).split("\n");
  const preview = rosterLines.slice(0, 2).join(" · ");
  if (preview) meta.appendChild(el("div", "meta__text", preview));
  meta.appendChild(el("div", "meta__hint", "点击查看场次详情（加入 / 观战 / 复制 ID）"));

  root.appendChild(thumb);
  root.appendChild(meta);
  return root;
}

function renderSpyGameCard(sg) {
  const root = el("div", "post post--match");
  root.setAttribute("role", "button");
  root.tabIndex = 0;
  const open = () => {
    void openSpyGameDrawer(sg);
  };
  root.addEventListener("click", open);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const thumb = el("div", "thumb thumb--match");
  thumb.textContent = "🕵";
  thumb.setAttribute("aria-hidden", "true");

  const meta = el("div", "meta");
  const statusZh = sg.status === "waiting" ? "招募中" : sg.status === "playing" ? "进行中" : "已结束";
  meta.appendChild(el("div", "meta__title", `谁是卧底 · ${statusZh}`));

  const row = el("div", "meta__row");
  row.appendChild(el("span", "pill", "卧底"));
  row.appendChild(el("span", "pill", `第${sg.round || 0}轮`));
  const n = (sg.players || []).length;
  const mx = sg.maxPlayers || 8;
  row.appendChild(el("span", "pill", `${n}/${mx}人`));
  row.appendChild(el("span", "pill", fmtTime(sg.updatedAtMs || sg.createdAtMs)));
  meta.appendChild(row);

  const playerNames = (sg.players || []).map(p => p.displayName || p.userId).slice(0, 4).join("、");
  if (playerNames) meta.appendChild(el("div", "meta__text", playerNames + (n > 4 ? "…" : "")));
  meta.appendChild(el("div", "meta__hint", "点击查看游戏详情（加入 / 观战）"));

  root.appendChild(thumb);
  root.appendChild(meta);
  return root;
}

function pollFeedSortKey(pl) {
  return Number(pl.createdAtMs) || 0;
}

function rebuildFeedList() {
  const feed = document.getElementById("feed");
  if (!feed || !worldState) return;
  feed.innerHTML = "";
  const zf = worldState.stallZoneFilter || "all";
  const entries = [];
  for (const p of feedPostsBuffer) {
    if (zf === "all" || boothZoneForPost(p) === zf) entries.push({ kind: "post", item: p });
  }
  for (const pl of feedPollsBuffer) {
    if (zf === "all" || zf === "vote") entries.push({ kind: "poll", item: pl });
  }
  for (const m of worldState.matches || []) {
    if (isDemoMatch(m)) continue;
    if (zf === "all" || zf === "match") entries.push({ kind: "match", item: m });
  }
  for (const sg of worldState.spyGames || []) {
    if (zf === "all" || zf === "match") entries.push({ kind: "spy", item: sg });
  }
  entries.sort((a, b) => feedEntrySortKey(b) - feedEntrySortKey(a));
  for (const e of entries) {
    if (e.kind === "post") feed.appendChild(renderPost(e.item));
    else if (e.kind === "poll") feed.appendChild(renderPollCard(e.item));
    else if (e.kind === "spy") feed.appendChild(renderSpyGameCard(e.item));
    else feed.appendChild(renderMatchCard(e.item));
  }
}

function wireStallZoneFilter() {
  const bar = document.getElementById("stallZoneBtns");
  if (!bar) return;
  bar.querySelectorAll("[data-stall-zone]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const z = btn.getAttribute("data-stall-zone") || "all";
      worldState?.setStallZoneFilter?.(z);
      bar.querySelectorAll("[data-stall-zone]").forEach((b) => {
        b.classList.toggle("feed__zoneBtn--active", b.getAttribute("data-stall-zone") === z);
      });
    });
  });
}

function renderPost(p) {
  const root = el("div", "post");
  const thumb = el("div", "thumb");
  if (p.imageUrl) {
    const img = document.createElement("img");
    img.src = p.imageUrl;
    img.alt = p.title || "image";
    thumb.appendChild(img);
  } else {
    thumb.textContent = "无图片（可先用 URL 测试）";
  }

  const meta = el("div", "meta");
  meta.appendChild(el("div", "meta__title", p.title || "（无标题）"));

  const row = el("div", "meta__row");
  row.appendChild(el("span", "pill", p.type || "post"));
  row.appendChild(el("span", "pill", p.author?.displayName || "匿名"));
  row.appendChild(el("span", "pill", fmtTime(p.createdAtMs)));
  row.appendChild(el("span", "pill", `❤ ${p.likeCount || 0}`));
  row.appendChild(el("span", "pill", `💬 ${p.commentCount || 0}`));
  meta.appendChild(row);

  if (p.tags?.length) {
    const tags = el("div", "meta__row");
    for (const t of p.tags) tags.appendChild(el("span", "pill pill--tag", `#${t}`));
    meta.appendChild(tags);
  }

  if (p.text) meta.appendChild(el("div", "meta__text", p.text));

  const actions = el("div", "actions");
  const likeBtn = el("button", "btn btn--ghost", "点赞");
  likeBtn.onclick = async () => {
    await api(`/api/v1/posts/${p.id}/like`, { method: "POST", body: "{}" });
    await refresh();
  };
  actions.appendChild(likeBtn);

  const cmtBtn = el("button", "btn btn--ghost", "评论");
  cmtBtn.onclick = async () => {
    const text = prompt("写一句温柔的话（200 字以内）");
    if (!text) return;
    await api(`/api/v1/posts/${p.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    await refresh();
  };
  actions.appendChild(cmtBtn);

  if (isMyPost(p)) {
    const delBtn = el("button", "btn btn--danger", "删除");
    delBtn.onclick = async () => {
      if (!confirm("确定删除这条作品？")) return;
      await api(`/api/v1/posts/${p.id}`, { method: "DELETE" });
      await refresh();
    };
    actions.appendChild(delBtn);
  }

  meta.appendChild(actions);
  root.appendChild(thumb);
  root.appendChild(meta);
  return root;
}

function renderPollCard(pl) {
  const root = el("div", "post post--poll");
  root.setAttribute("role", "button");
  root.tabIndex = 0;
  const open = () => void openPollDrawer(pl);
  root.addEventListener("click", open);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const thumb = el("div", "thumb thumb--poll");
  const idx =
    pl.plazaPromoted && pl.promotedOptionIndex != null ? pl.promotedOptionIndex : pl.leadingOptionIndex;
  const lead = pl.options?.[idx];
  if (lead?.imageUrl) {
    const img = document.createElement("img");
    img.src = lead.imageUrl;
    img.alt = lead.name || "option";
    thumb.appendChild(img);
  } else {
    thumb.textContent = "🗳";
    thumb.setAttribute("aria-hidden", "true");
  }

  const meta = el("div", "meta");
  meta.appendChild(el("div", "meta__title", pl.title || "投票"));

  const row = el("div", "meta__row");
  row.appendChild(el("span", "pill", "投票街"));
  row.appendChild(el("span", "pill", pl.author?.displayName || "匿名"));
  row.appendChild(el("span", "pill", fmtTime(pl.createdAtMs)));
  row.appendChild(el("span", "pill", pollStatusText(pl)));
  row.appendChild(el("span", "pill", `总票数 ${pl.totalVotes ?? 0}`));
  meta.appendChild(row);

  const hint = pl.plazaPromoted
    ? "运维已将该投票胜选项亮相广场"
    : pl.isOpen
      ? "点击参与四选一（可改票至截止）"
      : "投票已截止，地图旁展示当前胜选项";
  meta.appendChild(el("div", "meta__hint", hint));

  const actions = el("div", "actions");
  if (isMyPoll(pl)) {
    const delBtn = el("button", "btn btn--danger", "删除");
    delBtn.type = "button";
    delBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!confirm("确定删除这条投票？所有票数会一并清空。")) return;
      try {
        await api(`/api/v1/polls/${encodeURIComponent(pl.id)}`, { method: "DELETE" });
        await refresh();
      } catch (e) {
        alert(e?.message || String(e));
      }
    };
    actions.appendChild(delBtn);
    meta.appendChild(actions);
  }

  root.appendChild(thumb);
  root.appendChild(meta);
  return root;
}

async function loadFeed({ append = false } = {}) {
  const qs = new URLSearchParams();
  qs.set("limit", "30");
  if (append && cursor) qs.set("cursor", cursor);
  const data = await api(`/api/v1/feed?${qs.toString()}`);

  let matchesForMap = [];
  try {
    const md = await api("/api/v1/matches");
    matchesForMap = (md.items || []).filter(
      (m) => !isDemoMatch(m) && (m.status === "open" || m.status === "running"),
    );
  } catch {
    matchesForMap = [];
  }

  const newPosts = data.items || [];
  let pollsBuf = [];
  if (!append) feedPostsBuffer = newPosts.slice();
  else feedPostsBuffer.push(...newPosts);
  cursor = data.nextCursor || null;

  try {
    const pmd = await api("/api/v1/polls");
    pollsBuf = pmd.items || [];
  } catch {
    pollsBuf = [];
  }
  if (!append) feedPollsBuffer = pollsBuf;
  else {
    /* 加载更多帖子时不重复追加全量投票列表 */
    feedPollsBuffer = pollsBuf;
  }

  let spyGamesBuf = [];
  try {
    const sd = await api("/api/v1/spy-games");
    spyGamesBuf = sd.items || [];
  } catch {
    spyGamesBuf = [];
  }

  if (worldState) {
    worldState.matches = matchesForMap;
    worldState.setPosts(feedPostsBuffer);
    worldState.setPolls(feedPollsBuffer);
    worldState.setSpyGames(spyGamesBuf);
  }
  rebuildFeedList();
}

async function refresh() {
  cursor = null;
  await loadFeed({ append: false });
}

function pill(text) {
  const s = document.createElement("span");
  s.className = "pill";
  s.textContent = text;
  return s;
}

function updateDrawerDeleteVisibility() {
  const delBtn = document.getElementById("drawerDelete");
  delBtn.classList.toggle("hidden", !isMyPost(selectedPost));
}

async function openDrawer(post) {
  selectedMatch = null;
  selectedPollId = null;
  setDrawerMode("post");
  selectedPost = post;
  selectedPostId = post.id;
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("hidden");
  document.getElementById("drawerTitle").textContent = post.title || "（无标题）";
  updateDrawerDeleteVisibility();

  const meta = document.getElementById("drawerMeta");
  meta.innerHTML = "";
  meta.appendChild(pill(post.type || "post"));
  meta.appendChild(pill(post.author?.displayName || "匿名"));
  meta.appendChild(pill(fmtTime(post.createdAtMs)));
  meta.appendChild(pill(`❤ ${post.likeCount || 0}`));
  meta.appendChild(pill(`💬 ${post.commentCount || 0}`));
  for (const t of post.tags || []) meta.appendChild(pill(`#${t}`));

  const body = document.getElementById("drawerBody");
  body.innerHTML = "";
  if (post.imageUrl) {
    const box = el("div", "drawer__img");
    const img = document.createElement("img");
    img.src = post.imageUrl;
    img.alt = post.title || "image";
    box.appendChild(img);
    body.appendChild(box);
  }
  if (post.text) body.appendChild(el("div", "drawer__text", post.text));

  await refreshComments();
  focusDrawerInRail();
}

async function syncDrawerIfOpen() {
  const drawer = document.getElementById("drawer");
  if (drawer.classList.contains("hidden")) return;
  if (drawerMode === "match" && selectedMatch?.id) {
    try {
      const data = await api(`/api/v1/matches/${selectedMatch.id}`);
      if (data?.item) await openMatchDrawer(data.item);
    } catch {
      /* ignore */
    }
    return;
  }
  if (drawerMode === "poll" && selectedPollId) {
    try {
      const data = await api(`/api/v1/polls/${selectedPollId}`);
      if (data?.item) await openPollDrawer(data.item);
    } catch {
      /* ignore */
    }
    return;
  }
  if (drawerMode === "spy" && selectedSpyGameId) {
    try {
      const data = await api(`/api/v1/spy-games/${selectedSpyGameId}`);
      if (data?.item) _renderSpyGameDrawer(data.item);
    } catch {
      /* ignore */
    }
    return;
  }
  if (!selectedPostId) return;
  const data = await api(`/api/v1/feed?limit=100`);
  const updated = (data.items || []).find((it) => it.id === selectedPostId);
  if (updated) await openDrawer(updated);
}

async function openPollDrawer(pl) {
  selectedPost = null;
  selectedPostId = null;
  selectedMatch = null;
  selectedPollId = pl.id;
  setDrawerMode("poll");

  let item = pl;
  try {
    const data = await api(`/api/v1/polls/${pl.id}`);
    if (data?.item) item = data.item;
  } catch {
    /* 使用传入快照 */
  }

  const drawer = document.getElementById("drawer");
  drawer.classList.remove("hidden");
  document.getElementById("drawerTitle").textContent = item.title || "投票";

  const meta = document.getElementById("drawerMeta");
  meta.innerHTML = "";
  meta.appendChild(pill("投票"));
  meta.appendChild(pill(item.author?.displayName || "匿名"));
  meta.appendChild(pill(fmtTime(item.createdAtMs)));
  meta.appendChild(pill(pollStatusText(item)));
  if (item.plazaPromoted) meta.appendChild(pill("广场亮相"));

  const ends = Number(item.endsAtMs) || 0;
  const body = document.getElementById("drawerBody");
  body.innerHTML = "";
  body.appendChild(
    el("div", "drawer__text", item.isOpen ? `进行中 · 截止 ${fmtTime(ends)}` : `已截止（${fmtTime(ends)}）`),
  );

  const grid = el("div", "drawer__pollGrid");
  (item.options || []).forEach((opt, i) => {
    const cell = el("div", "drawer__pollOpt");
    if (opt.imageUrl) {
      const wrap = el("div", "drawer__pollThumb");
      const img = document.createElement("img");
      img.src = opt.imageUrl;
      img.alt = opt.name || "";
      img.loading = "lazy";
      wrap.appendChild(img);
      cell.appendChild(wrap);
    }
    cell.appendChild(el("div", "drawer__pollOptName", opt.name || `选项 ${i + 1}`));
    cell.appendChild(el("div", "drawer__pollCount", `票数 ${opt.voteCount ?? 0}`));
    if (item.myVote === i) cell.classList.add("drawer__pollOpt--voted");
    const voteBtn = el("button", "btn btn--ghost btn--block", item.isOpen ? "投这一格" : "已截止");
    voteBtn.disabled = !item.isOpen;
    voteBtn.type = "button";
    voteBtn.onclick = async () => {
      if (!item.isOpen) return;
      try {
        await api(`/api/v1/polls/${item.id}/votes`, {
          method: "POST",
          body: JSON.stringify({ optionIndex: i }),
        });
        await refresh();
        const d2 = await api(`/api/v1/polls/${item.id}`);
        if (d2?.item) await openPollDrawer(d2.item);
      } catch (e) {
        alert(e?.message || String(e));
      }
    };
    cell.appendChild(voteBtn);
    grid.appendChild(cell);
  });
  body.appendChild(grid);

  const panel = document.getElementById("drawerPollPanel");
  panel.innerHTML = "";
  const lead = (item.options || [])[item.leadingOptionIndex];
  panel.appendChild(
    el(
      "p",
      "hint",
      `总票数 ${item.totalVotes ?? 0} · 当前领先：${lead?.name || "—"}${
        item.plazaPromoted ? " · 已由运维亮相广场" : ""
      }`,
    ),
  );

  if (isMyPoll(item)) {
    const row = el("div", "drawer__actions");
    const delBtn = el("button", "btn btn--danger", "删除投票");
    delBtn.type = "button";
    delBtn.onclick = async () => {
      if (!confirm("确定删除这条投票？所有票数会一并清空。")) return;
      try {
        await api(`/api/v1/polls/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        document.getElementById("drawer").classList.add("hidden");
        selectedPollId = null;
        setDrawerMode("post");
        await refresh();
      } catch (e) {
        alert(e?.message || String(e));
      }
    };
    row.appendChild(delBtn);
    panel.appendChild(row);
  }

  focusDrawerInRail();
}

async function openMatchDrawer(m) {
  selectedPollId = null;
  selectedPost = null;
  selectedPostId = null;
  setDrawerMode("match");

  let item = m;
  try {
    const data = await api(`/api/v1/matches/${m.id}`);
    if (data?.item) item = data.item;
  } catch {
    /* 使用传入快照 */
  }
  selectedMatch = item;

  const drawer = document.getElementById("drawer");
  drawer.classList.remove("hidden");
  document.getElementById("drawerTitle").textContent = `${matchRuleLabel(item.rule)} · ${matchStatusZh(item.status)}`;

  const meta = document.getElementById("drawerMeta");
  meta.innerHTML = "";
  meta.appendChild(pill(item.id));
  meta.appendChild(pill(item.rule != null && String(item.rule).trim() !== "" ? String(item.rule) : "—"));

  const body = document.getElementById("drawerBody");
  body.innerHTML = "";
  body.appendChild(el("div", "drawer__text", formatMatchRoster(item)));

  const openBoard = document.getElementById("drawerOpenBoard");
  const noBoard = document.getElementById("drawerNoBoardHint");
  const page = matchBoardPage(item.rule);
  if (page) {
    openBoard.href = `${page}?match=${encodeURIComponent(item.id)}`;
    openBoard.textContent = "打开观战页";
    openBoard.classList.remove("hidden");
    noBoard.classList.add("hidden");
    noBoard.textContent = "";
  } else {
    openBoard.removeAttribute("href");
    openBoard.classList.add("hidden");
    const rid = item.rule && String(item.rule).trim() ? String(item.rule) : "（服务端默认）";
    noBoard.textContent = `当前规则「${rid}」尚无独立网页棋盘；可复制场次 ID，由 Agent 用 GET …/matches/<id>?forAgent=1 等 API 接入，或待该玩法上线观战页。`;
    noBoard.classList.remove("hidden");
  }
  focusDrawerInRail();
}

let selectedSpyGameId = null;
let spyGamePollTimer = null;

async function openSpyGameDrawer(sg) {
  selectedPollId = null;
  selectedPost = null;
  selectedPostId = null;
  selectedMatch = null;
  setDrawerMode("spy");
  selectedSpyGameId = sg.id;

  if (spyGamePollTimer) { clearInterval(spyGamePollTimer); spyGamePollTimer = null; }

  let item = sg;
  try {
    const data = await api(`/api/v1/spy-games/${sg.id}`);
    if (data?.item) item = data.item;
  } catch {
    /* 使用传入快照 */
  }

  _renderSpyGameDrawer(item);

  // 游戏进行中时每 5 秒刷新
  if (item.status === "playing") {
    spyGamePollTimer = setInterval(async () => {
      try {
        const data = await api(`/api/v1/spy-games/${selectedSpyGameId}`);
        if (data?.item) {
          _renderSpyGameDrawer(data.item);
          if (data.item.status !== "playing") {
            clearInterval(spyGamePollTimer);
            spyGamePollTimer = null;
          }
        }
      } catch { /* ignore */ }
    }, 5000);
  }
}

function _renderSpyGameDrawer(item) {
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("hidden");

  const statusZh = item.status === "waiting" ? "招募中" : item.status === "playing" ? "进行中" : "已结束";
  document.getElementById("drawerTitle").textContent = `谁是卧底 · ${statusZh}`;

  const meta = document.getElementById("drawerMeta");
  meta.innerHTML = "";
  meta.appendChild(pill("卧底"));
  meta.appendChild(pill(`第 ${item.round || 0} 轮`));
  meta.appendChild(pill(`${(item.players || []).length}/${item.maxPlayers || 8}人`));

  const body = document.getElementById("drawerBody");
  body.innerHTML = "";

  // 游戏结束：显示结果
  if (item.status === "finished") {
    const winText = item.winner === "civilian" ? "平民胜利" : item.winner === "spy" ? "卧底胜利" : "平局";
    const reasonText = item.winReason === "spy_eliminated" ? "卧底全部被淘汰"
      : item.winReason === "spy_dominant" ? "卧底人数≥平民"
      : item.winReason === "max_rounds" ? "达到最大轮数"
      : "";
    body.appendChild(el("div", "drawer__text", `${winText}（${reasonText}）`));
    if (item.civilianWord) body.appendChild(el("div", "drawer__text", `平民词：${item.civilianWord}`));
    if (item.spyWord) body.appendChild(el("div", "drawer__text", `卧底词：${item.spyWord}`));
  }

  // 玩家列表
  const plist = el("div", "drawer__playerList");
  for (const p of (item.players || [])) {
    const row = el("div", "drawer__playerRow");
    const name = el("span", "drawer__playerName", p.displayName || p.userId);
    if (p.eliminated) name.style.textDecoration = "line-through";
    row.appendChild(name);
    if (p.isSpy != null) {
      row.appendChild(el("span", "pill", p.isSpy ? "卧底" : "平民"));
    }
    if (p.word) {
      row.appendChild(el("span", "pill", `词：${p.word}`));
    }
    if (p.eliminated) {
      row.appendChild(el("span", "pill", "已淘汰"));
    }
    plist.appendChild(row);
  }
  body.appendChild(plist);

  // 招募中：显示加入/开始按钮
  if (item.status === "waiting") {
    const n = (item.players || []).length;
    const mx = item.maxPlayers || 8;
    body.appendChild(el("div", "drawer__text", `等待玩家加入（${n}/${mx}人，至少4人）`));
    const btnRow = el("div", "drawer__btnRow");
    const joinBtn = el("button", "btn", "加入游戏");
    joinBtn.onclick = async () => {
      try {
        const data = await api(`/api/v1/spy-games/${item.id}/join`, { method: "POST" });
        if (data?.item) { _renderSpyGameDrawer(data.item); await refresh(); }
      } catch (e) {
        alert(e?.message || "加入失败");
      }
    };
    btnRow.appendChild(joinBtn);

    if (n >= 4) {
      const startBtn = el("button", "btn btn--primary", "开始游戏");
      startBtn.onclick = async () => {
        try {
          const data = await api(`/api/v1/spy-games/${item.id}/start`, { method: "POST" });
          if (data?.item) { _renderSpyGameDrawer(data.item); await refresh(); }
        } catch (e) {
          alert(e?.message || "开始失败");
        }
      };
      btnRow.appendChild(startBtn);
    }
    body.appendChild(btnRow);
  }

  // 描述阶段
  if (item.status === "playing" && item.currentPhase === "describe") {
    const descSection = el("div", "drawer__descSection");
    descSection.appendChild(el("div", "drawer__sectionTitle", `第 ${item.round} 轮 · 描述阶段`));

    // 已有描述
    for (const d of (item.descriptions || [])) {
      const dRound = d.round === item.round;
      if (!dRound) continue;
      const p = (item.players || []).find(p => p.userId === d.userId);
      const row = el("div", "drawer__descRow");
      row.appendChild(el("span", "drawer__descName", p?.displayName || d.userId));
      row.appendChild(el("span", "drawer__descText", d.text));
      if (d.innerMonologue) {
        row.appendChild(el("span", "drawer__innerMono", `💭 ${d.innerMonologue}`));
      }
      descSection.appendChild(row);
    }

    // 当前轮到谁
    if (item.currentTurnUserId) {
      const currentP = (item.players || []).find(p => p.userId === item.currentTurnUserId);
      descSection.appendChild(el("div", "drawer__turnHint", `轮到：${currentP?.displayName || item.currentTurnUserId}`));
    }

    body.appendChild(descSection);
  }

  // 投票阶段
  if (item.status === "playing" && item.currentPhase === "vote") {
    const voteSection = el("div", "drawer__voteSection");
    voteSection.appendChild(el("div", "drawer__sectionTitle", `第 ${item.round} 轮 · 投票阶段`));

    // 已投票情况
    const voted = new Set((item.votes || []).map(v => v.voterId));
    for (const p of (item.players || [])) {
      if (p.eliminated) continue;
      const row = el("div", "drawer__voteRow");
      row.appendChild(el("span", "drawer__playerName", p.displayName || p.userId));
      if (voted.has(p.userId)) {
        const vote = (item.votes || []).find(v => v.voterId === p.userId);
        const target = (item.players || []).find(tp => tp.userId === vote?.targetId);
        row.appendChild(el("span", "pill", `→ ${target?.displayName || vote?.targetId}`));
        if (vote?.innerMonologue) {
          row.appendChild(el("span", "drawer__innerMono", `💭 ${vote.innerMonologue}`));
        }
      } else {
        row.appendChild(el("span", "pill", "未投票"));
      }
      voteSection.appendChild(row);
    }

    body.appendChild(voteSection);
  }

  const openBoard = document.getElementById("drawerOpenBoard");
  const noBoard = document.getElementById("drawerNoBoardHint");
  if (item.status === "playing" || item.status === "finished") {
    openBoard.href = `/spy.html?game=${encodeURIComponent(item.id)}`;
    openBoard.textContent = "打开观战页";
    openBoard.classList.remove("hidden");
    noBoard.classList.add("hidden");
    noBoard.textContent = "";
  } else {
    openBoard.classList.add("hidden");
    openBoard.removeAttribute("href");
    noBoard.textContent = "谁是卧底 — Agent 通过 API 参与，人类围观。";
    noBoard.classList.remove("hidden");
  }
  // Show the match panel (contains openBoard) for spy games too
  document.querySelectorAll("[data-drawer-match-only]").forEach((el) => {
    el.classList.toggle("hidden", false);
  });

  focusDrawerInRail();
}

async function refreshComments() {
  if (!selectedPostId) return;
  const list = document.getElementById("drawerComments");
  list.innerHTML = "";
  const data = await api(`/api/v1/posts/${selectedPostId}/comments`);
  for (const c of data.items || []) {
    const item = el("div", "drawer__comment");
    const meta = el("div", "drawer__commentMeta");
    meta.appendChild(el("span", null, c.author?.displayName || "匿名"));
    meta.appendChild(el("span", null, fmtTime(c.createdAtMs)));
    item.appendChild(meta);
    item.appendChild(el("div", "drawer__commentText", c.text || ""));
    list.appendChild(item);
  }
}

/** 画布物理像素倍数：改善高分屏发糊（上限避免显卡压力过大） */
function getSquarePixelRatio() {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(2.25, dpr));
}

function formatRoyaleClock(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (days > 0) {
    return `${days}天 ${String(hours).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  if (hours > 0) {
    return `${hours}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function initWorld() {
  const container = document.getElementById("world");
  container.innerHTML = "";

  const state = {
    posts: [],
    matches: [],
    polls: [],
    spyGames: [],
    stallZoneFilter: "all",
    setPosts(items) {
      this.posts = items || [];
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.polls, this.spyGames, this.stallZoneFilter);
    },
    setPolls(items) {
      this.polls = items || [];
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.polls, this.spyGames, this.stallZoneFilter);
    },
    setSpyGames(items) {
      this.spyGames = items || [];
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.polls, this.spyGames, this.stallZoneFilter);
    },
    setStallZoneFilter(zone) {
      const ok = new Set(["all", "vote", "avatar", "match", "forum"]);
      this.stallZoneFilter = ok.has(zone) ? zone : "all";
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.polls, this.spyGames, this.stallZoneFilter);
      rebuildFeedList();
    },
  };

  let sceneRef = null;
  /** 广场地图默认缩放约 0.58；投票截止后胜选项在地图留影时长 */
  const POLL_WINNER_PLAZA_LINGER_MS = 86400000;
  /** 动物进入分区水池后，在此时间内留在水中，期满才被推到岸上 */
  const PLAZA_POOL_ESCAPE_MS = 5000;
  /** 四分区景观水池面积相对原设计的倍数（线尺度 = √面积倍数） */
  const PLAZA_ZONE_POOL_AREA_MULT = 1.5;
  const PLAZA_ZONE_POOL_LINEAR_SCALE = Math.sqrt(PLAZA_ZONE_POOL_AREA_MULT);
  const MAX_LIZARDS = 7;
  /** 蜥蜴体色：绿 / 黄 / 白 / 橘（浅色底图 + setTint） */
  const LIZARD_TINTS = [0x4caf50, 0xffd54f, 0xf5f5f5, 0xff922b];
  /** 地图上可同时存在的蜥蜴蛋上限（需 ≥ 每窝颗数） */
  const MAX_LIZARD_EGGS_WORLD = 20;
  /** 单次产卵颗数 */
  const LIZARD_EGGS_PER_LAY = 5;
  const LIZARD_EGG_HATCH_MS = 10_000;
  const LIZARD_EGG_DOUBLE_HATCH_CHANCE = 0.13;
  const EGG_EAT_DIST = 11;
  const MOUSE_SNAKE_EGG_EAT_COOLDOWN_MS = 300_000;
  const SNAKE_EAT_LIZARD_COOLDOWN_MS = 1400;
  /** 牛蛙：游荡上岸距岸 5–10px；离水池边界最外不得超过 10px（含追猎） */
  const FROG_SHORE_OUT_MIN = 5;
  const FROG_SHORE_OUT_MAX = 10;
  /** 分区水池内鱼：每池上限、起始数量、繁殖与猫捕鱼周期 */
  const MAX_FISH_PER_POOL = 5;
  const POND_FISH_START = 3;
  const FISH_BREED_DIST = 14;
  const FISH_EGG_HATCH_MS = 10_000;
  const FISH_BREED_COOLDOWN_MS = 8000;
  const FISH_SWIM_SPEED = 16;
  const FISH_MATURE_MS = 14_000;
  const CAT_FISH_INTERVAL_MS = 120_000;
  const CAT_COUNT = 2;
  const POND_FISH_TINTS = [
    0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xc56cf0, 0xff922b, 0x95e1d3, 0xf38ba8, 0xe63946, 0x2a9d8f,
  ];
  /** 鼠/蟑钻井盖：入口半径、冷却；遇险时优先跑向最近井盖 */
  const MANHOLE_ENTRY_RADIUS = 14;
  const MANHOLE_COOLDOWN_MS = 3200;
  const MOUSE_MANHOLE_PANIC_CAT = 58;
  const MOUSE_MANHOLE_PANIC_SNAKE = 102;
  const MOUSE_MANHOLE_PANIC_FROG = 96;
  const ROACH_MANHOLE_PANIC_LIZARD = 54;
  const ROACH_MANHOLE_PANIC_SNAKE = 50;
  const ROACH_MANHOLE_PANIC_FROG = 92;
  /**
   * 「虾扯蛋」：鱼卵先到池边再甩绳、蜥蜴蛋先近身再甩绳；蛋进摊位篓子，单摊集满 STALL_EGG_BATCH_COUNT 颗后结算——蜥蜴蛋全部孵化跑路，鱼卵再一条条孵化并由虾吃掉。
   * 参数字面量仍用 STALL_SHRIMP_* 表示拖蛋运动学参数。
   */
  const STALL_SHRIMP_PULL_SPEED = 46;
  const STALL_SHRIMP_APPROACH_DIST = 24;
  const STALL_EGG_DELIVER_DIST = 32;
  /** 「虾扯蛋」每个摊位集满颗数后一次性结算（先蜥蜴后小鱼） */
  const STALL_EGG_BATCH_COUNT = 10;
  /** 摆摊虾：每分钟随机一只去湖里乘凉；50% 几率吃一条小鱼 */
  const STALL_SHRIMP_COOLOFF_INTERVAL_MS = 60_000;
  const STALL_SHRIMP_COOLOFF_IN_POOL_MS = 10_000;
  const STALL_SHRIMP_COOLOFF_EAT_FISH_CHANCE = 0.5;
  const STALL_SHRIMP_COOLOFF_SPEED = 42;
  /** 牛蛙咬死摆摊虾；死虾旁聚满蟑螂后消失并由新虾从广场外接管 */
  const FROG_KILL_STALL_SHRIMP_CHANCE = 0.5;
  /** 死虾气味：全广场蟑螂主动趋近；近尸时减速啃食，略减蜥蜴/蛇驱赶 */
  const DEAD_SHRIMP_ROACH_SEEK_SPEED_MULT = 1.85;
  const DEAD_SHRIMP_ROACH_EAT_DIST = 14;
  const DEAD_SHRIMP_ROACH_FEED_SLOW_MULT = 0.2;
  const DEAD_SHRIMP_ROACH_FLEE_REDUCE_DIST = 72;
  const DEAD_SHRIMP_ROACH_FLEE_REDUCE = 0.38;
  const DEAD_SHRIMP_ROACH_GATHER_DIST = 40;
  const DEAD_SHRIMP_ROACH_GATHER_COUNT = 20;
  const STALL_SHRIMP_REPLACEMENT_SPEED = 34;
  /** 麻雀：共 10 只；低于 5 只时在树上产卵，30s 后仅一颗孵化 */
  const MAX_SPARROWS = 10;
  const SPARROW_LAY_THRESHOLD = 5;
  const SPARROW_EGGS_PER_LAY = 4;
  const SPARROW_EGG_HATCH_MS = 30_000;
  const SPARROW_ROACH_HUNT_RANGE = 150;
  const SPARROW_ROACH_EAT_DIST = 9;
  const SPARROW_FLY_SPEED = 40;
  const SPARROW_LAND_SPEED = 20;
  const SPARROW_PREDATOR_AGRO = 78;
  const SPARROW_CATCH_DIST = 14;
  const SPARROW_CATCH_CHANCE = 0.8;
  const SPARROW_ESCAPE_FLY_MS = 4200;
  const SPARROW_LAND_MIN_MS = 2200;
  const SNAKE_EAT_SPARROW_EGG_COOLDOWN_MS = 60_000;
  const SPARROW_EGG_EAT_DIST = 12;
  /** 蟑螂大逃杀：刷新后先空等 10 天，再开场 5 分钟；猎食者累计 >100 只或蟑灭则胜 */
  const ROACH_ROYALE_CYCLE_MS = 10 * 24 * 60 * 60 * 1000;
  const ROACH_ROYALE_DURATION_MS = 300_000;
  const ROACH_ROYALE_PERIOD_MS = ROACH_ROYALE_CYCLE_MS + ROACH_ROYALE_DURATION_MS;
  const ROACH_ROYALE_MAX_ROACHES = 150;
  const ROACH_ROYALE_BREED_BATCH = 5;
  const ROACH_ROYALE_WIN_KILLS = 100;
  const ROACH_ROYALE_TROPHY_MS = 180_000;
  const ROACH_ROYALE_FLEE_SPEED_MULT = 2.35;
  const ROACH_ROYALE_FLEE_ACCEL_MULT = 1.85;
  const ROACH_ROYALE_PREDATOR_AGRO_MULT = 1.65;
  const ROACH_ROYALE_MOUSE_EAT_COOLDOWN_MS = 650;
  const MAX_ROACHES_NORMAL = 96;
  const ROACH_LAST_STAND_BROOD_NORMAL = 10;
  const ROACH_BREED_BATCH_NORMAL = 3;
  /** 狗：追猫 / 蛇 / 牛蛙；抓到不杀猎物；未抓到或抓到后休息 5 分钟；老鼠碰狗即消失且不躲狗 */
  const DOG_REST_MS = 300_000;
  const DOG_HUNT_TIMEOUT_MS = 90_000;
  const DOG_CATCH_DIST = 15;
  const DOG_MOUSE_EAT_DIST = 11;
  const DOG_HUNT_SPEED = 40;
  const DOG_REST_SPEED = 16;
  const DOG_FLEE_RANGE = 78;
  const DOG_FLEE_SPEED = 54;
  /** 动物整体移速略提；转向用惯性插值，减少“瞬移拐弯”感 */
  const ANIMAL_SPEED_MULT = 1.22;
  const ANIMAL_STEER_ACCEL = 9.5;
  /** 鸡：最多 7 只；吃蟑螂；生蛋；狗每 5 分钟追 1 次（不吃），被追满 5 次后死亡 */
  const MAX_CHICKENS = 7;
  const CHICKEN_SPEED = 24;
  const CHICKEN_ROACH_HUNT_RANGE = 100;
  const CHICKEN_ROACH_EAT_DIST = 10;
  const CHICKEN_LAY_INTERVAL_MS = 50_000;
  const CHICKEN_EGG_HATCH_MS = 22_000;
  const DOG_CHICKEN_CHASE_INTERVAL_MS = 300_000;
  const DOG_CHICKEN_CATCH_DIST = 16;
  const CHICKEN_DOG_CHASEES_TO_DIE = 5;
  const CHICKEN_FLEE_DOG_SPEED = 38;
  const APPLE_DROP_MIN_MS = 5500;
  const APPLE_DROP_JITTER_MS = 9000;
  const APPLE_MAX_WORLD = 20;
  const APPLE_FALL_GRAV = 420;
  const APPLE_FALL_V0 = 8;
  const APPLE_ANIMAL_SEEK_RANGE = 105;
  const APPLE_EAT_DIST = 11;
  const APPLE_FISH_SEEK_RANGE = 72;
  const APPLE_FISH_EAT_DIST = 13;
  /** 羊：2 只；一次只啃一块草坪、一次吃一格；吃掉后 5 分钟长回 */
  const SHEEP_COUNT = 2;
  const SHEEP_SPEED = 17;
  const SHEEP_EAT_DIST = 9;
  const SHEEP_EAT_COOLDOWN_MS = 480;
  const SHEEP_GRASS_REGROW_MS = 300_000;
  /** 黄鼠狼：2 只；吃鸡；吃鸡时狗追但不杀；进不了栏杆 */
  const WEASEL_COUNT = 2;
  const WEASEL_SPEED = 28;
  const WEASEL_HUNT_RANGE = 130;
  const WEASEL_EAT_DIST = 12;
  const WEASEL_FLEE_DOG_SPEED = 42;
  const WEASEL_FLEE_AFTER_DOG_MS = 5500;
  const DOG_WEASEL_CATCH_DIST = 15;
  const CHICKEN_FLEE_WEASEL_RANGE = 70;
  const CHICKEN_FLEE_WEASEL_SPEED = 36;

  function makeTexture(scene, key, w, h, painter) {
    const g = scene.make.graphics({ x: 0, y: 0, add: false });
    painter(g);
    g.generateTexture(key, w, h);
    g.destroy();
  }

  function plazaPointInPolygon(x, y, verts) {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const xi = verts[i].x;
      const yi = verts[i].y;
      const xj = verts[j].x;
      const yj = verts[j].y;
      const denom = yj - yi || 1e-12;
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / denom + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function plazaClosestOnSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby || 1;
    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + abx * t, y: ay + aby * t };
  }

  /**
   * 广场地图上展示的像素图：应尽量上传 **带 Alpha 的 PNG**。
   * 对矩形实心背景图，用语义上的四角取样估计底色并在容差内抠成透明（JPG / 未抠图兜底）。
   * @returns 是否已向 `destKey` 注册了 CanvasTexture
   */
  function plazaKnockOutFlatBackdrop(scene, sourceKey, destKey) {
    const tm = scene.textures;
    if (!tm || !tm.exists(sourceKey)) return false;
    let imgEl = null;
    let cw = 0;
    let ch = 0;
    try {
      const tex = tm.get(sourceKey);
      imgEl =
        typeof tex.getSourceImage === "function"
          ? tex.getSourceImage()
          : tex.get().source.image;
      cw = imgEl?.naturalWidth || imgEl?.width || 0;
      ch = imgEl?.naturalHeight || imgEl?.height || 0;
      if (!imgEl || !cw || !ch) return false;
    } catch {
      return false;
    }
    const pad = clamp(Math.round(Math.min(cw, ch) * 0.015), 1, Math.max(6, cw));
    /** @type {HTMLCanvasElement} */
    const can = typeof document !== "undefined" ? document.createElement("canvas") : null;
    if (!can || !can.getContext) return false;
    can.width = cw;
    can.height = ch;
    const ctx = can.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(imgEl, 0, 0, cw, ch);
    let data;
    try {
      data = ctx.getImageData(0, 0, cw, ch);
    } catch {
      return false;
    }
    const d = data.data;
    const samp = [];
    const take = (x, y) => {
      const xi = clamp(x, 0, cw - 1);
      const yi = clamp(y, 0, ch - 1);
      const j = (yi * cw + xi) * 4;
      samp.push([d[j], d[j + 1], d[j + 2]]);
    };
    take(pad, pad);
    take(cw - 1 - pad, pad);
    take(pad, ch - 1 - pad);
    take(cw - 1 - pad, ch - 1 - pad);
    let br = 0;
    let bg = 0;
    let bb = 0;
    for (const c of samp) {
      br += c[0];
      bg += c[1];
      bb += c[2];
    }
    const n = samp.length || 1;
    br /= n;
    bg /= n;
    bb /= n;
    const tol = 50;
    for (let i = 0; i < d.length; i += 4) {
      const rd = Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb);
      if (rd <= tol) d[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    if (tm.exists(destKey)) tm.remove(destKey);
    tm.addCanvas(destKey, can);
    return tm.exists(destKey);
  }

  function plazaPushOutPolygon(verts, x, y, pad) {
    if (!plazaPointInPolygon(x, y, verts)) return { x, y };
    let bestQx = x;
    let bestQy = y;
    let bestD = Infinity;
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % n];
      const q = plazaClosestOnSegment(x, y, a.x, a.y, b.x, b.y);
      const d = Math.hypot(x - q.x, y - q.y);
      if (d < bestD) {
        bestD = d;
        bestQx = q.x;
        bestQy = q.y;
      }
    }
    let nx = x - bestQx;
    let ny = y - bestQy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    return { x: bestQx + nx * pad, y: bestQy + ny * pad };
  }

  class PlazaScene extends Phaser.Scene {
    constructor() {
      super("plaza");
      this.booths = [];
      /** @type {{ sprite: Phaser.GameObjects.Image, chaseMouse: any, chaseSparrow: any, fishing: any, nextFishAt: number }[]} */
      this.cats = [];
      /** 兼容旧引用：始终指向第一只猫的 sprite */
      this.cat = null;
      /** @type {{ sprite: Phaser.GameObjects.Image, home: {x:number,y:number}, target: {x:number,y:number}, retargetAt: number }[]} */
      this.lizards = [];
      this.mice = [];
      this.roaches = [];
      this.roachBreedLock = 0;
      this.snakes = [];
      /** 牛蛙：活动在水池内/旁；捕食除猫、蛇外的动物 */
      this.frogs = [];
      this.mouseBreedLock = 0;
      /** 老鼠随机游荡的轴对齐范围（与相机大地砖边界一致，留边避免贴边） */
      this.mouseRoam = null;
      /** 摊位前的虾 / 棋子等小 NPC（与猫鼠蜥蜴一样受喷泉弹射） */
      this.boothNpcs = [];
      /** 「虾扯蛋」：可拖蛋的摆摊小龙虾锚点（竞技场棋子摊除外）；含摊位中心与小虾归位坐标 */
      this.stallShrimpSites = [];
      /** 下一分钟触发「随机一只摆摊虾去湖里乘凉」的时刻 */
      this._nextStallShrimpCooloffAt = 0;
      /** 中心喷泉 (0,0) 贴图约 40px；进入此半径则弹到内层分区铺砖格上（不外飞到外围大地砖） */
      this.fountainTeleportRadius = 34;
      /** 喷泉内池动态水面（每帧 redraw） */
      this.fountainWaterG = null;
      /** create() 里填入：主广场四分区所在瓷砖网格（与 tileA/tileB 范围一致） */
      this.plazaTileGrid = null;
      /** 可爬的树（树干接地点，与 placeTree 的 x,y 一致） */
      this.treeSpots = [];
      /** 蜥蜴爬树 / 猫上树：猫上树后蜥蜴立刻逃走，猫独自在树上等 10s */
      this.arboreal = null;
      this._arborealCooldownUntil = 0;
      /** 主广场可行走矩形（核心 tileA/tileB 区，不含外围大地砖）；create() 赋值 */
      this.plazaWalkBounds = null;
      /** create() 写入：广场相对初版边长倍数，水池/摊位/碰撞垫等与坐标一致 */
      this.plazaScale = 1;
      /** 四分区景观水池（随机形状）；动物不可进入，目标点也会避开 */
      this.plazaPools = [];
      /** 蜥蜴蛋：约 10s 孵化；每次产 LIZARD_EGGS_PER_LAY 颗，总数受 MAX_LIZARD_EGGS_WORLD 限制 */
      this.lizardEggs = [];
      this._nextLizardEggLayAt = 0;
      /** 分区水池内的鱼（sprite 在水面下、flow 之上） */
      this.pondFish = [];
      this.pondFishEggs = [];
      /** 井盖世界坐标（与 create 里 manhole 圆心一致），供鼠蟑传送与寻路 */
      this.manholes = [];
      /** 麻雀：飞行时可穿任意景物；落地捕蟑，遭猫/蛇追猎 */
      this.sparrows = [];
      /** 麻雀蛋（须在树上；每窝仅一颗会孵化） */
      this.sparrowEggs = [];
      this._nextSparrowEggLayAt = 0;
      /** 鸡：吃蟑螂、生蛋；狗周期性驱赶 */
      this.chickens = [];
      this.chickenEggs = [];
      this._nextChickenLayAt = 0;
      /** 树上随机掉落的苹果（落地或落水后会被动物取食） */
      this.fallenApples = [];
      this._nextAppleDropAt = 0;
      /** 草坪块：每块含若干格；可被羊吃掉并定时长回 */
      this.lawnPatches = [];
      /** 栏杆围起的禁区（AABB）；动物不可进入 */
      this.fencePaddocks = [];
      /** 羊：啃草 */
      this.sheep = [];
      /** 黄鼠狼：吃鸡；进不了栏杆 */
      this.weasels = [];
      /** 狗：追猫/蛇/牛蛙；休息时游荡 */
      this.dog = null;
      /** 点击狗后进入「点选猎物」模式，再点老鼠/蜥蜴/蟑螂即可吃掉 */
      this.dogSelectArmed = false;
      /** 蟑螂大逃杀周期与战果 */
      this._roachRoyaleCycleStartAt = 0;
      this._roachRoyaleCycleIndex = -1;
      this._roachRoyaleActive = false;
      this._roachRoyaleEndedEarly = false;
      this._roachRoyaleKills = 0;
      this._roachRoyaleBanner = null;
      /** @type {{ sprite: Phaser.GameObjects.Image, trophy: Phaser.GameObjects.Image, baseScale: number, endAt: number }[]} */
      this._roachRoyaleTrophyBoosts = [];
    }

    nearestManholeTo(x, y) {
      if (!this.manholes || !this.manholes.length) return null;
      let best = this.manholes[0];
      let bestD = Math.hypot(x - best.x, y - best.y);
      for (let i = 1; i < this.manholes.length; i++) {
        const h = this.manholes[i];
        const d = Math.hypot(x - h.x, y - h.y);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      return best;
    }

    /** 从入口 excludeManholeIndex 钻入后，随机从其他井盖 / 水池内或岸 / 喷泉内出现 */
    randomManholeTunnelExit(excludeManholeIndex) {
      const candidates = [];
      for (let i = 0; i < (this.manholes || []).length; i++) {
        if (i === excludeManholeIndex) continue;
        const h = this.manholes[i];
        candidates.push({
          x: h.x + (Math.random() - 0.5) * 10,
          y: h.y + (Math.random() - 0.5) * 10,
        });
      }
      for (const pool of this.plazaPools || []) {
        if (Math.random() < 0.52) {
          candidates.push(this.randomPointInsidePlazaPool(pool));
        } else {
          candidates.push(this.randomPointNearPlazaPool(pool));
        }
      }
      const ps = this.plazaScale || 1;
      const ang = Math.random() * Math.PI * 2;
      const rr = (4 + Math.random() * 10) * Math.min(1.1, ps);
      candidates.push({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr });
      if (!candidates.length) return this.randomPlazaWalkPointAvoidingPools();
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    findManholeIndexAt(x, y) {
      let best = -1;
      let bestD = MANHOLE_ENTRY_RADIUS;
      for (let i = 0; i < (this.manholes || []).length; i++) {
        const h = this.manholes[i];
        const d = Math.hypot(x - h.x, y - h.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    mouseSeeksManhole(m, catX, catY, now) {
      const mx = m.sprite.x;
      const my = m.sprite.y;
      if (this.anyCatChasingMouse(m.sprite)) return true;
      if (Math.hypot(catX - mx, catY - my) < MOUSE_MANHOLE_PANIC_CAT) return true;
      for (const snk of this.snakes || []) {
        if (Math.hypot(snk.sprite.x - mx, snk.sprite.y - my) < MOUSE_MANHOLE_PANIC_SNAKE) return true;
      }
      for (const fr of this.frogs || []) {
        const fp = fr.sprite;
        if (!fp || !fp.active) continue;
        if (Math.hypot(fp.x - mx, fp.y - my) < MOUSE_MANHOLE_PANIC_FROG) return true;
      }
      return false;
    }

    createCatAt(x, y) {
      const sprite = this.add
        .image(x, y, "cat")
        .setOrigin(0.5)
        .setDepth(15)
        .setScale(1.18);
      return {
        sprite,
        chaseMouse: null,
        chaseSparrow: null,
        fishing: null,
        nextFishAt: 0,
        vx: 0,
        vy: 0,
      };
    }

    syncPrimaryCat() {
      this.cat = this.cats.find((c) => c.sprite?.active)?.sprite || null;
    }

    activeCatEntries() {
      return (this.cats || []).filter((c) => c.sprite?.active);
    }

    nearestCatEntry(x, y) {
      let best = null;
      let bestD = Infinity;
      for (const c of this.activeCatEntries()) {
        const d = Math.hypot(c.sprite.x - x, c.sprite.y - y);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    }

    anyCatChasingMouse(sprite) {
      return this.activeCatEntries().some((c) => c.chaseMouse === sprite);
    }

    anyCatChasingSparrow(sprite) {
      return this.activeCatEntries().some((c) => c.chaseSparrow === sprite);
    }

    clearCatChaseOfMouse(sprite) {
      for (const c of this.cats || []) {
        if (c.chaseMouse === sprite) c.chaseMouse = null;
      }
    }

    clearCatChaseOfSparrow(sprite) {
      for (const c of this.cats || []) {
        if (c.chaseSparrow === sprite) c.chaseSparrow = null;
      }
    }

    clearAllCatChases() {
      for (const c of this.cats || []) {
        c.chaseMouse = null;
        c.chaseSparrow = null;
      }
    }

    /**
     * 朝目标方向平滑加速（惯性转向），返回本帧位移与当前速度。
     * @param {{ vx?: number, vy?: number }} body
     */
    smoothSteer(body, dirX, dirY, speed, dt, accel = ANIMAL_STEER_ACCEL) {
      const len = Math.hypot(dirX, dirY);
      const tvx = len > 0.001 ? (dirX / len) * speed : 0;
      const tvy = len > 0.001 ? (dirY / len) * speed : 0;
      if (body.vx == null || Number.isNaN(body.vx)) body.vx = tvx;
      if (body.vy == null || Number.isNaN(body.vy)) body.vy = tvy;
      const k = 1 - Math.exp(-accel * dt);
      body.vx += (tvx - body.vx) * k;
      body.vy += (tvy - body.vy) * k;
      return { dx: body.vx * dt, dy: body.vy * dt, vx: body.vx, vy: body.vy };
    }

    applyAnimalFlip(sprite, body, fallbackLeft) {
      if (!sprite) return;
      if (body && Math.abs(body.vx) > 1.2) sprite.setFlipX(body.vx < 0);
      else if (fallbackLeft != null) sprite.setFlipX(!!fallbackLeft);
    }

    findNearestRoachPrey(x, y, maxDist = Infinity) {
      let best = null;
      let bestD = maxDist;
      for (const ro of this.roaches || []) {
        if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
        const d = Math.hypot(ro.sprite.x - x, ro.sprite.y - y);
        if (d < bestD) {
          bestD = d;
          best = ro;
        }
      }
      return best;
    }

    plazaPoolIndexAt(x, y) {
      if (!this.plazaPools?.length) return -1;
      for (let i = 0; i < this.plazaPools.length; i++) {
        if (this.pointInPlazaPool(this.plazaPools[i], x, y)) return i;
      }
      return -1;
    }

    findNearestLandApple(x, y, maxDist = Infinity) {
      let bestI = -1;
      let bestD = maxDist;
      for (let i = 0; i < (this.fallenApples || []).length; i++) {
        const ap = this.fallenApples[i];
        if (!ap.landed || ap.inWater || !ap.sprite?.active) continue;
        const d = Math.hypot(ap.sprite.x - x, ap.sprite.y - y);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI < 0) return null;
      return { ap: this.fallenApples[bestI], index: bestI, dist: bestD };
    }

    removeFallenAppleAt(index) {
      const ap = this.fallenApples[index];
      ap?.sprite?.destroy();
      this.fallenApples.splice(index, 1);
    }

    tryEatLandApple(x, y, eatDist) {
      const list = this.fallenApples || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const ap = list[i];
        if (!ap.landed || ap.inWater || !ap.sprite?.active) continue;
        if (Math.hypot(ap.sprite.x - x, ap.sprite.y - y) < eatDist) {
          this.removeFallenAppleAt(i);
          return true;
        }
      }
      return false;
    }

    createFallenAppleDrop(x, y, groundY) {
      const sprite = this.add
        .image(x, y, "apple")
        .setOrigin(0.5, 0.55)
        .setDepth(16.55)
        .setScale(0.58);
      const ap = {
        sprite,
        startY: y,
        vy: APPLE_FALL_V0 + Math.random() * 18,
        vx: (Math.random() - 0.5) * 22,
        landed: false,
        inWater: false,
        poolIndex: -1,
        groundY,
      };
      this.fallenApples.push(ap);
      return ap;
    }

    spawnRandomAppleFromTree() {
      if (!this.treeSpots?.length) return;
      if (this.fallenApples.length >= APPLE_MAX_WORLD) return;
      const tree = this.treeSpots[Math.floor(Math.random() * this.treeSpots.length)];
      const canopyY = this.sparrowTreePerchY(tree) - 4;
      const ax = tree.x + (Math.random() - 0.5) * 16;
      this.createFallenAppleDrop(ax, canopyY, tree.y - 2);
    }

    updateFallenApples(now, dt) {
      if (!this.fallenApples) this.fallenApples = [];
      if (this.treeSpots?.length && now >= this._nextAppleDropAt) {
        this._nextAppleDropAt = now + APPLE_DROP_MIN_MS + Math.random() * APPLE_DROP_JITTER_MS;
        if (Math.random() < 0.9) this.spawnRandomAppleFromTree();
      }

      for (let i = this.fallenApples.length - 1; i >= 0; i--) {
        const ap = this.fallenApples[i];
        const sp = ap.sprite;
        if (!sp?.active) {
          this.fallenApples.splice(i, 1);
          continue;
        }
        if (ap.landed) continue;

        ap.vy += APPLE_FALL_GRAV * dt;
        let nx = sp.x + ap.vx * dt;
        let ny = sp.y + ap.vy * dt;
        const pi = this.plazaPoolIndexAt(nx, ny);
        if (pi >= 0) {
          ap.inWater = true;
          ap.poolIndex = pi;
          ap.landed = true;
          ap.vy = 0;
          ap.vx = 0;
          sp.setPosition(nx, ny);
          sp.setDepth(15.2);
        } else if (ny >= ap.groundY || ny - ap.startY > 130) {
          ap.landed = true;
          ap.vy = 0;
          ap.vx = 0;
          const c = this.clampPosToPlaza(nx, ny, sp);
          sp.setPosition(c.x, c.y);
        } else {
          sp.setPosition(nx, ny);
        }
      }
    }

    roachSeeksManhole(ro, now) {
      if (this.isRoachFeedingOnDeadShrimp(ro)) return false;
      const rx = ro.sprite.x;
      const ry = ro.sprite.y;
      const royale = this._roachRoyaleActive;
      const frogPanic = royale ? ROACH_MANHOLE_PANIC_FROG * ROACH_ROYALE_PREDATOR_AGRO_MULT : ROACH_MANHOLE_PANIC_FROG;
      for (const lz of this.lizards || []) {
        if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
        const sp = lz.sprite;
        const rad = royale ? ROACH_MANHOLE_PANIC_LIZARD * ROACH_ROYALE_PREDATOR_AGRO_MULT : ROACH_MANHOLE_PANIC_LIZARD;
        if (Math.hypot(sp.x - rx, sp.y - ry) < rad) return true;
      }
      for (const snk of this.snakes || []) {
        const rad = royale ? ROACH_MANHOLE_PANIC_SNAKE * ROACH_ROYALE_PREDATOR_AGRO_MULT : ROACH_MANHOLE_PANIC_SNAKE;
        if (Math.hypot(snk.sprite.x - rx, snk.sprite.y - ry) < rad) return true;
      }
      if (royale) {
        for (const fr of this.frogs || []) {
          const fp = fr.sprite;
          if (!fp?.active) continue;
          if (Math.hypot(fp.x - rx, fp.y - ry) < frogPanic) return true;
        }
        for (const m of this.mice || []) {
          if (Math.hypot(m.sprite.x - rx, m.sprite.y - ry) < MOUSE_MANHOLE_PANIC_FROG * 0.92) return true;
        }
        for (const sv of this.sparrows || []) {
          if (Math.hypot(sv.sprite.x - rx, sv.sprite.y - ry) < SPARROW_ROACH_HUNT_RANGE * 0.55) return true;
        }
      }
      return false;
    }

    getMaxRoaches() {
      return this._roachRoyaleActive ? ROACH_ROYALE_MAX_ROACHES : MAX_ROACHES_NORMAL;
    }

    removeRoachAt(ri, now) {
      const ro = this.roaches[ri];
      if (!ro?.sprite?.active) return false;
      ro.sprite.destroy();
      this.roaches.splice(ri, 1);
      if (this._roachRoyaleActive) {
        this._roachRoyaleKills += 1;
        this.checkRoachRoyaleWin(now);
      }
      return true;
    }

    checkRoachRoyaleWin(now) {
      if (!this._roachRoyaleActive) return;
      if (this._roachRoyaleKills > ROACH_ROYALE_WIN_KILLS || this.roaches.length === 0) {
        this.endRoachRoyale(now, true);
      }
    }

    startRoachRoyale(now) {
      this._roachRoyaleActive = true;
      this._roachRoyaleKills = 0;
      if (this.arboreal?.liz?.sprite?.active) {
        const a = this.arboreal;
        const lp = this.clampPosToPlaza(a.baseX, a.baseY + 2, a.liz.sprite);
        a.liz.sprite.setPosition(lp.x, lp.y);
        a.liz.sprite.setDepth(16);
        this.arboreal = null;
        this._arborealCooldownUntil = now + 900;
      }
      for (const snk of this.snakes || []) {
        snk.treeEggClimb = null;
        snk.chasingSparrow = null;
      }
      for (const sv of this.sparrows || []) {
        sv.fleeUntil = 0;
        sv.beingChased = false;
        sv.chasedBySnake = null;
      }
      this.clearAllCatChases();
      const cap = ROACH_ROYALE_MAX_ROACHES;
      const burst = Math.min(24, cap - this.roaches.length);
      for (let k = 0; k < burst; k++) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        const nr = this.createRoachAt(pt.x, pt.y);
        this.pickRoachTarget(nr);
        nr.retargetAt = now + k * 60;
        this.roaches.push(nr);
      }
      this.updateRoachRoyaleBanner(now);
    }

    endRoachRoyale(now, won) {
      if (!this._roachRoyaleActive) return;
      this._roachRoyaleActive = false;
      this._roachRoyaleEndedEarly = true;
      if (won) this.awardRoachRoyaleTrophy(now);
      this.returnFrogsToHomePools();
      this.updateRoachRoyaleBanner(now);
    }

    returnFrogsToHomePools() {
      for (const fr of this.frogs || []) {
        if (!fr.sprite?.active) continue;
        const home = fr.pondHome || fr.home;
        if (!home) continue;
        fr.returningHome = true;
        fr.retargetAt = 0;
        fr.target.x = home.x;
        fr.target.y = home.y;
      }
    }

    updateRoachRoyale(now) {
      if (!this._roachRoyaleCycleStartAt) this._roachRoyaleCycleStartAt = now;
      const cycleIndex = Math.floor((now - this._roachRoyaleCycleStartAt) / ROACH_ROYALE_PERIOD_MS);
      const cyclePos = (now - this._roachRoyaleCycleStartAt) % ROACH_ROYALE_PERIOD_MS;
      if (cycleIndex !== this._roachRoyaleCycleIndex) {
        this._roachRoyaleCycleIndex = cycleIndex;
        this._roachRoyaleEndedEarly = false;
        this._roachRoyaleKills = 0;
      }
      // 每轮前半段为空等（10 天），后半段才是场次（5 分钟）——刷新后不会立刻开打
      const inWindow = cyclePos >= ROACH_ROYALE_CYCLE_MS;
      const shouldBeActive = !this._roachRoyaleEndedEarly && inWindow;
      const wasActive = this._roachRoyaleActive;
      if (shouldBeActive && !wasActive) this.startRoachRoyale(now);
      else if (!shouldBeActive && wasActive) this.endRoachRoyale(now, false);
      else if (this._roachRoyaleActive) {
        this.enforceRoachRoyalePredatorFocus();
        this.updateRoachRoyaleBanner(now);
      }
      this.updateRoachRoyaleTrophyBoosts(now);
    }

    /** 大逃杀进行中：猎食者只追蟑，打断爬树/爬蛋/追雀等其它行为 */
    enforceRoachRoyalePredatorFocus() {
      this.clearAllCatChases();
      if (this.arboreal?.liz?.sprite?.active) {
        const a = this.arboreal;
        const lp = this.clampPosToPlaza(a.baseX, a.baseY + 2, a.liz.sprite);
        a.liz.sprite.setPosition(lp.x, lp.y);
        a.liz.sprite.setDepth(16);
        this.arboreal = null;
        this._arborealCooldownUntil = this.time.now + 900;
      }
      for (const snk of this.snakes || []) {
        snk.treeEggClimb = null;
        snk.chasingSparrow = null;
      }
      for (const sv of this.sparrows || []) {
        sv.fleeUntil = 0;
        sv.beingChased = false;
        sv.chasedBySnake = null;
      }
    }

    updateRoachRoyaleBanner(now) {
      if (!this._roachRoyaleBanner) return;
      if (!this._roachRoyaleActive) {
        this._roachRoyaleBanner.setVisible(false);
        return;
      }
      const ui = this.getRoachRoyaleUiState(now);
      this._roachRoyaleBanner.setVisible(true);
      this._roachRoyaleBanner.setText(
        `蟑螂大逃杀 · 剩余 ${formatRoyaleClock(ui.remainSec)} · 猎食 ${ui.kills}/${ui.winKills} · 蟑 ${ui.roaches}/${ui.maxRoaches}`,
      );
    }

    getRoachRoyaleUiState(now = this.time?.now ?? 0) {
      const cycleStart = this._roachRoyaleCycleStartAt || now;
      const cyclePos = (now - cycleStart) % ROACH_ROYALE_PERIOD_MS;
      const active = !!this._roachRoyaleActive;
      let remainMs;
      if (active) {
        remainMs = ROACH_ROYALE_PERIOD_MS - cyclePos;
      } else if (cyclePos < ROACH_ROYALE_CYCLE_MS) {
        remainMs = ROACH_ROYALE_CYCLE_MS - cyclePos;
      } else {
        // 本场已提前结束，等到下一轮空等结束再开
        remainMs = ROACH_ROYALE_PERIOD_MS - cyclePos + ROACH_ROYALE_CYCLE_MS;
      }
      const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
      return {
        active,
        remainSec,
        nextStartSec: active ? 0 : remainSec,
        kills: this._roachRoyaleKills || 0,
        roaches: this.roaches?.length || 0,
        maxRoaches: ROACH_ROYALE_MAX_ROACHES,
        winKills: ROACH_ROYALE_WIN_KILLS + 1,
        cycleDays: ROACH_ROYALE_CYCLE_MS / 86_400_000,
        durationMin: ROACH_ROYALE_DURATION_MS / 60_000,
        endedEarly: !!this._roachRoyaleEndedEarly,
      };
    }

    collectRoachPredatorCandidates() {
      const out = [];
      for (const lz of this.lizards || []) {
        if (lz.sprite?.active) out.push({ sprite: lz.sprite, kind: "lizard" });
      }
      for (const snk of this.snakes || []) {
        if (snk.sprite?.active) out.push({ sprite: snk.sprite, kind: "snake" });
      }
      for (const fr of this.frogs || []) {
        if (fr.sprite?.active) out.push({ sprite: fr.sprite, kind: "frog" });
      }
      for (const m of this.mice || []) {
        if (m.sprite?.active) out.push({ sprite: m.sprite, kind: "mouse" });
      }
      for (const sv of this.sparrows || []) {
        if (sv.sprite?.active) out.push({ sprite: sv.sprite, kind: "sparrow" });
      }
      return out;
    }

    awardRoachRoyaleTrophy(now) {
      const candidates = this.collectRoachPredatorCandidates();
      if (!candidates.length) return;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const sp = pick.sprite;
      const baseScale = sp.scaleX || 1;
      sp.setScale(baseScale * 2);
      const trophy = this.add
        .image(sp.x, sp.y - sp.displayHeight * 0.52, "roachRoyaleTrophy")
        .setOrigin(0.5, 1)
        .setDepth((sp.depth || 16) + 2)
        .setScale(0.55 * (this.plazaScale || 1));
      this._roachRoyaleTrophyBoosts.push({
        sprite: sp,
        trophy,
        baseScale,
        endAt: now + ROACH_ROYALE_TROPHY_MS,
      });
    }

    updateRoachRoyaleTrophyBoosts(now) {
      for (let i = this._roachRoyaleTrophyBoosts.length - 1; i >= 0; i--) {
        const tb = this._roachRoyaleTrophyBoosts[i];
        if (!tb.sprite?.active || now >= tb.endAt) {
          if (tb.sprite?.active) tb.sprite.setScale(tb.baseScale);
          tb.trophy?.destroy();
          this._roachRoyaleTrophyBoosts.splice(i, 1);
          continue;
        }
        tb.trophy.setPosition(tb.sprite.x, tb.sprite.y - tb.sprite.displayHeight * 0.52);
      }
    }

    roachRoyaleFleeVector(rx, ry, fleeReduce, dt) {
      let fx = 0;
      let fy = 0;
      const ps = this.plazaScale || 1;
      const push = (px, py, radius, accel) => {
        const dx = rx - px;
        const dy = ry - py;
        const d = Math.hypot(dx, dy);
        if (d < radius && d > 0.01) {
          const w = (radius - d) / radius;
          fx += (dx / d) * w * accel;
          fy += (dy / d) * w * accel;
        }
      };
      const mult = ROACH_ROYALE_FLEE_ACCEL_MULT;
      for (const lz of this.lizards || []) {
        if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
        push(lz.sprite.x, lz.sprite.y, 72 * ps, 14 * mult);
      }
      for (const snk of this.snakes || []) {
        push(snk.sprite.x, snk.sprite.y, 68 * ps, 12 * mult);
      }
      for (const fr of this.frogs || []) {
        if (!fr.sprite?.active) continue;
        push(fr.sprite.x, fr.sprite.y, 88 * ps, 11 * mult);
      }
      for (const m of this.mice || []) {
        push(m.sprite.x, m.sprite.y, 58 * ps, 10 * mult);
      }
      for (const sv of this.sparrows || []) {
        push(sv.sprite.x, sv.sprite.y, 62 * ps, 9 * mult);
      }
      const fl = Math.hypot(fx, fy);
      if (fl > 0.01) {
        return {
          dx: (fx / fl) * ROACH_ROYALE_FLEE_ACCEL_MULT * fleeReduce * dt,
          dy: (fy / fl) * ROACH_ROYALE_FLEE_ACCEL_MULT * fleeReduce * dt,
        };
      }
      return { dx: 0, dy: 0 };
    }

    tryManholeTeleportMouse(m, now) {
      if (!(this.manholes && this.manholes.length)) return false;
      if (now < (m.nextManholeAt || 0)) return false;
      const hi = this.findManholeIndexAt(m.sprite.x, m.sprite.y);
      if (hi < 0) return false;
      const exit = this.randomManholeTunnelExit(hi);
      if (!exit) return false;
      const c = this.clampPosToPlaza(exit.x, exit.y, m.sprite, true);
      m.sprite.setPosition(c.x, c.y);
      m.home.x = c.x;
      m.home.y = c.y;
      m.nextManholeAt = now + MANHOLE_COOLDOWN_MS;
      this.pickMouseTarget(m);
      this.clearCatChaseOfMouse(m.sprite);
      return true;
    }

    tryManholeTeleportRoach(ro, now) {
      if (!(this.manholes && this.manholes.length)) return false;
      if (now < (ro.nextManholeAt || 0)) return false;
      const hi = this.findManholeIndexAt(ro.sprite.x, ro.sprite.y);
      if (hi < 0) return false;
      const exit = this.randomManholeTunnelExit(hi);
      if (!exit) return false;
      const c = this.clampPosToPlaza(exit.x, exit.y, ro.sprite, true);
      ro.sprite.setPosition(c.x, c.y);
      ro.home.x = c.x;
      ro.home.y = c.y;
      ro.nextManholeAt = now + MANHOLE_COOLDOWN_MS;
      this.pickRoachTarget(ro);
      return true;
    }

    poolCenter(pool) {
      if (!pool) return { x: 0, y: 0 };
      if (pool.kind === "ellipse") return { x: pool.cx, y: pool.cy };
      return { x: pool.flowCx, y: pool.flowCy };
    }

    nearestPlazaPoolIndexTo(x, y) {
      if (!this.plazaPools || !this.plazaPools.length) return -1;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < this.plazaPools.length; i++) {
        const c = this.poolCenter(this.plazaPools[i]);
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    countFishInPool(poolIndex) {
      return this.pondFish.filter((f) => f.poolIndex === poolIndex && f.sprite && f.sprite.active).length;
    }

    spawnPondFish(poolIndex, baby, prefX, prefY) {
      if (poolIndex < 0 || poolIndex >= this.plazaPools.length) return;
      if (this.countFishInPool(poolIndex) >= MAX_FISH_PER_POOL) return;
      const pool = this.plazaPools[poolIndex];
      const sc = this.plazaScale || 1;
      const scaleMul = Math.min(1.15, sc * 0.72);
      let pt;
      if (prefX != null && prefY != null && this.pointInPlazaPool(pool, prefX, prefY)) {
        pt = { x: prefX, y: prefY };
      } else {
        pt = this.randomPointInsidePlazaPool(pool);
      }
      const adultSc = 0.52 * scaleMul;
      const babySc = 0.38 * scaleMul;
      const sprite = this.add
        .image(pt.x, pt.y, "pondFish")
        .setOrigin(0.5)
        .setDepth(4.15)
        .setScale(baby ? babySc : adultSc);
      sprite.setTint(POND_FISH_TINTS[Math.floor(Math.random() * POND_FISH_TINTS.length)]);
      const now = this.time.now;
      this.pondFish.push({
        sprite,
        poolIndex,
        target: { x: pt.x, y: pt.y },
        retargetAt: now + 400 + Math.random() * 400,
        baby: !!baby,
        matureAt: baby ? now + FISH_MATURE_MS : 0,
        nextBreedAt: baby ? now + FISH_MATURE_MS + 2000 : now + 2000,
      });
    }

    spawnFishEgg(poolIndex, x, y, now) {
      const pool = this.plazaPools[poolIndex];
      if (!pool) return;
      let px = x;
      let py = y;
      if (!this.pointInPlazaPool(pool, px, py)) {
        const p = this.randomPointInsidePlazaPool(pool);
        px = p.x;
        py = p.y;
      }
      const r = 3.2 * (this.plazaScale || 1);
      const egg = this.add
        .circle(px, py, r, 0xfffacd, 0.92)
        .setStrokeStyle(1, 0xc9a227, 0.85)
        .setDepth(4.12);
      this.pondFishEggs.push({
        sprite: egg,
        poolIndex,
        hatchAt: now + FISH_EGG_HATCH_MS,
      });
      this.tryAssignStallShrimpPull(this.pondFishEggs[this.pondFishEggs.length - 1], "fish");
    }

    restoreShrimpBobAtSite(site) {
      const npc = site?.npc;
      if (!npc?.active) return;
      this.tweens.killTweensOf(npc);
      npc.setPosition(site.npcHomeX, site.npcHomeY);
      this.tweens.add({
        targets: npc,
        y: site.npcHomeY - 2,
        duration: 720,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
    }

    cancelStallShrimpEggPull(egg, restoreShrimp) {
      const sp = egg?.stallPull;
      if (!sp) return;
      try {
        sp.rope?.destroy();
      } catch {
        /* noop */
      }
      const site = sp.site;
      if (site) {
        site.busy = false;
        if (site.npc?._stallPullEggRef === egg) site.npc._stallPullEggRef = null;
        if (restoreShrimp && site.npc?.active) {
          site.npc.setPosition(site.npcHomeX, site.npcHomeY);
          this.restoreShrimpBobAtSite(site);
        }
      }
      delete egg.stallPull;
    }

    /**
     * 单摊蛋篓集满：先尽数孵化蜥蜴（上限内），再逐条孵化小鱼并由该摊小龙虾吃掉。
     */
    /** 摊前已收集蛋的展示：排布在摊位标题下方（避免挡住帖子标题）：两排各 5，鱼卵黄圆、蜥蜴蛋贴图 */
    createStallBasketEggIcon(site, slotIndex, kind) {
      const ps = this.plazaScale || 1;
      const col = slotIndex % 5;
      const row = Math.floor(slotIndex / 5);
      const spacing = 16 * ps;
      const rowGap = 12 * ps;
      const cx = site.stallX + (col - 2) * spacing;
      const baseY = site.stallY + 24 * ps;
      const cy = baseY + row * rowGap;
      if (kind === "fish") {
        const r = Math.max(2.6, 3 * ps);
        return this.add
          .circle(cx, cy, r, 0xfffacd, 0.92)
          .setStrokeStyle(1, 0xc9a227, 0.85)
          .setDepth(8.55);
      }
      return this.add
        .image(cx, cy, "lizardEgg")
        .setOrigin(0.5, 0.55)
        .setScale(0.52 * Math.min(1.15, ps))
        .setDepth(8.56);
    }

    clearStallEggBasketIcons(site, count) {
      if (!site?.eggBasketIcons?.length) return;
      const n = Math.min(count ?? site.eggBasketIcons.length, site.eggBasketIcons.length);
      for (let i = 0; i < n; i++) {
        const g = site.eggBasketIcons.shift();
        try {
          g?.destroy();
        } catch {
          /* noop */
        }
      }
    }

    resolveStallEggBatch(site) {
      if (!site?.eggBasket || site.eggBasket.length < STALL_EGG_BATCH_COUNT) return;
      const batch = site.eggBasket.splice(0, STALL_EGG_BATCH_COUNT);
      this.clearStallEggBasketIcons(site, STALL_EGG_BATCH_COUNT);
      const ps = this.plazaScale || 1;
      const sx = site.stallX;
      const sy = site.stallY;
      const shrimp = site.npc;

      site.eggBatchResolving = true;

      const lizItems = batch.filter((x) => x.kind === "lizard");
      const fishItems = batch.filter((x) => x.kind === "fish");

      let li = 0;
      for (const _ of lizItems) {
        if (this.lizards.length >= MAX_LIZARDS) break;
        const ox = ((li % 5) - 2) * 9 * ps;
        const oy = (Math.floor(li / 5) % 2) * 11 * ps;
        li++;
        this.spawnHatchLizardNear(sx + ox, sy + oy);
      }

      const scaleMul = Math.min(1.15, ps * 0.72);
      const babySc = 0.38 * scaleMul;

      let fi = 0;
      const eatNextFish = () => {
        if (!shrimp?.active) {
          site.eggBatchResolving = false;
          return;
        }
        if (fi >= fishItems.length) {
          site.eggBatchResolving = false;
          return;
        }
        const hx = sx - 5 * ps;
        const hy = sy + 14 * ps;
        const snack = this.add
          .image(hx, hy, "pondFish")
          .setOrigin(0.5)
          .setDepth(8)
          .setScale(babySc);
        snack.setTint(POND_FISH_TINTS[Math.floor(Math.random() * POND_FISH_TINTS.length)]);
        fi++;
        this.tweens.add({
          targets: snack,
          x: shrimp.x,
          y: shrimp.y,
          duration: 320,
          ease: "Cubic.in",
          onComplete: () => {
            try {
              snack.destroy();
            } catch {
              /* noop */
            }
            this.time.delayedCall(400, eatNextFish);
          },
        });
      };

      if (fishItems.length) {
        eatNextFish();
      } else {
        site.eggBatchResolving = false;
      }
    }

    tryAssignStallShrimpPull(egg, kind) {
      if (!egg?.sprite?.active) return;
      if (egg.stallPull) return;
      const sites = this.stallShrimpSites;
      if (!sites?.length) return;
      const ex = egg.sprite.x;
      const ey = egg.sprite.y;
      let best = null;
      let bestD = Infinity;
      for (const site of sites) {
        if (!site.npc?.active || site.busy || site.dead || site.cooloff || site.incoming || site.eggBatchResolving)
          continue;
        const d = Math.hypot(site.npc.x - ex, site.npc.y - ey);
        if (d < bestD) {
          bestD = d;
          best = site;
        }
      }
      if (!best) return;
      const rope = this.add.graphics().setDepth(6.25);
      this.tweens.killTweensOf(best.npc);
      best.busy = true;
      best.npc._stallPullEggRef = egg;
      const ps = this.plazaScale || 1;
      /** @type {{ phase: string, site: object, rope: Phaser.GameObjects.Graphics, stallX: number, stallY: number, shoreX?: number, shoreY?: number }} */
      const pull = {
        phase: "pre_rope",
        site: best,
        rope,
        stallX: best.stallX,
        stallY: best.stallY,
      };
      // 鱼卵：先到池塘边（岸上的落脚点），再甩绳；蜥蜴蛋：先到蛋旁（无绳），再甩绳（与鱼卵同两段节奏）
      if (kind === "fish") {
        const pool = this.plazaPools?.[egg.poolIndex];
        if (pool && this.pointInPlazaPool(pool, ex, ey)) {
          const nb = this.nearestPointOnPlazaPoolBoundary(pool, ex, ey);
          if (nb) {
            const c = this.poolCenter(pool);
            let ox = nb.x - c.x;
            let oy = nb.y - c.y;
            const olen = Math.hypot(ox, oy) || 1;
            ox /= olen;
            oy /= olen;
            const landPad = 10 * ps;
            const cp = this.clampPosToPlaza(nb.x + ox * landPad, nb.y + oy * landPad);
            pull.phase = "to_bank";
            pull.shoreX = cp.x;
            pull.shoreY = cp.y;
          }
        }
      }
      egg.stallPull = pull;
    }

    updateStallShrimpEggPulls(now, dt) {
      const ps = this.plazaScale || 1;
      const spd = STALL_SHRIMP_PULL_SPEED * ps;
      const apprD = STALL_SHRIMP_APPROACH_DIST * ps;
      const delivD = STALL_EGG_DELIVER_DIST * ps;

      const drawRope = (rope, ax, ay, bx, by) => {
        if (!rope?.active) return;
        rope.clear();
        rope.lineStyle(Math.max(1, Math.round(2 * Math.min(ps, 1.2))), 0x5c4030, 0.92);
        rope.lineBetween(ax, ay, bx, by);
      };

      const deliverEgg = (egg, site, kind) => {
        const sp = egg.stallPull;
        try {
          sp?.rope?.destroy();
        } catch {
          /* noop */
        }
        site.busy = false;
        if (site.npc?._stallPullEggRef === egg) site.npc._stallPullEggRef = null;
        delete egg.stallPull;

        if (kind === "fish") {
          const ix = this.pondFishEggs.indexOf(egg);
          if (ix >= 0) this.pondFishEggs.splice(ix, 1);
          site.eggBasket.push({ kind: "fish", poolIndex: egg.poolIndex });
        } else {
          const ix = this.lizardEggs.indexOf(egg);
          if (ix >= 0) this.lizardEggs.splice(ix, 1);
          site.eggBasket.push({ kind: "lizard" });
        }
        try {
          egg.sprite.destroy();
        } catch {
          /* noop */
        }

        if (site.npc?.active) {
          site.npc.setPosition(site.npcHomeX, site.npcHomeY);
          this.restoreShrimpBobAtSite(site);
        }
        const slot = site.eggBasket.length - 1;
        const icon = this.createStallBasketEggIcon(site, slot, kind === "fish" ? "fish" : "lizard");
        if (!site.eggBasketIcons) site.eggBasketIcons = [];
        site.eggBasketIcons.push(icon);

        if (site.eggBasket.length >= STALL_EGG_BATCH_COUNT) {
          this.resolveStallEggBatch(site);
        }
      };

      const stepEgg = (egg, kind) => {
        const sp = egg.stallPull;
        if (!sp) return;
        if (!egg.sprite?.active) {
          this.cancelStallShrimpEggPull(egg, false);
          return;
        }
        const site = sp.site;
        const npc = site?.npc;
        if (!npc?.active) {
          this.cancelStallShrimpEggPull(egg, false);
          return;
        }

        const ex = egg.sprite.x;
        const ey = egg.sprite.y;
        const sx = npc.x;
        const sy = npc.y;

        if (sp.phase === "to_bank") {
          const tx = sp.shoreX ?? ex;
          const ty = sp.shoreY ?? ey;
          const dx = tx - sx;
          const dy = ty - sy;
          const len = Math.hypot(dx, dy) || 1;
          if (len < apprD * 0.92) {
            sp.phase = "drag";
          } else {
            const step = Math.min(spd * dt, len - apprD * 0.35);
            npc.setPosition(sx + (dx / len) * step, sy + (dy / len) * step);
            this.clampSpriteToPlaza(npc, false);
            if (Math.abs(dx) > 0.35) npc.setFlipX(dx < 0);
          }
          try {
            sp.rope?.clear();
          } catch {
            /* noop */
          }
          return;
        }

        if (sp.phase === "pre_rope") {
          const dx = ex - sx;
          const dy = ey - sy;
          const len = Math.hypot(dx, dy) || 1;
          if (len < apprD) {
            sp.phase = "drag";
          } else {
            const step = Math.min(spd * dt, len - apprD * 0.4);
            npc.setPosition(sx + (dx / len) * step, sy + (dy / len) * step);
            this.clampSpriteToPlaza(npc, false);
            if (Math.abs(dx) > 0.35) npc.setFlipX(dx < 0);
          }
          try {
            sp.rope?.clear();
          } catch {
            /* noop */
          }
          return;
        }

        const stx = sp.stallX;
        const sty = sp.stallY;
        // 龙虾向摊位走
        const sdx = stx - npc.x;
        const sdy = sty - npc.y;
        const slen = Math.hypot(sdx, sdy) || 1;
        const stepS = Math.min(spd * dt, slen);
        npc.setPosition(npc.x + (sdx / slen) * stepS, npc.y + (sdy / slen) * stepS);
        this.clampSpriteToPlaza(npc, false);
        if (Math.abs(sdx) > 0.35) npc.setFlipX(sdx < 0);

        // 蛋被龙虾拖着走：沿龙虾→蛋方向，保持绳长距离跟随
        const ropeLen = STALL_SHRIMP_APPROACH_DIST * ps;
        const nsx = npc.x;
        const nsy = npc.y;
        const toEggX = ex - nsx;
        const toEggY = ey - nsy;
        const toEggLen = Math.hypot(toEggX, toEggY) || 1;
        // 蛋保持在龙虾身后 ropeLen 距离处
        const targetEX = nsx + (toEggX / toEggLen) * ropeLen;
        const targetEY = nsy + (toEggY / toEggLen) * ropeLen;
        egg.sprite.setPosition(targetEX, targetEY);
        const ec = this.clampPosToPlaza(egg.sprite.x, egg.sprite.y, egg.sprite, true);
        egg.sprite.setPosition(ec.x, ec.y);

        drawRope(sp.rope, npc.x, npc.y, egg.sprite.x, egg.sprite.y);

        // 龙虾到达摊位附近时交付蛋
        const dsx = npc.x - stx;
        const dsy = npc.y - sty;
        if (Math.hypot(dsx, dsy) < delivD) deliverEgg(egg, site, kind);
      };

      for (const e of this.pondFishEggs) {
        if (e.stallPull) stepEgg(e, "fish");
      }
      for (const e of this.lizardEggs) {
        if (e.stallPull) stepEgg(e, "lizard");
      }
    }

    stallShrimpSiteForNpc(npc) {
      return npc?._stallSite || null;
    }

    isStallShrimpSiteOperational(site) {
      return (
        site &&
        !site.dead &&
        !site.cooloff &&
        !site.incoming &&
        !site.eggBatchResolving &&
        site.npc?.active
      );
    }

    /** 牛蛙可追咬：站摊 idle、虾扯蛋、池里乘凉均可；不含死虾与替补进场的虾 */
    canFrogTargetStallShrimp(site) {
      return !!(site && !site.dead && !site.incoming && site.npc?.active);
    }

    pickPlazaEntryPoint(x, y) {
      const b = this.plazaWalkBounds;
      if (!b) return { x, y };
      const ps = this.plazaScale || 1;
      const pad = 32 * ps;
      const cy = Phaser.Math.Clamp(y, b.minY, b.maxY);
      const cx = Phaser.Math.Clamp(x, b.minX, b.maxX);
      const dxL = x - b.minX;
      const dxR = b.maxX - x;
      const dyT = y - b.minY;
      const dyB = b.maxY - y;
      const min = Math.min(dxL, dxR, dyT, dyB);
      if (min === dxL) return { x: b.minX - pad, y: cy };
      if (min === dxR) return { x: b.maxX + pad, y: cy };
      if (min === dyT) return { x: cx, y: b.minY - pad };
      return { x: cx, y: b.maxY + pad };
    }

    countRoachesNear(x, y, radius) {
      let n = 0;
      for (const ro of this.roaches) {
        if (!ro.sprite?.active) continue;
        if (Math.hypot(ro.sprite.x - x, ro.sprite.y - y) <= radius) n++;
      }
      return n;
    }

    /** 全广场最近一只倒翻死虾（牛蛙咬死等）；供蟑螂主动趋食 */
    findNearestDeadStallShrimp(x, y) {
      let best = null;
      let bestD = Infinity;
      for (const site of this.stallShrimpSites || []) {
        if (!site.dead || !site.npc?.active) continue;
        const sx = site.npc.x;
        const sy = site.npc.y;
        const d = Math.hypot(sx - x, sy - y);
        if (d < bestD) {
          bestD = d;
          best = { x: sx, y: sy, dist: d };
        }
      }
      return best;
    }

    /** 蟑螂贴脸啃死虾时：牛蛙/蜥蜴/蛇/老鼠/麻雀不追捕 */
    isRoachFeedingOnDeadShrimp(ro) {
      if (!ro?.sprite?.active) return false;
      const dead = this.findNearestDeadStallShrimp(ro.sprite.x, ro.sprite.y);
      if (!dead) return false;
      const ps = this.plazaScale || 1;
      return dead.dist < DEAD_SHRIMP_ROACH_EAT_DIST * ps + 6 * ps;
    }

    cancelStallShrimpPullsForSite(site, restoreShrimp) {
      for (const e of [...this.pondFishEggs, ...this.lizardEggs]) {
        if (e.stallPull?.site === site) this.cancelStallShrimpEggPull(e, restoreShrimp);
      }
    }

    tryStallShrimpEatPoolFish(poolIndex) {
      if (Math.random() >= STALL_SHRIMP_COOLOFF_EAT_FISH_CHANCE) return;
      for (let i = this.pondFish.length - 1; i >= 0; i--) {
        const f = this.pondFish[i];
        if (f.poolIndex !== poolIndex || !f.sprite?.active) continue;
        f.sprite.destroy();
        this.pondFish.splice(i, 1);
        break;
      }
    }

    startStallShrimpCooloff(site, now) {
      if (!this.isStallShrimpSiteOperational(site) || site.busy) return;
      if (!this.plazaPools?.length) return;
      const poolIndex = Math.floor(Math.random() * this.plazaPools.length);
      const pool = this.plazaPools[poolIndex];
      const pt = this.randomPointInsidePlazaPool(pool);
      this.tweens.killTweensOf(site.npc);
      site.busy = true;
      site.cooloff = { phase: "to_pool", poolIndex, poolX: pt.x, poolY: pt.y, until: 0 };
    }

    updateStallShrimpCooloffs(now, dt) {
      const ps = this.plazaScale || 1;
      const spd = STALL_SHRIMP_COOLOFF_SPEED * ps;
      const homeD = 14 * ps;

      if (now >= this._nextStallShrimpCooloffAt && this.stallShrimpSites?.length) {
        this._nextStallShrimpCooloffAt = now + STALL_SHRIMP_COOLOFF_INTERVAL_MS;
        const eligible = this.stallShrimpSites.filter(
          (s) => this.isStallShrimpSiteOperational(s) && !s.busy,
        );
        if (eligible.length) {
          this.startStallShrimpCooloff(eligible[Math.floor(Math.random() * eligible.length)], now);
        }
      }

      for (const site of this.stallShrimpSites || []) {
        const cf = site.cooloff;
        const npc = site.npc;
        if (!cf || !npc?.active) continue;

        if (cf.phase === "to_pool") {
          const dx = cf.poolX - npc.x;
          const dy = cf.poolY - npc.y;
          const len = Math.hypot(dx, dy) || 1;
          if (len < homeD) {
            cf.phase = "in_pool";
            cf.until = now + STALL_SHRIMP_COOLOFF_IN_POOL_MS;
            this.tryStallShrimpEatPoolFish(cf.poolIndex);
          } else {
            const step = Math.min(spd * dt, len);
            npc.setPosition(npc.x + (dx / len) * step, npc.y + (dy / len) * step);
            if (Math.abs(dx) > 0.35) npc.setFlipX(dx < 0);
          }
          continue;
        }

        if (cf.phase === "in_pool") {
          npc.setPosition(cf.poolX, cf.poolY);
          if (now >= cf.until) {
            cf.phase = "return";
          }
          continue;
        }

        if (cf.phase === "return") {
          const dx = site.npcHomeX - npc.x;
          const dy = site.npcHomeY - npc.y;
          const len = Math.hypot(dx, dy) || 1;
          if (len < homeD) {
            site.cooloff = null;
            site.busy = false;
            npc.setPosition(site.npcHomeX, site.npcHomeY);
            npc.setFlipX(false);
            this.restoreShrimpBobAtSite(site);
          } else {
            const step = Math.min(spd * dt, len);
            npc.setPosition(npc.x + (dx / len) * step, npc.y + (dy / len) * step);
            if (Math.abs(dx) > 0.35) npc.setFlipX(dx < 0);
          }
        }
      }
    }

    killStallShrimpAtSite(site, now) {
      const npc = site?.npc;
      if (!npc?.active || site.dead) return;
      this.cancelStallShrimpPullsForSite(site, false);
      this.tweens.killTweensOf(npc);
      site.cooloff = null;
      site.busy = true;
      site.dead = true;
      npc.setFlipY(true);
      npc.setTint(0x6a5048);
      npc.setDepth(8.2);
    }

    startStallShrimpReplacement(site, now) {
      if (site.incoming) return;
      const entry = this.pickPlazaEntryPoint(site.stallX, site.stallY);
      const npc = this.add
        .image(entry.x, entry.y, "shrimp")
        .setOrigin(0.5)
        .setDepth(8)
        .setTint(site.stallTint ?? 0xffffff);
      npc._stallSite = site;
      this.boothNpcs.push(npc);
      site.incoming = { npc, startedAt: now };
    }

    updateDeadStallShrimpSites(now) {
      for (const site of this.stallShrimpSites || []) {
        if (!site.dead || !site.npc?.active) continue;
        const sx = site.npc.x;
        const sy = site.npc.y;
        if (this.countRoachesNear(sx, sy, DEAD_SHRIMP_ROACH_GATHER_DIST) < DEAD_SHRIMP_ROACH_GATHER_COUNT) continue;

        try {
          site.npc.destroy();
        } catch {
          /* noop */
        }
        site.npc = null;
        site.dead = false;
        site.busy = true;
        this.startStallShrimpReplacement(site, now);
      }
    }

    updateStallShrimpReplacements(now, dt) {
      const ps = this.plazaScale || 1;
      const spd = STALL_SHRIMP_REPLACEMENT_SPEED * ps;
      const homeD = 12 * ps;

      for (const site of this.stallShrimpSites || []) {
        const inc = site.incoming;
        if (!inc?.npc?.active) {
          if (inc) site.incoming = null;
          continue;
        }
        const npc = inc.npc;
        const dx = site.npcHomeX - npc.x;
        const dy = site.npcHomeY - npc.y;
        const len = Math.hypot(dx, dy) || 1;
        if (len < homeD) {
          npc.setPosition(site.npcHomeX, site.npcHomeY);
          site.npc = npc;
          site.incoming = null;
          site.busy = false;
          npc.setFlipX(false);
          npc.setFlipY(false);
          this.restoreShrimpBobAtSite(site);
        } else {
          const step = Math.min(spd * dt, len);
          npc.setPosition(npc.x + (dx / len) * step, npc.y + (dy / len) * step);
          if (Math.abs(dx) > 0.35) npc.setFlipX(dx < 0);
          this.clampSpriteToPlaza(npc, false);
        }
      }
    }

    tryPondFishBreed(now) {
      outer: for (let i = 0; i < this.pondFish.length; i++) {
        const fa = this.pondFish[i];
        if (!fa.sprite || !fa.sprite.active || fa.baby) continue;
        for (let j = i + 1; j < this.pondFish.length; j++) {
          const fb = this.pondFish[j];
          if (!fb.sprite || !fb.sprite.active || fb.baby) continue;
          if (fa.poolIndex !== fb.poolIndex) continue;
          if (now < fa.nextBreedAt || now < fb.nextBreedAt) continue;
          const pi = fa.poolIndex;
          if (this.countFishInPool(pi) >= MAX_FISH_PER_POOL) continue;
          if (Math.hypot(fa.sprite.x - fb.sprite.x, fa.sprite.y - fb.sprite.y) >= FISH_BREED_DIST) continue;
          const midx = (fa.sprite.x + fb.sprite.x) / 2;
          const midy = (fa.sprite.y + fb.sprite.y) / 2;
          this.spawnFishEgg(pi, midx, midy, now);
          fa.nextBreedAt = now + FISH_BREED_COOLDOWN_MS;
          fb.nextBreedAt = now + FISH_BREED_COOLDOWN_MS;
          break outer;
        }
      }
    }

    updatePondFish(now, dt) {
      if (!this.plazaPools || !this.plazaPools.length) return;
      this.pondFish = this.pondFish.filter((f) => f.sprite && f.sprite.active);
      const sc = this.plazaScale || 1;
      const scaleMul = Math.min(1.15, sc * 0.72);
      const adultSc = 0.52 * scaleMul;

      for (const f of this.pondFish) {
        if (!f.sprite || !f.sprite.active) continue;
        if (f.baby && now >= f.matureAt) {
          f.baby = false;
          f.sprite.setScale(adultSc);
          f.nextBreedAt = now + 2500;
        }
        const pool = this.plazaPools[f.poolIndex];
        if (!pool) continue;
        let x = f.sprite.x;
        let y = f.sprite.y;
        let seekAppleI = -1;
        let seekAppleD = APPLE_FISH_SEEK_RANGE;
        let seekAx = null;
        let seekAy = null;
        for (let ai = 0; ai < (this.fallenApples || []).length; ai++) {
          const ap = this.fallenApples[ai];
          if (!ap.landed || !ap.inWater || ap.poolIndex !== f.poolIndex || !ap.sprite?.active) continue;
          const d = Math.hypot(ap.sprite.x - x, ap.sprite.y - y);
          if (d < seekAppleD) {
            seekAppleD = d;
            seekAx = ap.sprite.x;
            seekAy = ap.sprite.y;
            seekAppleI = ai;
          }
        }
        let flipLeft = false;
        if (seekAx != null) {
          if (seekAppleD < APPLE_FISH_EAT_DIST) {
            this.removeFallenAppleAt(seekAppleI);
          } else {
            const tx = seekAx - x;
            const ty = seekAy - y;
            const len = Math.hypot(tx, ty) || 1;
            x += (tx / len) * (FISH_SWIM_SPEED * 1.28) * dt;
            y += (ty / len) * (FISH_SWIM_SPEED * 1.28) * dt;
            flipLeft = tx < 0;
          }
        } else {
          if (now > f.retargetAt) {
            f.retargetAt = now + 900 + Math.random() * 1400;
            const p = this.randomPointInsidePlazaPool(pool);
            f.target.x = p.x;
            f.target.y = p.y;
          }
          const tx = f.target.x - x;
          const ty = f.target.y - y;
          const len = Math.hypot(tx, ty) || 1;
          x += (tx / len) * FISH_SWIM_SPEED * dt;
          y += (ty / len) * FISH_SWIM_SPEED * dt;
          flipLeft = tx < 0;
        }
        f.sprite.setPosition(x, y);
        f.sprite.setFlipX(flipLeft);
        if (!this.pointInPlazaPool(pool, f.sprite.x, f.sprite.y)) {
          const p = this.randomPointInsidePlazaPool(pool);
          f.sprite.setPosition(p.x, p.y);
          f.target.x = p.x;
          f.target.y = p.y;
        }
      }

      for (let ei = this.pondFishEggs.length - 1; ei >= 0; ei--) {
        const e = this.pondFishEggs[ei];
        if (!e.sprite || !e.sprite.active) {
          this.pondFishEggs.splice(ei, 1);
          continue;
        }
        if (e.stallPull) continue;
        if (now < e.hatchAt) continue;
        const pi = e.poolIndex;
        const hx = e.sprite.x;
        const hy = e.sprite.y;

        e.sprite.destroy();
        this.pondFishEggs.splice(ei, 1);
        if (this.countFishInPool(pi) < MAX_FISH_PER_POOL) {
          this.spawnPondFish(pi, true, hx, hy);
        }
      }

      this.tryPondFishBreed(now);
    }

    updateCatFishing(catEntry, now, dt) {
      const cat = catEntry.sprite;
      const cf = catEntry.fishing;
      if (!cf) return;
      if (this.arboreal) {
        catEntry.fishing = null;
        catEntry.nextFishAt = now + CAT_FISH_INTERVAL_MS;
        return;
      }
      const pool = this.plazaPools[cf.poolIndex];
      if (!pool) {
        catEntry.fishing = null;
        catEntry.nextFishAt = now + CAT_FISH_INTERVAL_MS;
        return;
      }
      const center = this.poolCenter(pool);
      const vCat = 30;
      const pad = 11 * (this.plazaScale || 1);

      if (cf.phase === "approach") {
        const b = this.nearestPointOnPlazaPoolBoundary(pool, cat.x, cat.y);
        if (!b) {
          catEntry.fishing = null;
          catEntry.nextFishAt = now + CAT_FISH_INTERVAL_MS;
          return;
        }
        const vx = cat.x - center.x;
        const vy = cat.y - center.y;
        const vl = Math.hypot(vx, vy) || 1;
        const tx = b.x + (vx / vl) * pad;
        const ty = b.y + (vy / vl) * pad;
        const dx = tx - cat.x;
        const dy = ty - cat.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 14) {
          cf.phase = "catch";
          cf.catchDoneAt = now + 520;
        } else {
          const step = Math.min(vCat * dt, d);
          cat.x += (dx / d) * step;
          cat.y += (dy / d) * step;
        }
        this.clampSpriteToPlaza(cat);
        if (this.bounceIfNearFountain(cat, now)) catEntry.chaseMouse = null;
        this.clampSpriteToPlaza(cat);
        this.aimCatAt(cat, center.x, center.y);
      } else if (cf.phase === "catch") {
        this.aimCatAt(cat, center.x, center.y);
        if (now >= (cf.catchDoneAt || 0)) {
          const fishHere = this.pondFish.filter(
            (f) => f.poolIndex === cf.poolIndex && f.sprite && f.sprite.active,
          );
          if (fishHere.length) {
            const victim = fishHere[Math.floor(Math.random() * fishHere.length)];
            const idx = this.pondFish.indexOf(victim);
            if (idx >= 0) {
              victim.sprite.destroy();
              this.pondFish.splice(idx, 1);
            }
          }
          cf.phase = "leave";
          const away = this.randomPlazaWalkPointAvoidingPools();
          if (away) {
            cf.exitX = away.x;
            cf.exitY = away.y;
          } else {
            const b = this.plazaWalkBounds;
            cf.exitX = b ? b.minX + Math.random() * (b.maxX - b.minX) : cat.x + 80;
            cf.exitY = b ? b.minY + Math.random() * (b.maxY - b.minY) : cat.y;
          }
          cf.leaveUntil = now + 4000;
        }
      } else if (cf.phase === "leave") {
        const dx = (cf.exitX ?? cat.x) - cat.x;
        const dy = (cf.exitY ?? cat.y) - cat.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 20 || now >= (cf.leaveUntil || 0)) {
          catEntry.fishing = null;
          catEntry.nextFishAt = now + CAT_FISH_INTERVAL_MS;
        } else {
          const step = Math.min(26 * dt, d);
          cat.x += (dx / d) * step;
          cat.y += (dy / d) * step;
          this.clampSpriteToPlaza(cat);
          if (this.bounceIfNearFountain(cat, now)) catEntry.chaseMouse = null;
          this.clampSpriteToPlaza(cat);
        }
        this.aimCatAt(cat, cf.exitX ?? cat.x, cf.exitY ?? cat.y);
      }
    }

    initPondFish() {
      this.pondFish = [];
      this.pondFishEggs = [];
      for (const c of this.cats || []) {
        c.fishing = null;
        c.nextFishAt = this.time.now + CAT_FISH_INTERVAL_MS;
      }
      for (let pi = 0; pi < this.plazaPools.length; pi++) {
        for (let k = 0; k < POND_FISH_START; k++) {
          this.spawnPondFish(pi, false);
        }
      }
    }

    pointInPlazaPool(pool, x, y) {
      if (!pool) return false;
      if (pool.kind === "ellipse") {
        const dx = x - pool.cx;
        const dy = y - pool.cy;
        const c = Math.cos(-pool.rot);
        const s = Math.sin(-pool.rot);
        const lx = dx * c - dy * s;
        const ly = dx * s + dy * c;
        return lx * lx / (pool.rx * pool.rx) + ly * ly / (pool.ry * pool.ry) <= 1.0001;
      }
      return plazaPointInPolygon(x, y, pool.verts);
    }

    pointInAnyPlazaPool(x, y) {
      for (const pool of this.plazaPools) {
        if (this.pointInPlazaPool(pool, x, y)) return true;
      }
      return false;
    }

    pushOutOnePlazaPool(pool, x, y, pad) {
      if (pool.kind === "ellipse") {
        const dx = x - pool.cx;
        const dy = y - pool.cy;
        const c = Math.cos(-pool.rot);
        const s = Math.sin(-pool.rot);
        let lx = dx * c - dy * s;
        let ly = dx * s + dy * c;
        const { rx, ry } = pool;
        const k = Math.sqrt((lx / rx) ** 2 + (ly / ry) ** 2);
        if (k > 1.0001) return { x, y };
        if (k < 1e-8) {
          lx = rx;
          ly = 0;
        } else {
          const t = 1 / k;
          lx *= t;
          ly *= t;
        }
        let nx = lx / (rx * rx);
        let ny = ly / (ry * ry);
        const nlen = Math.hypot(nx, ny) || 1;
        nx /= nlen;
        ny /= nlen;
        lx += nx * pad;
        ly += ny * pad;
        const c2 = Math.cos(pool.rot);
        const s2 = Math.sin(pool.rot);
        return {
          x: pool.cx + lx * c2 - ly * s2,
          y: pool.cy + lx * s2 + ly * c2,
        };
      }
      return plazaPushOutPolygon(pool.verts, x, y, pad);
    }

    pushOutOfPlazaPools(x, y, pad) {
      let px = x;
      let py = y;
      for (let iter = 0; iter < 8; iter++) {
        let moved = false;
        for (const pool of this.plazaPools) {
          if (!this.pointInPlazaPool(pool, px, py)) continue;
          const q = this.pushOutOnePlazaPool(pool, px, py, pad);
          px = q.x;
          py = q.y;
          moved = true;
        }
        if (!moved) break;
      }
      return { x: px, y: py };
    }

    pointInFencePaddock(x, y) {
      for (const r of this.fencePaddocks || []) {
        if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) return true;
      }
      return false;
    }

    getFencePaddockAt(x, y) {
      for (const r of this.fencePaddocks || []) {
        if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) return r;
      }
      return null;
    }

    clampInsideFencePaddock(x, y, pad = 4) {
      const r = this.fencePaddocks?.[0];
      if (!r) return { x, y };
      return {
        x: Math.max(r.minX + pad, Math.min(r.maxX - pad, x)),
        y: Math.max(r.minY + pad, Math.min(r.maxY - pad, y)),
      };
    }

    randomPointInsideFencePaddock() {
      const r = this.fencePaddocks?.[0];
      if (!r) return null;
      const pad = 10;
      const w = r.maxX - r.minX - pad * 2;
      const h = r.maxY - r.minY - pad * 2;
      if (w <= 4 || h <= 4) {
        return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
      }
      return {
        x: r.minX + pad + Math.random() * w,
        y: r.minY + pad + Math.random() * h,
      };
    }

    pushOutOfFencePaddocks(x, y, pad = 4) {
      let px = x;
      let py = y;
      for (const r of this.fencePaddocks || []) {
        if (px < r.minX || px > r.maxX || py < r.minY || py > r.maxY) continue;
        const dLeft = px - r.minX;
        const dRight = r.maxX - px;
        const dTop = py - r.minY;
        const dBot = r.maxY - py;
        const m = Math.min(dLeft, dRight, dTop, dBot);
        if (m === dLeft) px = r.minX - pad;
        else if (m === dRight) px = r.maxX + pad;
        else if (m === dTop) py = r.minY - pad;
        else py = r.maxY + pad;
      }
      return { x: px, y: py };
    }

    randomPlazaWalkPointAvoidingPools() {
      const p = this.plazaWalkBounds;
      if (!p) return null;
      for (let attempt = 0; attempt < 48; attempt++) {
        const tx = p.minX + Math.random() * (p.maxX - p.minX);
        const ty = p.minY + Math.random() * (p.maxY - p.minY);
        if (this.pointInAnyPlazaPool(tx, ty)) continue;
        if (this.pointInFencePaddock(tx, ty)) continue;
        return { x: tx, y: ty };
      }
      return {
        x: p.minX + Math.random() * (p.maxX - p.minX),
        y: p.minY + Math.random() * (p.maxY - p.minY),
      };
    }

    updatePlazaPoolFlow(now) {
      if (!this.plazaPools || !this.plazaPools.length) return;
      for (const pool of this.plazaPools) {
        const fg = pool.flowGraphics;
        if (!fg || !fg.active) continue;
        fg.clear();
        const t = now * 0.00165 + pool.flowPhase;
        const cx = pool.flowCx;
        const cy = pool.flowCy;
        const frx = pool.flowRx;
        const fry = pool.flowRy;
        const frot = pool.flowRot;
        const rings = [
          { col: 0xa8d8f0, a: 0.42, k: 1, lw: 2 },
          { col: 0xe8f6fc, a: 0.26, k: 1.55, lw: 1.5 },
        ];
        for (const ring of rings) {
          fg.lineStyle(ring.lw, ring.col, ring.a);
          fg.beginPath();
          const steps = 26;
          for (let s = 0; s <= steps; s++) {
            const u = (s / steps) * Math.PI * 2;
            const pulse = 0.74 + 0.11 * Math.sin(t * 1.05 + u * ring.k * 3.4);
            const lx = Math.cos(u + t * 0.18) * frx * pulse;
            const ly = Math.sin(u + t * 0.14) * fry * pulse;
            const wx = cx + lx * Math.cos(frot) - ly * Math.sin(frot);
            const wy = cy + lx * Math.sin(frot) + ly * Math.cos(frot);
            if (s === 0) fg.moveTo(wx, wy);
            else fg.lineTo(wx, wy);
          }
          fg.closePath();
          fg.strokePath();
        }
      }
    }

    /** 喷泉内池：水色脉动 + 椭圆波纹 + 游移高光 */
    updateFountainWater(now) {
      const g = this.fountainWaterG;
      if (!g || !g.active) return;
      g.clear();
      const t = now * 0.001;
      const hw = 12;
      const hh = 12;
      g.fillStyle(0x2e4f62, 0.92);
      g.fillRect(-hw, -hh, hw * 2, hh * 2);
      g.fillStyle(0x3d6a88, 0.72 + 0.14 * Math.sin(t * 2.3));
      g.fillRect(-hw + 1, -hh + 1, hw * 2 - 2, hh * 2 - 2);
      g.fillStyle(0x4a90c8, 0.38 + 0.16 * Math.sin(t * 2.8 + 0.6));
      g.fillRect(-hw + 2, -hh + 2, hw * 2 - 4, hh * 2 - 4);

      const wob = 0.92 + 0.06 * Math.sin(t * 1.5);
      for (let i = 0; i < 4; i++) {
        const ph = t * (2.4 + i * 0.33) + i * 1.4;
        const rx = 5 + i * 3.2 + Math.sin(ph) * 1.4;
        const ry = 4 + i * 2.6 + Math.cos(ph * 0.88) * 1.1;
        const a = 0.14 + 0.12 * (0.5 + 0.5 * Math.sin(ph * 2.1));
        g.lineStyle(1.2, 0xb8e8ff, a);
        g.strokeEllipse(0, 0, rx * 2 * wob, ry * 2 * wob);
      }

      g.fillStyle(0xffffff, 0.16 + 0.14 * Math.sin(t * 4.8));
      g.fillCircle(-3.5 + Math.sin(t * 2.2) * 4.5, -2 + Math.cos(t * 1.75) * 3.5, 2.2);
      g.fillStyle(0xffffff, 0.1 + 0.12 * Math.sin(t * 4 + 1.7));
      g.fillCircle(4 + Math.cos(t * 1.55) * 3.5, 3.2 + Math.sin(t * 2.25) * 2.8, 1.6);
      g.fillStyle(0xe8f4fc, 0.32 + 0.18 * Math.sin(t * 3.4 + 0.4));
      g.fillCircle(Math.sin(t * 1.85) * 2.5, -5 + Math.cos(t * 2.15), 2);
    }

    createPlazaZonePools() {
      this.plazaPools = [];
      const PS = this.plazaScale || 1;
      const PZ = PLAZA_ZONE_POOL_LINEAR_SCALE;
      const zones = [
        { x: -283 * PS, y: -215 * PS, water: 0x3a6f94, edge: 0x3d4d3a },
        { x: 283 * PS, y: -215 * PS, water: 0x3d7090, edge: 0x2f4d68 },
        { x: -283 * PS, y: 225 * PS, water: 0x387d8c, edge: 0x2d5648 },
        { x: 283 * PS, y: 225 * PS, water: 0x3e7895, edge: 0x305d72 },
      ];
      const dFill = 4;
      const dFlow = 4.07;
      const shapeOrder = [0, 1, 2, 3];
      for (let si = shapeOrder.length - 1; si > 0; si--) {
        const sj = Math.floor(Math.random() * (si + 1));
        [shapeOrder[si], shapeOrder[sj]] = [shapeOrder[sj], shapeOrder[si]];
      }

      zones.forEach((zc, zi) => {
        const shapeKind = shapeOrder[zi];
        const sgn = (v) => (v >= 0 ? 1 : -1);
        const pcx = zc.x + sgn(zc.x) * (38 + Math.random() * 24) * PS;
        const pcy = zc.y + sgn(zc.y) * (28 + Math.random() * 22) * PS;
        const g = this.add.graphics().setDepth(dFill);
        const flowGraphics = this.add.graphics().setDepth(dFlow);
        const tracePoly = (verts) => {
          g.beginPath();
          g.moveTo(verts[0].x, verts[0].y);
          for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x, verts[i].y);
          g.closePath();
        };

        g.fillStyle(zc.water, 0.91);
        g.lineStyle(Math.max(1, 3 * PS * PZ), zc.edge, 0.95);

        let pool;

        if (shapeKind === 0) {
          const rx = (34 + Math.random() * 10) * PS * PZ;
          const ry = (14 + Math.random() * 8) * PS * PZ;
          const rot = Math.random() * Math.PI;
          const steps = 26;
          g.beginPath();
          for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            const ex = rx * Math.cos(t);
            const ey = ry * Math.sin(t);
            const wx = pcx + ex * Math.cos(rot) - ey * Math.sin(rot);
            const wy = pcy + ex * Math.sin(rot) + ey * Math.cos(rot);
            if (i === 0) g.moveTo(wx, wy);
            else g.lineTo(wx, wy);
          }
          g.closePath();
          g.fillPath();
          g.strokePath();
          pool = {
            kind: "ellipse",
            cx: pcx,
            cy: pcy,
            rx,
            ry,
            rot,
            flowCx: pcx,
            flowCy: pcy,
            flowRx: rx * 0.74,
            flowRy: ry * 0.6,
            flowRot: rot,
            flowPhase: Math.random() * Math.PI * 2,
            flowGraphics,
          };
        } else if (shapeKind === 1) {
          const rx = (14 + Math.random() * 8) * PS * PZ;
          const ry = (32 + Math.random() * 12) * PS * PZ;
          const rot = Math.random() * Math.PI;
          const steps = 26;
          g.beginPath();
          for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            const ex = rx * Math.cos(t);
            const ey = ry * Math.sin(t);
            const wx = pcx + ex * Math.cos(rot) - ey * Math.sin(rot);
            const wy = pcy + ex * Math.sin(rot) + ey * Math.cos(rot);
            if (i === 0) g.moveTo(wx, wy);
            else g.lineTo(wx, wy);
          }
          g.closePath();
          g.fillPath();
          g.strokePath();
          pool = {
            kind: "ellipse",
            cx: pcx,
            cy: pcy,
            rx,
            ry,
            rot,
            flowCx: pcx,
            flowCy: pcy,
            flowRx: rx * 0.72,
            flowRy: ry * 0.58,
            flowRot: rot,
            flowPhase: Math.random() * Math.PI * 2,
            flowGraphics,
          };
        } else if (shapeKind === 2) {
          const n = 7;
          const verts = [];
          const r0 = (24 + Math.random() * 14) * PS * PZ;
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
            const rad = r0 * (0.68 + Math.random() * 0.38);
            verts.push({ x: pcx + Math.cos(ang) * rad, y: pcy + Math.sin(ang) * rad });
          }
          tracePoly(verts);
          g.fillPath();
          g.strokePath();
          let sx = 0;
          let sy = 0;
          for (const v of verts) {
            sx += v.x;
            sy += v.y;
          }
          sx /= n;
          sy /= n;
          let ar = 0;
          for (const v of verts) ar += Math.hypot(v.x - sx, v.y - sy);
          ar /= n;
          pool = {
            kind: "poly",
            verts,
            flowCx: sx,
            flowCy: sy,
            flowRx: ar * 0.76,
            flowRy: ar * 0.56,
            flowRot: Math.random() * Math.PI,
            flowPhase: Math.random() * Math.PI * 2,
            flowGraphics,
          };
        } else {
          const w = (28 + Math.random() * 10) * PS * PZ;
          const h = (17 + Math.random() * 9) * PS * PZ;
          const rot = Math.random() * Math.PI;
          const verts8 = [];
          for (let i = 0; i < 8; i++) {
            const u = (i / 8) * Math.PI * 2;
            const puff = 0.75 + 0.22 * Math.abs(Math.sin((i * Math.PI) / 4 + rot));
            verts8.push({
              x: pcx + Math.cos(u + rot) * w * puff,
              y: pcy + Math.sin(u + rot) * h * puff,
            });
          }
          tracePoly(verts8);
          g.fillPath();
          g.strokePath();
          let sx = 0;
          let sy = 0;
          for (const v of verts8) {
            sx += v.x;
            sy += v.y;
          }
          sx /= 8;
          sy /= 8;
          let ar = 0;
          for (const v of verts8) ar += Math.hypot(v.x - sx, v.y - sy);
          ar /= 8;
          pool = {
            kind: "poly",
            verts: verts8,
            flowCx: sx,
            flowCy: sy,
            flowRx: ar * 0.74,
            flowRy: ar * 0.55,
            flowRot: rot * 0.5,
            flowPhase: Math.random() * Math.PI * 2,
            flowGraphics,
          };
        }

        this.plazaPools.push(pool);
      });
    }

    clampPosToPlaza(x, y, sprite = null, allowInsidePools = false) {
      const b = this.plazaWalkBounds;
      let px = x;
      let py = y;
      if (b) {
        px = Math.max(b.minX, Math.min(b.maxX, x));
        py = Math.max(b.minY, Math.min(b.maxY, y));
      }
      if (!allowInsidePools && this.plazaPools && this.plazaPools.length) {
        const inPool = this.pointInAnyPlazaPool(px, py);
        if (sprite && sprite.active && inPool) {
          const tnow = this.time.now;
          if (sprite._plazaPoolEnterAt == null) sprite._plazaPoolEnterAt = tnow;
          if (tnow - sprite._plazaPoolEnterAt < PLAZA_POOL_ESCAPE_MS) {
            return { x: px, y: py };
          }
          sprite._plazaPoolEnterAt = null;
        } else if (sprite && sprite.active && !inPool) {
          sprite._plazaPoolEnterAt = null;
        }
        const q = this.pushOutOfPlazaPools(px, py, 11 * (this.plazaScale || 1));
        px = q.x;
        py = q.y;
      }
      if (this.fencePaddocks?.length) {
        if (sprite?._dragging) {
          // 拖拽时允许进出栏杆
        } else if (sprite?._fencePenned) {
          const f = this.clampInsideFencePaddock(px, py, 5 * (this.plazaScale || 1));
          px = f.x;
          py = f.y;
        } else {
          const f = this.pushOutOfFencePaddocks(px, py, 5 * (this.plazaScale || 1));
          px = f.x;
          py = f.y;
        }
      }
      return { x: px, y: py };
    }

    clampSpriteToPlaza(sprite, allowInsidePools = false) {
      const p = this.clampPosToPlaza(sprite.x, sprite.y, sprite, allowInsidePools);
      sprite.setPosition(p.x, p.y);
    }

    randomPointInsidePlazaPool(pool) {
      if (!pool) return { x: 0, y: 0 };
      if (pool.kind === "ellipse") {
        const u = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * 0.9;
        const lx = pool.rx * rr * Math.cos(u);
        const ly = pool.ry * rr * Math.sin(u);
        const c = Math.cos(pool.rot);
        const s = Math.sin(pool.rot);
        return {
          x: pool.cx + lx * c - ly * s,
          y: pool.cy + lx * s + ly * c,
        };
      }
      const verts = pool.verts;
      let sx = 0;
      let sy = 0;
      for (const v of verts) {
        sx += v.x;
        sy += v.y;
      }
      sx /= verts.length;
      sy /= verts.length;
      const reach = (pool.flowRx + pool.flowRy) * 0.55;
      for (let k = 0; k < 36; k++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * reach;
        const tx = sx + Math.cos(ang) * rad;
        const ty = sy + Math.sin(ang) * rad;
        if (this.pointInPlazaPool(pool, tx, ty)) return { x: tx, y: ty };
      }
      return { x: sx, y: sy };
    }

    /** 牛蛙短时上岸：距池岸法向 FROG_SHORE_OUT_MIN–FROG_SHORE_OUT_MAX 像素 */
    randomPointNearPlazaPool(pool) {
      if (!pool) return { x: 0, y: 0 };
      const ps = this.plazaScale || 1;
      const dist =
        (FROG_SHORE_OUT_MIN + Math.random() * (FROG_SHORE_OUT_MAX - FROG_SHORE_OUT_MIN)) * ps;
      for (let k = 0; k < 28; k++) {
        if (pool.kind === "ellipse") {
          const u = Math.random() * Math.PI * 2;
          const lx = pool.rx * Math.cos(u);
          const ly = pool.ry * Math.sin(u);
          const c = Math.cos(pool.rot);
          const s = Math.sin(pool.rot);
          const bx = pool.cx + lx * c - ly * s;
          const by = pool.cy + lx * s + ly * c;
          let nx = bx - pool.cx;
          let ny = by - pool.cy;
          const nl = Math.hypot(nx, ny) || 1;
          nx /= nl;
          ny /= nl;
          const wx = bx + nx * dist;
          const wy = by + ny * dist;
          if (!this.pointInPlazaPool(pool, wx, wy)) {
            return { x: wx, y: wy };
          }
        } else {
          const verts = pool.verts;
          const i = Math.floor(Math.random() * verts.length);
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          const t = Math.random();
          const bx = a.x + (b.x - a.x) * t;
          const by = a.y + (b.y - a.y) * t;
          let nx = -(b.y - a.y);
          let ny = b.x - a.x;
          const nl = Math.hypot(nx, ny) || 1;
          nx /= nl;
          ny /= nl;
          let sx = 0;
          let sy = 0;
          for (const v of verts) {
            sx += v.x;
            sy += v.y;
          }
          sx /= verts.length;
          sy /= verts.length;
          if ((bx - sx) * nx + (by - sy) * ny < 0) {
            nx = -nx;
            ny = -ny;
          }
          const wx = bx + nx * dist;
          const wy = by + ny * dist;
          if (!this.pointInPlazaPool(pool, wx, wy)) {
            return { x: wx, y: wy };
          }
        }
      }
      return this.randomPointInsidePlazaPool(pool);
    }

    nearestPointOnPlazaPoolBoundary(pool, wx, wy) {
      if (!pool) return null;
      if (pool.kind === "ellipse") {
        const dx = wx - pool.cx;
        const dy = wy - pool.cy;
        const c = Math.cos(-pool.rot);
        const s = Math.sin(-pool.rot);
        const lx = dx * c - dy * s;
        const ly = dx * s + dy * c;
        const k = Math.sqrt((lx / pool.rx) ** 2 + (ly / pool.ry) ** 2) || 1e-8;
        const blx = lx / k;
        const bly = ly / k;
        const c2 = Math.cos(pool.rot);
        const s2 = Math.sin(pool.rot);
        return {
          x: pool.cx + blx * c2 - bly * s2,
          y: pool.cy + blx * s2 + bly * c2,
        };
      }
      const verts = pool.verts;
      let best = null;
      let bestD = Infinity;
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];
        const q = plazaClosestOnSegment(wx, wy, a.x, a.y, b.x, b.y);
        const d = Math.hypot(wx - q.x, wy - q.y);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      return best;
    }

    clampFrogToPoolShore(fp) {
      if (!fp || !fp.active || !this.plazaPools || !this.plazaPools.length) return;
      const shoreMax = FROG_SHORE_OUT_MAX * (this.plazaScale || 1);
      const x = fp.x;
      const y = fp.y;
      if (this.pointInAnyPlazaPool(x, y)) return;
      let bestNb = null;
      let bestDist = Infinity;
      for (const pool of this.plazaPools) {
        const nb = this.nearestPointOnPlazaPoolBoundary(pool, x, y);
        if (!nb) continue;
        const d = Math.hypot(x - nb.x, y - nb.y);
        if (d < bestDist) {
          bestDist = d;
          bestNb = nb;
        }
      }
      if (!bestNb || bestDist <= shoreMax) return;
      const ux = (x - bestNb.x) / bestDist;
      const uy = (y - bestNb.y) / bestDist;
      fp.setPosition(bestNb.x + ux * shoreMax, bestNb.y + uy * shoreMax);
    }

    pickFrogTargetInPool(frog, poolIndex) {
      const pool = this.plazaPools?.[poolIndex];
      if (!pool) {
        this.pickFrogTarget(frog);
        return;
      }
      if (Math.random() < 0.52) {
        const p = this.randomPointInsidePlazaPool(pool);
        frog.target.x = p.x;
        frog.target.y = p.y;
      } else {
        const p = this.randomPointNearPlazaPool(pool);
        const c = this.clampPosToPlaza(p.x, p.y, null, true);
        frog.target.x = c.x;
        frog.target.y = c.y;
      }
    }

    pickFrogTarget(frog) {
      if (!this.plazaPools || !this.plazaPools.length) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          frog.target.x = pt.x;
          frog.target.y = pt.y;
        }
        return;
      }
      const pool = this.plazaPools[Math.floor(Math.random() * this.plazaPools.length)];
      if (Math.random() < 0.52) {
        const p = this.randomPointInsidePlazaPool(pool);
        frog.target.x = p.x;
        frog.target.y = p.y;
      } else {
        const p = this.randomPointNearPlazaPool(pool);
        const c = this.clampPosToPlaza(p.x, p.y, null, true);
        frog.target.x = c.x;
        frog.target.y = c.y;
      }
    }

    createFrogAt(x, y, poolIndex = 0) {
      const sprite = this.add
        .image(x, y, "frog")
        .setOrigin(0.5, 0.52)
        .setDepth(15.6)
        .setScale(0.58);
      return {
        sprite,
        home: { x, y },
        pondHome: { x, y },
        poolIndex,
        target: { x, y },
        retargetAt: 0,
        nextEatAt: 0,
        returningHome: false,
        vx: 0,
        vy: 0,
      };
    }

    findNearestTreeSpot(x, y, maxDist) {
      let best = null;
      let bestD = maxDist;
      for (const t of this.treeSpots) {
        const d = Math.hypot(x - t.x, y - t.y);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    }

    startArboreal(tree, now, lzEntry) {
      const perchY = tree.y - (14 + 16 * tree.scale);
      const sp = lzEntry.sprite;
      this.arboreal = {
        liz: lzEntry,
        baseX: tree.x,
        baseY: tree.y,
        scale: tree.scale,
        lizardPerchX: tree.x,
        lizardPerchY: perchY,
        catPerchX: tree.x + 8,
        catPerchY: perchY + 3,
        catJoined: false,
        lizardFled: false,
        lizardSoloDownAt: now + 10000,
        catDownAt: null,
        lizardFlip: sp.flipX,
      };
      const pc = this.clampPosToPlaza(tree.x, perchY, sp);
      sp.setPosition(pc.x, pc.y);
      sp.setDepth(20);
      sp.setFlipX(this.arboreal.lizardFlip);
      this.pickLizardTarget(lzEntry);
      lzEntry.retargetAt = now + 12000;
    }

    /** 猫够到树：蜥蜴沿「远离猫」方向落地并改目标逃走 */
    fleeLizardFromCatArboreal(a, cat, now) {
      const sp = a.liz.sprite;
      const ux = a.lizardPerchX - cat.x;
      const uy = a.lizardPerchY - cat.y;
      const ul = Math.hypot(ux, uy) || 1;
      let gx = a.lizardPerchX + (ux / ul) * 52;
      let gy = a.lizardPerchY + (uy / ul) * 52;
      const c0 = this.clampPosToPlaza(gx, gy, sp);
      gx = c0.x;
      gy = c0.y;
      sp.setPosition(gx, gy);
      sp.setDepth(16);
      const c1 = this.clampPosToPlaza(gx + (ux / ul) * 130, gy + (uy / ul) * 130);
      a.liz.target.x = c1.x;
      a.liz.target.y = c1.y;
      a.liz.retargetAt = now + 500;
    }

    /** 靠近喷泉时弹到主广场内层随机瓷砖中心；返回是否触发传送 */
    bounceIfNearFountain(sprite, now) {
      const g = this.plazaTileGrid;
      if (!sprite || !sprite.active || !g) return false;
      if (sprite._fountainImmuneUntil && now < sprite._fountainImmuneUntil) return false;
      if (Math.hypot(sprite.x, sprite.y) >= this.fountainTeleportRadius) return false;
      const { halfW, halfH, tile, cols, rows } = g;
      const avoidR = this.fountainTeleportRadius + 14 * (this.plazaScale || 1);
      let x;
      let y;
      let ok = false;
      for (let a = 0; a < 24; a++) {
        const cx = Math.floor(Math.random() * cols);
        const cy = Math.floor(Math.random() * rows);
        const px = -halfW + cx * tile + tile / 2;
        const py = -halfH + cy * tile + tile / 2;
        if (Math.hypot(px, py) >= avoidR && !this.pointInAnyPlazaPool(px, py)) {
          x = px;
          y = py;
          ok = true;
          break;
        }
      }
      if (!ok) {
        for (let a = 0; a < 48; a++) {
          const cx = Math.floor(Math.random() * cols);
          const cy = Math.floor(Math.random() * rows);
          const px = -halfW + cx * tile + tile / 2;
          const py = -halfH + cy * tile + tile / 2;
          if (!this.pointInAnyPlazaPool(px, py)) {
            x = px;
            y = py;
            ok = true;
            break;
          }
        }
      }
      if (!ok) {
        const fb = this.clampPosToPlaza(110 * (this.plazaScale || 1), 0);
        x = fb.x;
        y = fb.y;
      }
      sprite.x = x;
      sprite.y = y;
      sprite._fountainImmuneUntil = now + 800 + Math.random() * 700;
      return true;
    }

    preload() {}

    addLampWithGlow(x, y, depth, phaseMs) {
      const glow = this.add.circle(x, y - 10, 22, 0xf4a900, 0.12).setDepth(depth - 1);
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.06, to: 0.2 },
        duration: 900 + (phaseMs % 500),
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
      const lamp = this.add.image(x, y, "lamp").setOrigin(0.5).setDepth(depth);
      return lamp;
    }

    pickLizardTarget(lz) {
      const { x: hx, y: hy } = lz.home;
      for (let attempt = 0; attempt < 36; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 36 + Math.random() * 62;
        const c = this.clampPosToPlaza(hx + Math.cos(ang) * r, hy + Math.sin(ang) * r);
        if (!this.pointInAnyPlazaPool(c.x, c.y)) {
          lz.target.x = c.x;
          lz.target.y = c.y;
          return;
        }
      }
      const c0 = this.clampPosToPlaza(hx, hy);
      lz.target.x = c0.x;
      lz.target.y = c0.y;
    }

    nearestLizardEntry(cat) {
      if (!this.lizards.length) return null;
      let best = this.lizards[0];
      let bestD = Infinity;
      for (const lz of this.lizards) {
        const d = Math.hypot(lz.sprite.x - cat.x, lz.sprite.y - cat.y);
        if (d < bestD) {
          bestD = d;
          best = lz;
        }
      }
      return best;
    }

    createLizardEggAt(x, y, now) {
      const sprite = this.add
        .image(x, y, "lizardEgg")
        .setOrigin(0.5, 0.55)
        .setDepth(14.5)
        .setScale(0.72);
      return {
        sprite,
        hatchAt: now + LIZARD_EGG_HATCH_MS,
      };
    }

    spawnHatchLizardNear(x, y) {
      if (this.lizards.length >= MAX_LIZARDS) return;
      const c = this.clampPosToPlaza(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14);
      const lz = this.createLizardAt(c.x, c.y);
      lz.retargetAt = this.time.now + 500 + Math.random() * 400;
      this.pickLizardTarget(lz);
      this.lizards.push(lz);
    }

    createLizardAt(x, y, tint) {
      const color =
        tint ?? LIZARD_TINTS[Math.floor(Math.random() * LIZARD_TINTS.length)];
      const sprite = this.add.image(x, y, "lizard").setOrigin(0.5).setDepth(16);
      sprite.setTint(color);
      this.wireDogCommandTarget(sprite, "lizard");
      return {
        sprite,
        tint: color,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        vx: 0,
        vy: 0,
      };
    }

    pickMouseTarget(mouse) {
      const p = this.plazaWalkBounds;
      if (p) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          mouse.target.x = pt.x;
          mouse.target.y = pt.y;
        } else {
          mouse.target.x = p.minX + Math.random() * (p.maxX - p.minX);
          mouse.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        }
        return;
      }
      const r = this.mouseRoam;
      if (!r) {
        const { x: hx, y: hy } = mouse.home;
        for (let attempt = 0; attempt < 32; attempt++) {
          const ang = Math.random() * Math.PI * 2;
          const rad = 18 + Math.random() * 48;
          const c = this.clampPosToPlaza(hx + Math.cos(ang) * rad, hy + Math.sin(ang) * rad);
          if (!this.pointInAnyPlazaPool(c.x, c.y)) {
            mouse.target.x = c.x;
            mouse.target.y = c.y;
            return;
          }
        }
        const c = this.clampPosToPlaza(hx, hy);
        mouse.target.x = c.x;
        mouse.target.y = c.y;
        return;
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        const tx = r.minX + Math.random() * (r.maxX - r.minX);
        const ty = r.minY + Math.random() * (r.maxY - r.minY);
        if (!this.pointInAnyPlazaPool(tx, ty)) {
          mouse.target.x = tx;
          mouse.target.y = ty;
          return;
        }
      }
      mouse.target.x = r.minX + Math.random() * (r.maxX - r.minX);
      mouse.target.y = r.minY + Math.random() * (r.maxY - r.minY);
    }

    createMouseAt(x, y) {
      const sprite = this.add
        .image(x, y, "mouse")
        .setOrigin(0.5)
        .setDepth(16)
        .setScale(0.82);
      this.wireDogCommandTarget(sprite, "mouse");
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        nextRoachEatAt: 0,
        nextEggEatAt: 0,
        nextManholeAt: 0,
        vx: 0,
        vy: 0,
      };
    }

    pickRoachTarget(ro) {
      const p = this.plazaWalkBounds;
      if (p) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          ro.target.x = pt.x;
          ro.target.y = pt.y;
        } else {
          ro.target.x = p.minX + Math.random() * (p.maxX - p.minX);
          ro.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        }
        return;
      }
      const r = this.mouseRoam;
      if (r) {
        for (let attempt = 0; attempt < 40; attempt++) {
          const tx = r.minX + Math.random() * (r.maxX - r.minX);
          const ty = r.minY + Math.random() * (r.maxY - r.minY);
          if (!this.pointInAnyPlazaPool(tx, ty)) {
            ro.target.x = tx;
            ro.target.y = ty;
            return;
          }
        }
        ro.target.x = r.minX + Math.random() * (r.maxX - r.minX);
        ro.target.y = r.minY + Math.random() * (r.maxY - r.minY);
      }
    }

    pickRoachTargetAwayFromPredators(ro) {
      const rx = ro.sprite.x;
      const ry = ro.sprite.y;
      let cx = 0;
      let cy = 0;
      let n = 0;
      const add = (px, py) => {
        cx += px;
        cy += py;
        n += 1;
      };
      for (const lz of this.lizards || []) add(lz.sprite.x, lz.sprite.y);
      for (const snk of this.snakes || []) add(snk.sprite.x, snk.sprite.y);
      for (const fr of this.frogs || []) {
        if (fr.sprite?.active) add(fr.sprite.x, fr.sprite.y);
      }
      for (const m of this.mice || []) add(m.sprite.x, m.sprite.y);
      for (const sv of this.sparrows || []) add(sv.sprite.x, sv.sprite.y);
      if (!n) {
        this.pickRoachTarget(ro);
        return;
      }
      cx /= n;
      cy /= n;
      const awayX = rx - cx;
      const awayY = ry - cy;
      const al = Math.hypot(awayX, awayY) || 1;
      const dist = 90 + Math.random() * 110;
      const tx = rx + (awayX / al) * dist + (Math.random() - 0.5) * 36;
      const ty = ry + (awayY / al) * dist + (Math.random() - 0.5) * 36;
      const c = this.clampPosToPlaza(tx, ty);
      ro.target.x = c.x;
      ro.target.y = c.y;
    }

    createRoachAt(x, y) {
      const sprite = this.add
        .image(x, y, "roach")
        .setOrigin(0.5)
        .setDepth(15)
        .setScale(0.25);
      this.wireDogCommandTarget(sprite, "roach");
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        nextManholeAt: 0,
        vx: 0,
        vy: 0,
      };
    }

    pickSnakeTarget(snk) {
      const p = this.plazaWalkBounds;
      if (p) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          snk.target.x = pt.x;
          snk.target.y = pt.y;
        } else {
          snk.target.x = p.minX + Math.random() * (p.maxX - p.minX);
          snk.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        }
        return;
      }
      const r = this.mouseRoam;
      if (r) {
        for (let attempt = 0; attempt < 40; attempt++) {
          const tx = r.minX + Math.random() * (r.maxX - r.minX);
          const ty = r.minY + Math.random() * (r.maxY - r.minY);
          if (!this.pointInAnyPlazaPool(tx, ty)) {
            snk.target.x = tx;
            snk.target.y = ty;
            return;
          }
        }
        snk.target.x = r.minX + Math.random() * (r.maxX - r.minX);
        snk.target.y = r.minY + Math.random() * (r.maxY - r.minY);
      }
    }

    createSnakeAt(x, y, tint) {
      const sprite = this.add
        .image(x, y, "snake")
        .setOrigin(0.5, 0.5)
        .setDepth(15)
        .setScale(0.88);
      sprite.setTint(tint);
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        wrigglePhase: Math.random() * Math.PI * 2,
        nextEatMouseAt: 0,
        nextEatRoachAt: 0,
        nextEatEggAt: 0,
        nextEatLizardAt: 0,
        nextEatSparrowEggAt: 0,
        /** @type {{ egg: object, tree: object, phase: string } | null} */
        treeEggClimb: null,
        chasingSparrow: null,
        vx: 0,
        vy: 0,
      };
    }

    isDogHunting(now = this.time.now) {
      const dog = this.dog;
      if (!dog?.sprite?.active) return false;
      return now >= (dog.restUntil || 0);
    }

    pickDogTarget(dog) {
      const p = this.plazaWalkBounds;
      if (p) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          dog.target.x = pt.x;
          dog.target.y = pt.y;
        } else {
          dog.target.x = p.minX + Math.random() * (p.maxX - p.minX);
          dog.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        }
        return;
      }
      const r = this.mouseRoam;
      if (r) {
        dog.target.x = r.minX + Math.random() * (r.maxX - r.minX);
        dog.target.y = r.minY + Math.random() * (r.maxY - r.minY);
      }
    }

    createDogAt(x, y) {
      const sprite = this.add
        .image(x, y, "dog")
        .setOrigin(0.5)
        .setDepth(15.2)
        .setScale(1.2);
      sprite.setInteractive({ useHandCursor: true });
      sprite.on("pointerdown", (pointer) => {
        if (pointer?.event?.stopPropagation) pointer.event.stopPropagation();
        this.setDogSelectArmed(!this.dogSelectArmed);
      });
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        restUntil: 0,
        huntStartedAt: 0,
        chaseKind: null,
        chaseSnake: null,
        chaseFrog: null,
        chaseChicken: null,
        chaseWeasel: null,
        nextChickenChaseAt: 0,
        /** @type {{ kind: string, sprite: Phaser.GameObjects.Image } | null} */
        commandPrey: null,
        vx: 0,
        vy: 0,
      };
    }

    setDogSelectArmed(on) {
      this.dogSelectArmed = !!on;
      const sp = this.dog?.sprite;
      if (sp?.active) {
        if (this.dogSelectArmed) sp.setTint(0xffd27a);
        else sp.clearTint();
      }
    }

    wireDogCommandTarget(sprite, kind) {
      if (!sprite) return;
      const pad = kind === "roach" ? 18 : 10;
      const w = Math.max(28, (sprite.width || 16) + pad * 2);
      const h = Math.max(28, (sprite.height || 12) + pad * 2);
      sprite.setInteractive({
        hitArea: new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
        hitAreaCallback: Phaser.Geom.Rectangle.Contains,
        useHandCursor: true,
      });
      sprite.on("pointerdown", (pointer) => {
        if (pointer?.event?.stopPropagation) pointer.event.stopPropagation();
        if (!this.dogSelectArmed) return;
        this.dogAssignCommandPrey(kind, sprite);
      });
    }

    dogAssignCommandPrey(kind, sprite) {
      const dog = this.dog;
      if (!dog?.sprite?.active || !sprite?.active) return;
      if (!["mouse", "lizard", "roach"].includes(kind)) return;
      dog.commandPrey = { kind, sprite };
      dog.restUntil = 0;
      dog.huntStartedAt = 0;
      this.setDogSelectArmed(false);
    }

    dogConsumePrey(kind, sprite, now) {
      if (!sprite?.active) return false;
      if (kind === "mouse") {
        const idx = this.mice.findIndex((mm) => mm.sprite === sprite);
        if (idx < 0) return false;
        if (this.anyCatChasingMouse(sprite)) this.clearCatChaseOfMouse(sprite);
        sprite.destroy();
        this.mice.splice(idx, 1);
        return true;
      }
      if (kind === "lizard") {
        const idx = this.lizards.findIndex((lz) => lz.sprite === sprite);
        if (idx < 0) return false;
        const lz = this.lizards[idx];
        if (this.arboreal && this.arboreal.liz === lz) this.arboreal = null;
        sprite.destroy();
        this.lizards.splice(idx, 1);
        return true;
      }
      if (kind === "roach") {
        const idx = this.roaches.findIndex((ro) => ro.sprite === sprite);
        if (idx < 0) return false;
        return this.removeRoachAt(idx, now);
      }
      return false;
    }

    resolveDogCommandPrey(dog) {
      const cmd = dog.commandPrey;
      if (!cmd?.sprite?.active) {
        dog.commandPrey = null;
        return null;
      }
      const { kind, sprite } = cmd;
      let alive = false;
      if (kind === "mouse") alive = this.mice.some((m) => m.sprite === sprite);
      else if (kind === "lizard") alive = this.lizards.some((lz) => lz.sprite === sprite);
      else if (kind === "roach") alive = this.roaches.some((ro) => ro.sprite === sprite);
      if (!alive) {
        dog.commandPrey = null;
        return null;
      }
      return {
        kind,
        sprite,
        x: sprite.x,
        y: sprite.y,
        d: Math.hypot(sprite.x - dog.sprite.x, sprite.y - dog.sprite.y),
      };
    }

    /** 狗当前追猎目标：猫 / 蛇 / 牛蛙中最近者（猎物被抓后不消失） */
    resolveDogPrey(dog) {
      const sp = dog.sprite;
      let bestD = Infinity;
      let best = null;
      const consider = (kind, x, y, extra = {}) => {
        const d = Math.hypot(x - sp.x, y - sp.y);
        if (d < bestD) {
          bestD = d;
          best = { kind, x, y, d, ...extra };
        }
      };
      for (const ce of this.activeCatEntries()) {
        consider("cat", ce.sprite.x, ce.sprite.y);
      }
      for (const snk of this.snakes || []) {
        if (!snk.sprite?.active) continue;
        if (snk.treeEggClimb) continue;
        consider("snake", snk.sprite.x, snk.sprite.y, { snake: snk });
      }
      for (const fr of this.frogs || []) {
        if (!fr.sprite?.active) continue;
        if (fr.returningHome) continue;
        consider("frog", fr.sprite.x, fr.sprite.y, { frog: fr });
      }
      return best;
    }

    applyFleeFromDog(x, y, now, dt) {
      if (!this.isDogHunting(now)) return { x, y, fled: false };
      const dog = this.dog?.sprite;
      if (!dog?.active) return { x, y, fled: false };
      const dx = x - dog.x;
      const dy = y - dog.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d >= DOG_FLEE_RANGE) return { x, y, fled: false };
      const push = DOG_FLEE_SPEED * dt;
      return { x: x + (dx / d) * push, y: y + (dy / d) * push, fled: true };
    }

    beginDogRest(dog, now) {
      dog.restUntil = now + DOG_REST_MS;
      dog.huntStartedAt = 0;
      dog.chaseKind = null;
      dog.chaseSnake = null;
      dog.chaseFrog = null;
      dog.chaseWeasel = null;
      // 不清除 chaseChicken：追鸡周期单独用 nextChickenChaseAt
    }

    pickChickenTarget(ch) {
      if (ch.penned) {
        const pt = this.randomPointInsideFencePaddock();
        if (pt) {
          ch.target.x = pt.x;
          ch.target.y = pt.y;
          return;
        }
      }
      const p = this.plazaWalkBounds;
      if (p) {
        const pt = this.randomPlazaWalkPointAvoidingPools();
        if (pt) {
          ch.target.x = pt.x;
          ch.target.y = pt.y;
        } else {
          ch.target.x = p.minX + Math.random() * (p.maxX - p.minX);
          ch.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        }
        return;
      }
      ch.target.x = ch.home.x + (Math.random() - 0.5) * 120;
      ch.target.y = ch.home.y + (Math.random() - 0.5) * 100;
    }

    createChickenAt(x, y) {
      const sprite = this.add
        .image(x, y, "chicken")
        .setOrigin(0.5, 0.55)
        .setDepth(15.4)
        .setScale(0.95);
      const ch = {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        dogChaseCount: 0,
        penned: false,
        dragging: false,
        vx: 0,
        vy: 0,
      };
      this.wireFenceDraggableAnimal(ch);
      return ch;
    }

    createChickenEggAt(x, y, now) {
      const sprite = this.add
        .image(x, y, "chickenEgg")
        .setOrigin(0.5, 0.55)
        .setDepth(14.2)
        .setScale(0.7);
      return {
        sprite,
        hatchAt: now + CHICKEN_EGG_HATCH_MS,
      };
    }

    killChicken(ch, now) {
      if (!ch) return;
      const idx = this.chickens.indexOf(ch);
      if (idx < 0) return;
      if (this.dog?.chaseChicken === ch) this.dog.chaseChicken = null;
      ch.sprite?.destroy();
      this.chickens.splice(idx, 1);
    }

    pickSheepWanderTarget(sh) {
      if (sh.penned) {
        const pt = this.randomPointInsideFencePaddock();
        if (pt) {
          sh.target.x = pt.x;
          sh.target.y = pt.y;
          return;
        }
      }
      const pt = this.randomPlazaWalkPointAvoidingPools();
      if (pt) {
        sh.target.x = pt.x;
        sh.target.y = pt.y;
        return;
      }
      sh.target.x = sh.home.x + (Math.random() - 0.5) * 140;
      sh.target.y = sh.home.y + (Math.random() - 0.5) * 110;
    }

    createSheepAt(x, y) {
      const sprite = this.add
        .image(x, y, "sheep")
        .setOrigin(0.5, 0.55)
        .setDepth(15.35)
        .setScale(1.45);
      const sh = {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        /** @type {number|null} */
        lawnIndex: null,
        nextEatAt: 0,
        penned: false,
        dragging: false,
        vx: 0,
        vy: 0,
      };
      this.wireFenceDraggableAnimal(sh);
      return sh;
    }

    wireFenceDraggableAnimal(body) {
      const sprite = body.sprite;
      if (!sprite) return;
      sprite.setInteractive({ useHandCursor: true });
      this.input.setDraggable(sprite);
      sprite.on("dragstart", (pointer) => {
        if (pointer?.event?.stopPropagation) pointer.event.stopPropagation();
        body.dragging = true;
        sprite._dragging = true;
        this._draggingFenceAnimal = true;
        sprite.setDepth((sprite.depth || 15) + 2);
        body.vx = 0;
        body.vy = 0;
      });
      sprite.on("drag", (_pointer, dragX, dragY) => {
        sprite.setPosition(dragX, dragY);
        // 拖拽时避开水池，但不强制进出栏杆
        const p = this.clampPosToPlaza(dragX, dragY, sprite, false);
        sprite.setPosition(p.x, p.y);
      });
      sprite.on("dragend", () => {
        body.dragging = false;
        sprite._dragging = false;
        this._draggingFenceAnimal = false;
        sprite.setDepth(sprite.texture?.key === "sheep" ? 15.35 : 15.4);
        const inside = this.pointInFencePaddock(sprite.x, sprite.y);
        body.penned = inside;
        sprite._fencePenned = inside;
        body.home.x = sprite.x;
        body.home.y = sprite.y;
        body.lawnIndex = null;
        if (inside) {
          const pt = this.randomPointInsideFencePaddock();
          if (pt) {
            body.target.x = pt.x;
            body.target.y = pt.y;
          }
          const kept = this.clampInsideFencePaddock(sprite.x, sprite.y, 5 * (this.plazaScale || 1));
          sprite.setPosition(kept.x, kept.y);
        } else {
          this.clampSpriteToPlaza(sprite);
        }
        body.retargetAt = this.time.now + 200;
      });
    }

    lawnPatchHasGrass(patch, sheep = null) {
      if (!patch?.tiles?.length) return false;
      if (sheep?.penned) {
        if (!patch.fenced) return false;
      } else if (patch.fenced) {
        return false;
      }
      return patch.tiles.some((t) => !t.eaten && t.sprite?.active);
    }

    findNearestGrassTileInPatch(patch, x, y) {
      if (!patch?.tiles) return null;
      let best = null;
      let bestD = Infinity;
      for (const tile of patch.tiles) {
        if (tile.eaten || !tile.sprite?.active) continue;
        const d = Math.hypot(tile.cx - x, tile.cy - y);
        if (d < bestD) {
          bestD = d;
          best = tile;
        }
      }
      return best ? { tile: best, dist: bestD } : null;
    }

    pickSheepLawn(sh, x, y) {
      const patches = this.lawnPatches || [];
      if (!patches.length) {
        sh.lawnIndex = null;
        return null;
      }
      if (sh.lawnIndex != null) {
        const cur = patches[sh.lawnIndex];
        if (this.lawnPatchHasGrass(cur, sh)) return cur;
        sh.lawnIndex = null;
      }
      const claimed = new Set();
      for (const other of this.sheep || []) {
        if (other === sh) continue;
        if (other.lawnIndex != null) claimed.add(other.lawnIndex);
      }
      let bestI = -1;
      let bestD = Infinity;
      let fallbackI = -1;
      let fallbackD = Infinity;
      for (let i = 0; i < patches.length; i++) {
        if (!this.lawnPatchHasGrass(patches[i], sh)) continue;
        const d = Math.hypot(patches[i].cx - x, patches[i].cy - y);
        if (d < fallbackD) {
          fallbackD = d;
          fallbackI = i;
        }
        if (claimed.has(i)) continue;
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const pick = bestI >= 0 ? bestI : fallbackI;
      if (pick < 0) {
        sh.lawnIndex = null;
        return null;
      }
      sh.lawnIndex = pick;
      return patches[pick];
    }

    eatLawnTile(tile, now) {
      if (!tile || tile.eaten) return false;
      tile.eaten = true;
      tile.regrowAt = now + SHEEP_GRASS_REGROW_MS;
      if (tile.sprite?.active) {
        tile.sprite.setVisible(false);
      }
      return true;
    }

    updateLawnRegrowth(now) {
      for (const patch of this.lawnPatches || []) {
        for (const tile of patch.tiles) {
          if (!tile.eaten) continue;
          if (now < (tile.regrowAt || 0)) continue;
          tile.eaten = false;
          tile.regrowAt = 0;
          if (tile.sprite?.active) tile.sprite.setVisible(true);
        }
      }
    }

    updateSheep(now, dt) {
      this.updateLawnRegrowth(now);
      for (const sh of this.sheep || []) {
        if (!sh.sprite?.active) continue;
        if (sh.dragging) continue;
        const sp = sh.sprite;
        let x = sp.x;
        let y = sp.y;
        const lawn = this.pickSheepLawn(sh, x, y);
        const grass = lawn ? this.findNearestGrassTileInPatch(lawn, x, y) : null;

        if (grass) {
          const tx = grass.tile.cx - x;
          const ty = grass.tile.cy - y;
          const sm = this.smoothSteer(sh, tx, ty, SHEEP_SPEED * ANIMAL_SPEED_MULT, dt);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
          if (grass.dist < SHEEP_EAT_DIST && now >= (sh.nextEatAt || 0)) {
            if (this.eatLawnTile(grass.tile, now)) {
              sh.nextEatAt = now + SHEEP_EAT_COOLDOWN_MS;
            }
          }
        } else {
          if (now > sh.retargetAt) {
            sh.retargetAt = now + 1800 + Math.random() * 1600;
            this.pickSheepWanderTarget(sh);
          }
          let tx = sh.target.x - x;
          let ty = sh.target.y - y;
          let len = Math.hypot(tx, ty) || 1;
          if (len < 10) {
            this.pickSheepWanderTarget(sh);
            tx = sh.target.x - x;
            ty = sh.target.y - y;
          }
          const sm = this.smoothSteer(sh, tx, ty, SHEEP_SPEED * 0.85 * ANIMAL_SPEED_MULT, dt);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
        }

        sp.setPosition(x, y);
        this.clampSpriteToPlaza(sp);
        if (!sh.penned && this.bounceIfNearFountain(sp, now)) {
          sh.home.x = sp.x;
          sh.home.y = sp.y;
          this.pickSheepWanderTarget(sh);
          sh.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(sp);
      }
    }

    pickWeaselTarget(w) {
      const pt = this.randomPlazaWalkPointAvoidingPools();
      if (pt) {
        w.target.x = pt.x;
        w.target.y = pt.y;
        return;
      }
      w.target.x = w.home.x + (Math.random() - 0.5) * 160;
      w.target.y = w.home.y + (Math.random() - 0.5) * 120;
    }

    createWeaselAt(x, y) {
      const sprite = this.add
        .image(x, y, "weasel")
        .setOrigin(0.5, 0.55)
        .setDepth(15.45)
        .setScale(1.05);
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        chaseChicken: null,
        huntingChicken: false,
        fleeUntil: 0,
        vx: 0,
        vy: 0,
      };
    }

    findWeaselChickenPrey(wx, wy) {
      let best = null;
      let bestD = WEASEL_HUNT_RANGE;
      for (const ch of this.chickens || []) {
        if (!ch.sprite?.active || ch.penned || ch.dragging) continue;
        const d = Math.hypot(ch.sprite.x - wx, ch.sprite.y - wy);
        if (d < bestD) {
          bestD = d;
          best = ch;
        }
      }
      return best ? { chicken: best, dist: bestD } : null;
    }

    nearestWeaselThreat(x, y, maxDist = CHICKEN_FLEE_WEASEL_RANGE) {
      let best = null;
      let bestD = maxDist;
      for (const w of this.weasels || []) {
        if (!w.sprite?.active) continue;
        const d = Math.hypot(w.sprite.x - x, w.sprite.y - y);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      return best ? { weasel: best, dist: bestD } : null;
    }

    resolveDogWeaselChase(dog, now) {
      if (dog.chaseWeasel) {
        const alive = this.weasels.find(
          (w) =>
            w === dog.chaseWeasel &&
            w.sprite?.active &&
            now >= (w.fleeUntil || 0) &&
            (w.huntingChicken || w.chaseChicken),
        );
        if (alive) {
          return {
            weasel: alive,
            x: alive.sprite.x,
            y: alive.sprite.y,
            d: Math.hypot(alive.sprite.x - dog.sprite.x, alive.sprite.y - dog.sprite.y),
          };
        }
        dog.chaseWeasel = null;
      }
      let best = null;
      let bestD = Infinity;
      for (const w of this.weasels || []) {
        if (!w.sprite?.active) continue;
        if (now < (w.fleeUntil || 0)) continue;
        if (!(w.huntingChicken || w.chaseChicken)) continue;
        const d = Math.hypot(w.sprite.x - dog.sprite.x, w.sprite.y - dog.sprite.y);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      if (!best) return null;
      dog.chaseWeasel = best;
      return {
        weasel: best,
        x: best.sprite.x,
        y: best.sprite.y,
        d: bestD,
      };
    }

    onDogCaughtWeasel(w, now) {
      if (!w?.sprite?.active) return;
      w.chaseChicken = null;
      w.huntingChicken = false;
      w.fleeUntil = now + WEASEL_FLEE_AFTER_DOG_MS;
      w.vx = 0;
      w.vy = 0;
      this.pickWeaselTarget(w);
      w.retargetAt = now + 400;
    }

    updateWeasels(now, dt) {
      const dogSp = this.dog?.sprite;
      for (const w of this.weasels || []) {
        if (!w.sprite?.active) continue;
        const sp = w.sprite;
        let x = sp.x;
        let y = sp.y;
        const fleeing = now < (w.fleeUntil || 0);

        if (fleeing && dogSp?.active) {
          w.chaseChicken = null;
          w.huntingChicken = false;
          const dx = x - dogSp.x;
          const dy = y - dogSp.y;
          const sm = this.smoothSteer(w, dx, dy, WEASEL_FLEE_DOG_SPEED * ANIMAL_SPEED_MULT, dt, ANIMAL_STEER_ACCEL * 1.4);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
        } else {
          let prey = null;
          if (w.chaseChicken) {
            const alive =
              this.chickens.find((c) => c === w.chaseChicken && c.sprite?.active && !c.penned && !c.dragging) ||
              null;
            if (alive) {
              prey = {
                chicken: alive,
                dist: Math.hypot(alive.sprite.x - x, alive.sprite.y - y),
              };
            } else {
              w.chaseChicken = null;
            }
          }
          if (!prey) {
            prey = this.findWeaselChickenPrey(x, y);
            if (prey) w.chaseChicken = prey.chicken;
          }

          if (prey) {
            w.huntingChicken = true;
            const tx = prey.chicken.sprite.x - x;
            const ty = prey.chicken.sprite.y - y;
            const sm = this.smoothSteer(w, tx, ty, WEASEL_SPEED * 1.15 * ANIMAL_SPEED_MULT, dt);
            x += sm.dx;
            y += sm.dy;
            if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
            if (prey.dist < WEASEL_EAT_DIST) {
              this.killChicken(prey.chicken, now);
              w.chaseChicken = null;
              w.huntingChicken = false;
              w.retargetAt = now + 800;
              this.pickWeaselTarget(w);
            }
          } else {
            w.huntingChicken = false;
            w.chaseChicken = null;
            if (now > w.retargetAt) {
              w.retargetAt = now + 1600 + Math.random() * 1400;
              this.pickWeaselTarget(w);
            }
            let tx = w.target.x - x;
            let ty = w.target.y - y;
            let len = Math.hypot(tx, ty) || 1;
            if (len < 10) {
              this.pickWeaselTarget(w);
              tx = w.target.x - x;
              ty = w.target.y - y;
            }
            const sm = this.smoothSteer(w, tx, ty, WEASEL_SPEED * ANIMAL_SPEED_MULT, dt);
            x += sm.dx;
            y += sm.dy;
            if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
          }
        }

        sp.setPosition(x, y);
        this.clampSpriteToPlaza(sp);
        if (this.bounceIfNearFountain(sp, now)) {
          w.home.x = sp.x;
          w.home.y = sp.y;
          this.pickWeaselTarget(w);
          w.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(sp);
      }
    }

    onDogCaughtChicken(ch, now) {
      if (!ch?.sprite?.active) return;
      ch.dogChaseCount = (ch.dogChaseCount || 0) + 1;
      if (ch.dogChaseCount >= CHICKEN_DOG_CHASEES_TO_DIE) {
        this.killChicken(ch, now);
      }
    }

    resolveDogChickenChase(dog, now) {
      if (dog.chaseChicken) {
        const alive = this.chickens.find(
          (c) => c === dog.chaseChicken && c.sprite?.active && !c.penned && !c.dragging,
        );
        if (alive) {
          return {
            chicken: alive,
            x: alive.sprite.x,
            y: alive.sprite.y,
            d: Math.hypot(alive.sprite.x - dog.sprite.x, alive.sprite.y - dog.sprite.y),
          };
        }
        dog.chaseChicken = null;
      }
      if (now < (dog.nextChickenChaseAt || 0)) return null;
      if (!this.chickens.length) return null;
      let best = null;
      let bestD = Infinity;
      for (const ch of this.chickens) {
        if (!ch.sprite?.active || ch.penned || ch.dragging) continue;
        const d = Math.hypot(ch.sprite.x - dog.sprite.x, ch.sprite.y - dog.sprite.y);
        if (d < bestD) {
          bestD = d;
          best = ch;
        }
      }
      if (!best) return null;
      dog.chaseChicken = best;
      dog.restUntil = 0;
      dog.huntStartedAt = 0;
      return {
        chicken: best,
        x: best.sprite.x,
        y: best.sprite.y,
        d: bestD,
      };
    }

    updateChickens(now, dt) {
      const dog = this.dog;
      const dogSp = dog?.sprite;
      const chasing = dog?.chaseChicken || null;

      for (let ei = this.chickenEggs.length - 1; ei >= 0; ei--) {
        const egg = this.chickenEggs[ei];
        if (now < egg.hatchAt) continue;
        if (this.chickens.length < MAX_CHICKENS && egg.sprite?.active) {
          const c = this.clampPosToPlaza(egg.sprite.x, egg.sprite.y);
          const ch = this.createChickenAt(c.x, c.y);
          this.pickChickenTarget(ch);
          ch.retargetAt = now + 400;
          this.chickens.push(ch);
        }
        egg.sprite?.destroy();
        this.chickenEggs.splice(ei, 1);
      }

      if (
        this.chickens.length > 0 &&
        this.chickens.length < MAX_CHICKENS &&
        now >= this._nextChickenLayAt
      ) {
        this._nextChickenLayAt = now + CHICKEN_LAY_INTERVAL_MS + Math.random() * 12000;
        const layer = this.chickens[Math.floor(Math.random() * this.chickens.length)];
        if (layer?.sprite?.active) {
          const c = this.clampPosToPlaza(
            layer.sprite.x + (Math.random() - 0.5) * 12,
            layer.sprite.y + (Math.random() - 0.5) * 12,
          );
          this.chickenEggs.push(this.createChickenEggAt(c.x, c.y, now));
        }
      } else if (this.chickens.length >= MAX_CHICKENS && now >= this._nextChickenLayAt) {
        // 满员也生蛋（不孵化直到有空位）
        this._nextChickenLayAt = now + CHICKEN_LAY_INTERVAL_MS + Math.random() * 12000;
        const layer = this.chickens[Math.floor(Math.random() * this.chickens.length)];
        if (layer?.sprite?.active && this.chickenEggs.length < 8) {
          const c = this.clampPosToPlaza(
            layer.sprite.x + (Math.random() - 0.5) * 12,
            layer.sprite.y + (Math.random() - 0.5) * 12,
          );
          this.chickenEggs.push(this.createChickenEggAt(c.x, c.y, now));
        }
      }

      for (const ch of this.chickens) {
        if (!ch.sprite?.active) continue;
        if (ch.dragging) continue;
        const sp = ch.sprite;
        let x = sp.x;
        let y = sp.y;
        const fleeingDog = !ch.penned && chasing === ch && dogSp?.active;
        const weaselThreat =
          !ch.penned && !fleeingDog ? this.nearestWeaselThreat(x, y, CHICKEN_FLEE_WEASEL_RANGE) : null;

        if (fleeingDog) {
          const dx = x - dogSp.x;
          const dy = y - dogSp.y;
          const sm = this.smoothSteer(ch, dx, dy, CHICKEN_FLEE_DOG_SPEED * ANIMAL_SPEED_MULT, dt, ANIMAL_STEER_ACCEL * 1.4);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
        } else if (weaselThreat) {
          const wx = weaselThreat.weasel.sprite.x;
          const wy = weaselThreat.weasel.sprite.y;
          const dx = x - wx;
          const dy = y - wy;
          const sm = this.smoothSteer(ch, dx, dy, CHICKEN_FLEE_WEASEL_SPEED * ANIMAL_SPEED_MULT, dt, ANIMAL_STEER_ACCEL * 1.35);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
        } else if (ch.penned) {
          if (now > ch.retargetAt) {
            ch.retargetAt = now + 1600 + Math.random() * 1400;
            this.pickChickenTarget(ch);
          }
          let tx = ch.target.x - x;
          let ty = ch.target.y - y;
          let len = Math.hypot(tx, ty) || 1;
          if (len < 8) {
            this.pickChickenTarget(ch);
            tx = ch.target.x - x;
            ty = ch.target.y - y;
          }
          const sm = this.smoothSteer(ch, tx, ty, CHICKEN_SPEED * ANIMAL_SPEED_MULT, dt);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
        } else {
          let huntRoach = null;
          let huntApple = null;
          let bestD = CHICKEN_ROACH_HUNT_RANGE;
          for (const ro of this.roaches || []) {
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            const d = Math.hypot(ro.sprite.x - x, ro.sprite.y - y);
            if (d < bestD) {
              bestD = d;
              huntRoach = ro;
              huntApple = null;
            }
          }
          const landApple = this.findNearestLandApple(x, y, CHICKEN_ROACH_HUNT_RANGE);
          if (landApple && landApple.dist < bestD) {
            bestD = landApple.dist;
            huntRoach = null;
            huntApple = landApple;
          }
          if (huntRoach || huntApple) {
            const tx = huntRoach ? huntRoach.sprite.x - x : huntApple.ap.sprite.x - x;
            const ty = huntRoach ? huntRoach.sprite.y - y : huntApple.ap.sprite.y - y;
            const sm = this.smoothSteer(ch, tx, ty, CHICKEN_SPEED * 1.15 * ANIMAL_SPEED_MULT, dt);
            x += sm.dx;
            y += sm.dy;
            if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
            if (huntRoach && bestD < CHICKEN_ROACH_EAT_DIST) {
              const ri = this.roaches.indexOf(huntRoach);
              if (ri >= 0) this.removeRoachAt(ri, now);
            } else if (huntApple && bestD < APPLE_EAT_DIST) {
              this.removeFallenAppleAt(huntApple.index);
            }
          } else {
            if (now > ch.retargetAt) {
              ch.retargetAt = now + 1600 + Math.random() * 1400;
              this.pickChickenTarget(ch);
            }
            let tx = ch.target.x - x;
            let ty = ch.target.y - y;
            let len = Math.hypot(tx, ty) || 1;
            if (len < 8) {
              this.pickChickenTarget(ch);
              tx = ch.target.x - x;
              ty = ch.target.y - y;
            }
            const sm = this.smoothSteer(ch, tx, ty, CHICKEN_SPEED * ANIMAL_SPEED_MULT, dt);
            x += sm.dx;
            y += sm.dy;
            if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx < 0);
          }
        }

        sp.setPosition(x, y);
        this.clampSpriteToPlaza(sp);
        if (!ch.penned && this.bounceIfNearFountain(sp, now)) {
          ch.home.x = sp.x;
          ch.home.y = sp.y;
          this.pickChickenTarget(ch);
          ch.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(sp);
      }
    }

    updateDog(now, dt) {
      const dog = this.dog;
      if (!dog?.sprite?.active) return;
      const sp = dog.sprite;
      let x = sp.x;
      let y = sp.y;
      const cmdPrey = this.resolveDogCommandPrey(dog);

      if (cmdPrey) {
        // 点选命令：追老鼠/蜥蜴/蟑螂，追上后吃掉
        const tx = cmdPrey.x - x;
        const ty = cmdPrey.y - y;
        const sm = this.smoothSteer(dog, tx, ty, DOG_HUNT_SPEED * ANIMAL_SPEED_MULT, dt);
        x += sm.dx;
        y += sm.dy;
        this.applyAnimalFlip(sp, dog, tx > 0 ? false : true);
        if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
        const catchD = Math.hypot(cmdPrey.x - x, cmdPrey.y - y);
        if (catchD < DOG_CATCH_DIST) {
          this.dogConsumePrey(cmdPrey.kind, cmdPrey.sprite, now);
          dog.commandPrey = null;
        }
      } else {
        const weaselChase = this.resolveDogWeaselChase(dog, now);
        if (weaselChase) {
          dog.chaseKind = "weasel";
          dog.chaseChicken = null;
          const tx = weaselChase.x - x;
          const ty = weaselChase.y - y;
          const sm = this.smoothSteer(dog, tx, ty, DOG_HUNT_SPEED * 1.12 * ANIMAL_SPEED_MULT, dt);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
          else if (Math.abs(tx) > 0.5) sp.setFlipX(tx > 0);
          if (
            weaselChase.d < DOG_WEASEL_CATCH_DIST ||
            Math.hypot(weaselChase.x - x, weaselChase.y - y) < DOG_WEASEL_CATCH_DIST
          ) {
            this.onDogCaughtWeasel(weaselChase.weasel, now);
            dog.chaseWeasel = null;
            dog.chaseKind = null;
            dog.restUntil = Math.max(dog.restUntil || 0, now + 1800);
          }
        } else {
        const chickenChase = this.resolveDogChickenChase(dog, now);
        if (chickenChase) {
          dog.chaseKind = "chicken";
          const tx = chickenChase.x - x;
          const ty = chickenChase.y - y;
          const sm = this.smoothSteer(dog, tx, ty, DOG_HUNT_SPEED * 1.05 * ANIMAL_SPEED_MULT, dt);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
          else if (Math.abs(tx) > 0.5) sp.setFlipX(tx > 0);
          if (chickenChase.d < DOG_CHICKEN_CATCH_DIST || Math.hypot(chickenChase.x - x, chickenChase.y - y) < DOG_CHICKEN_CATCH_DIST) {
            this.onDogCaughtChicken(chickenChase.chicken, now);
            dog.chaseChicken = null;
            dog.nextChickenChaseAt = now + DOG_CHICKEN_CHASE_INTERVAL_MS;
            dog.chaseKind = null;
            dog.restUntil = Math.max(dog.restUntil || 0, now + 2500);
          }
        } else {
        const resting = now < (dog.restUntil || 0);
        if (resting) {
          dog.chaseKind = null;
          dog.chaseSnake = null;
          dog.chaseFrog = null;
          dog.chaseWeasel = null;
          dog.huntStartedAt = 0;
          if (now > dog.retargetAt) {
            dog.retargetAt = now + 2000 + Math.random() * 1800;
            this.pickDogTarget(dog);
          }
          let tx = dog.target.x - x;
          let ty = dog.target.y - y;
          let len = Math.hypot(tx, ty) || 1;
          if (len < 8) {
            this.pickDogTarget(dog);
            tx = dog.target.x - x;
            ty = dog.target.y - y;
            len = Math.hypot(tx, ty) || 1;
          }
          const sm = this.smoothSteer(dog, tx, ty, DOG_REST_SPEED * ANIMAL_SPEED_MULT, dt, ANIMAL_STEER_ACCEL * 0.7);
          x += sm.dx;
          y += sm.dy;
          if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
          else if (Math.abs(tx) > 0.5) sp.setFlipX(tx > 0);
        } else {
          if (!dog.huntStartedAt) dog.huntStartedAt = now;
          if (now - dog.huntStartedAt >= DOG_HUNT_TIMEOUT_MS) {
            this.beginDogRest(dog, now);
          } else {
            const prey = this.resolveDogPrey(dog);
            if (prey) {
              dog.chaseKind = prey.kind;
              dog.chaseSnake = prey.snake || null;
              dog.chaseFrog = prey.frog || null;
              const tx = prey.x - x;
              const ty = prey.y - y;
              const sm = this.smoothSteer(dog, tx, ty, DOG_HUNT_SPEED * ANIMAL_SPEED_MULT, dt);
              x += sm.dx;
              y += sm.dy;
              if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
              else if (Math.abs(tx) > 0.5) sp.setFlipX(tx > 0);
              const catchD = Math.hypot(prey.x - x, prey.y - y);
              if (catchD < DOG_CATCH_DIST) {
                // 抓到：猎物不消失，狗休息 5 分钟
                this.beginDogRest(dog, now);
              }
            } else {
              dog.chaseKind = null;
              dog.chaseSnake = null;
              dog.chaseFrog = null;
              if (now > dog.retargetAt) {
                dog.retargetAt = now + 1600 + Math.random() * 1400;
                this.pickDogTarget(dog);
              }
              let tx = dog.target.x - x;
              let ty = dog.target.y - y;
              let len = Math.hypot(tx, ty) || 1;
              if (len < 8) {
                this.pickDogTarget(dog);
                tx = dog.target.x - x;
                ty = dog.target.y - y;
                len = Math.hypot(tx, ty) || 1;
              }
              const sm = this.smoothSteer(dog, tx, ty, DOG_HUNT_SPEED * 0.7 * ANIMAL_SPEED_MULT, dt);
              x += sm.dx;
              y += sm.dy;
              if (Math.abs(sm.vx) > 1.2) sp.setFlipX(sm.vx > 0);
              else if (Math.abs(tx) > 0.5) sp.setFlipX(tx > 0);
            }
          }
        }
        }
        }
      }

      sp.setPosition(x, y);
      this.clampSpriteToPlaza(sp);
      if (this.bounceIfNearFountain(sp, now)) {
        dog.home.x = sp.x;
        dog.home.y = sp.y;
        this.pickDogTarget(dog);
        dog.retargetAt = now + 500;
      }
      this.clampSpriteToPlaza(sp);

      // 老鼠碰到狗就消失；老鼠不主动躲开狗（点选追鼠时也会在追上时吃掉）
      for (let mi = this.mice.length - 1; mi >= 0; mi--) {
        const m = this.mice[mi];
        if (!m.sprite?.active) continue;
        if (Math.hypot(m.sprite.x - sp.x, m.sprite.y - sp.y) < DOG_MOUSE_EAT_DIST) {
          if (dog.commandPrey?.sprite === m.sprite) dog.commandPrey = null;
          this.clearCatChaseOfMouse(m.sprite);
          m.sprite.destroy();
          this.mice.splice(mi, 1);
        }
      }
    }

    clampSpriteFlying(sprite) {
      const b = this.plazaWalkBounds;
      if (!b || !sprite?.active) return;
      sprite.x = Math.max(b.minX, Math.min(b.maxX, sprite.x));
      sprite.y = Math.max(b.minY, Math.min(b.maxY, sprite.y));
    }

    sparrowTreePerchY(tree) {
      return tree.y - (14 + 16 * tree.scale);
    }

    pickSparrowFlyTarget(sp) {
      const p = this.plazaWalkBounds;
      if (p) {
        sp.target.x = p.minX + Math.random() * (p.maxX - p.minX);
        sp.target.y = p.minY + Math.random() * (p.maxY - p.minY);
        return;
      }
      sp.target.x = sp.home.x + (Math.random() - 0.5) * 200;
      sp.target.y = sp.home.y + (Math.random() - 0.5) * 160;
    }

    createSparrowAt(x, y, startFlying = true) {
      const sprite = this.add
        .image(x, y, startFlying ? "sparrowFly" : "sparrow")
        .setOrigin(0.5, 0.55)
        .setDepth(17.2)
        .setScale(0.72);
      const sp = {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        mode: startFlying ? "fly" : "land",
        landUntil: 0,
        fleeUntil: 0,
        beingChased: false,
        chasedBySnake: null,
        vx: 0,
        vy: 0,
      };
      this.pickSparrowFlyTarget(sp);
      sp.retargetAt = this.time.now + 600 + Math.random() * 900;
      return sp;
    }

    spawnHatchSparrowNear(x, y) {
      if (this.sparrows.length >= MAX_SPARROWS) return;
      const c = this.clampPosToPlaza(x + (Math.random() - 0.5) * 16, y + (Math.random() - 0.5) * 16);
      this.sparrows.push(this.createSparrowAt(c.x, c.y, true));
    }

    createSparrowEggAt(tree, perchX, perchY, now, willHatch) {
      const sprite = this.add
        .image(perchX, perchY, "sparrowEgg")
        .setOrigin(0.5, 0.55)
        .setDepth(19.5)
        .setScale(0.62);
      return {
        sprite,
        tree,
        perchX,
        perchY,
        hatchAt: now + SPARROW_EGG_HATCH_MS,
        willHatch: !!willHatch,
      };
    }

    nearestGroundSparrowEntry(x, y, maxDist) {
      let best = null;
      let bestD = maxDist;
      for (const sp of this.sparrows) {
        if (sp.mode !== "land" || sp.fleeUntil > this.time.now) continue;
        const d = Math.hypot(sp.sprite.x - x, sp.sprite.y - y);
        if (d < bestD) {
          bestD = d;
          best = sp;
        }
      }
      return best;
    }

    /** 落地麻雀被追：80% 被捕，20% 飞走并令追猎者放弃 */
    resolveSparrowPredatorCatch(sp, now) {
      if (Math.random() < SPARROW_CATCH_CHANCE) {
        sp.sprite.destroy();
        const idx = this.sparrows.indexOf(sp);
        if (idx >= 0) this.sparrows.splice(idx, 1);
        if (this.anyCatChasingSparrow(sp.sprite)) this.clearCatChaseOfSparrow(sp.sprite);
        if (sp.chasedBySnake) sp.chasedBySnake.chasingSparrow = null;
        return true;
      }
      sp.mode = "fly";
      sp.fleeUntil = now + SPARROW_ESCAPE_FLY_MS;
      sp.beingChased = false;
      sp.landUntil = 0;
      sp.sprite.setTexture("sparrowFly");
      sp.sprite.setDepth(17.2);
      const sx = sp.sprite.x;
      const sy = sp.sprite.y;
      sp.target.x = sx + (Math.random() - 0.5) * 120;
      sp.target.y = sy - 40 - Math.random() * 50;
      sp.retargetAt = now + SPARROW_ESCAPE_FLY_MS;
      if (this.anyCatChasingSparrow(sp.sprite)) this.clearCatChaseOfSparrow(sp.sprite);
      if (sp.chasedBySnake) {
        sp.chasedBySnake.chasingSparrow = null;
        sp.chasedBySnake = null;
      }
      return false;
    }

    updateSnakeSparrowEggClimb(snk, now, dt) {
      const climb = snk.treeEggClimb;
      if (!climb) return false;
      const sp = snk.sprite;
      const egg = climb.egg;
      if (!egg?.sprite?.active) {
        snk.treeEggClimb = null;
        sp.setDepth(15);
        return false;
      }
      if (climb.phase === "approach") {
        const tx = climb.tree.x;
        const ty = climb.tree.y + 6;
        let dx = tx - sp.x;
        let dy = ty - sp.y;
        const len = Math.hypot(dx, dy) || 1;
        sp.x += (dx / len) * 20 * dt;
        sp.y += (dy / len) * 20 * dt;
        sp.setRotation(Math.atan2(dy, dx) + Math.sin(snk.wrigglePhase * 1.28) * 0.14);
        if (len < 10) climb.phase = "climb";
      } else {
        sp.setDepth(20.5);
        let dx = egg.perchX - sp.x;
        let dy = egg.perchY - sp.y;
        const len = Math.hypot(dx, dy) || 1;
        sp.x += (dx / len) * 16 * dt;
        sp.y += (dy / len) * 16 * dt;
        sp.setRotation(Math.atan2(dy, dx) * 0.5);
        if (len < SPARROW_EGG_EAT_DIST) {
          egg.sprite.destroy();
          const ei = this.sparrowEggs.indexOf(egg);
          if (ei >= 0) this.sparrowEggs.splice(ei, 1);
          snk.nextEatSparrowEggAt = now + SNAKE_EAT_SPARROW_EGG_COOLDOWN_MS;
          snk.treeEggClimb = null;
          sp.setDepth(15);
          const down = this.clampPosToPlaza(climb.tree.x + (Math.random() - 0.5) * 8, climb.tree.y + 4, sp);
          sp.setPosition(down.x, down.y);
          this.pickSnakeTarget(snk);
          snk.retargetAt = now + 800;
        }
      }
      return true;
    }

    aimCatAt(cat, tx, ty) {
      const dx = tx - cat.x;
      const dy = ty - cat.y;
      if (Math.hypot(dx, dy) < 0.01) return;
      cat.setRotation(0);
      if (Math.abs(dx) > 0.5) cat.setFlipX(dx > 0);
    }

    /** 当前帧猫是否在追老鼠（用于上树：追鼠时不爬树）。老鼠少于 3 只时暂停追猎，让种群恢复。 */
    resolveCatMouseChase(catEntry) {
      const cat = catEntry.sprite;
      const MOUSE_AGRO = 52;
      const MIN_MICE_FOR_CAT_CHASE = 3;
      if (this.mice.length < MIN_MICE_FOR_CAT_CHASE) {
        catEntry.chaseMouse = null;
        return null;
      }
      let chaseMouseSprite = null;
      if (catEntry.chaseMouse) {
        const alive = this.mice.find((mm) => mm.sprite === catEntry.chaseMouse);
        if (alive) chaseMouseSprite = alive.sprite;
        else catEntry.chaseMouse = null;
      }
      if (!chaseMouseSprite) {
        let nearestD = MOUSE_AGRO;
        let nearest = null;
        for (const m of this.mice) {
          const d = Math.hypot(m.sprite.x - cat.x, m.sprite.y - cat.y);
          if (d < nearestD) {
            nearestD = d;
            nearest = m;
          }
        }
        if (nearest) {
          catEntry.chaseMouse = nearest.sprite;
          chaseMouseSprite = nearest.sprite;
        }
      }
      return chaseMouseSprite;
    }

    /** 猫追落地麻雀（优先级低于老鼠） */
    resolveCatSparrowChase(catEntry, chaseMouseSprite) {
      if (chaseMouseSprite) {
        catEntry.chaseSparrow = null;
        return null;
      }
      let chaseEntry = null;
      if (catEntry.chaseSparrow) {
        chaseEntry = this.sparrows.find((sp) => sp.sprite === catEntry.chaseSparrow && sp.mode === "land");
        if (!chaseEntry) catEntry.chaseSparrow = null;
      }
      if (!chaseEntry) {
        chaseEntry = this.nearestGroundSparrowEntry(catEntry.sprite.x, catEntry.sprite.y, SPARROW_PREDATOR_AGRO);
        if (chaseEntry) catEntry.chaseSparrow = chaseEntry.sprite;
      }
      if (chaseEntry) chaseEntry.beingChased = true;
      return chaseEntry;
    }

    update(_t, delta) {
      const now = this.time.now;
      const dt = Math.min((delta || 16) / 1000, 0.055);
      this.updatePlazaPoolFlow(now);
      this.updateFountainWater(now);
      this.updateStallShrimpEggPulls(now, dt);
      this.updateStallShrimpCooloffs(now, dt);
      this.updateDeadStallShrimpSites(now);
      this.updateStallShrimpReplacements(now, dt);
      this.updateFallenApples(now, dt);
      this.updatePondFish(now, dt);
      this.updateRoachRoyale(now);
      this.syncPrimaryCat();
      const catEntries = this.activeCatEntries();
      if (!catEntries.length) return;

      for (const ce of catEntries) {
        if (ce.fishing || this.arboreal || !this.plazaPools.length) continue;
        if (now < ce.nextFishAt) continue;
        if (this.arboreal?.catEntry === ce) continue;
        const pi = this.nearestPlazaPoolIndexTo(ce.sprite.x, ce.sprite.y);
        if (pi >= 0) {
          ce.fishing = { phase: "approach", poolIndex: pi };
          ce.chaseMouse = null;
        }
      }
      const MOUSE_CATCH = 13;
      const MOUSE_BREED_DIST = 22;
      const MAX_MICE = 12;
      const MOUSE_ROACH_EAT_DIST = 10;
      const MOUSE_ROACH_EAT_COOLDOWN_MS = this._roachRoyaleActive
        ? ROACH_ROYALE_MOUSE_EAT_COOLDOWN_MS
        : 30000;
      const royale = this._roachRoyaleActive;

      const herdSeek =
        !royale && this.mice.length < 6 && this.mice.length > 1;
      const MOUSE_HERD_AVOID_CAT_OUT = 78;
      const MOUSE_HERD_AVOID_CAT_IN = 40;

      for (let ei = this.lizardEggs.length - 1; ei >= 0; ei--) {
        const egg = this.lizardEggs[ei];
        if (egg.stallPull) continue;
        if (now < egg.hatchAt) continue;
        let room = MAX_LIZARDS - this.lizards.length;
        if (room > 0) {
          this.spawnHatchLizardNear(egg.sprite.x, egg.sprite.y);
          room--;
        }
        if (room > 0 && Math.random() < LIZARD_EGG_DOUBLE_HATCH_CHANCE) {
          this.spawnHatchLizardNear(egg.sprite.x, egg.sprite.y);
        }
        egg.sprite.destroy();
        this.lizardEggs.splice(ei, 1);
      }

      if (
        this.lizards.length < 3 &&
        this.lizardEggs.length + LIZARD_EGGS_PER_LAY <= MAX_LIZARD_EGGS_WORLD &&
        now >= this._nextLizardEggLayAt
      ) {
        this._nextLizardEggLayAt = now + 2400 + Math.random() * 2200;
        const eligible = this.lizards.filter(
          (lz) => !(this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled),
        );
        if (eligible.length) {
          const lz = eligible[Math.floor(Math.random() * eligible.length)];
          for (let li = 0; li < LIZARD_EGGS_PER_LAY; li++) {
            if (this.lizardEggs.length >= MAX_LIZARD_EGGS_WORLD) break;
            const ex = lz.sprite.x + (Math.random() - 0.5) * 18;
            const ey = lz.sprite.y + (Math.random() - 0.5) * 18;
            const ec = this.clampPosToPlaza(ex, ey);
            this.lizardEggs.push(this.createLizardEggAt(ec.x, ec.y, now));
            this.tryAssignStallShrimpPull(this.lizardEggs[this.lizardEggs.length - 1], "lizard");
          }
        }
      }

      for (let sei = this.sparrowEggs.length - 1; sei >= 0; sei--) {
        const egg = this.sparrowEggs[sei];
        if (now < egg.hatchAt) continue;
        if (egg.willHatch && this.sparrows.length < MAX_SPARROWS) {
          this.spawnHatchSparrowNear(egg.perchX, egg.perchY + 18);
        }
        egg.sprite.destroy();
        this.sparrowEggs.splice(sei, 1);
      }

      if (
        this.sparrows.length < SPARROW_LAY_THRESHOLD &&
        this.treeSpots.length &&
        !this.sparrowEggs.length &&
        now >= this._nextSparrowEggLayAt
      ) {
        this._nextSparrowEggLayAt = now + 7000 + Math.random() * 5000;
        const tree = this.treeSpots[Math.floor(Math.random() * this.treeSpots.length)];
        const perchY = this.sparrowTreePerchY(tree);
        const hatchIdx = Math.floor(Math.random() * SPARROW_EGGS_PER_LAY);
        for (let si = 0; si < SPARROW_EGGS_PER_LAY; si++) {
          const ox = (si - (SPARROW_EGGS_PER_LAY - 1) / 2) * 7;
          const py = perchY - 2 + (si % 2) * 2;
          this.sparrowEggs.push(
            this.createSparrowEggAt(tree, tree.x + ox, py, now, si === hatchIdx),
          );
        }
      }

      for (const m of this.mice) {
        if (royale && this.roaches.length) {
          let mx = m.sprite.x;
          let my = m.sprite.y;
          const chaseRo = this.findNearestRoachPrey(mx, my);
          if (chaseRo) {
            const mtx = chaseRo.sprite.x - mx;
            const mty = chaseRo.sprite.y - my;
            const sm = this.smoothSteer(m, mtx, mty, 28 * ANIMAL_SPEED_MULT, dt);
            mx += sm.dx;
            my += sm.dy;
            m.sprite.setPosition(mx, my);
            this.applyAnimalFlip(m.sprite, m, sm.vx < 0);
            this.clampSpriteToPlaza(m.sprite);
            if (now >= (m.nextRoachEatAt || 0)) {
              for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
                const ro = this.roaches[ri];
                if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
                if (
                  Math.hypot(ro.sprite.x - m.sprite.x, ro.sprite.y - m.sprite.y) <
                  MOUSE_ROACH_EAT_DIST
                ) {
                  this.removeRoachAt(ri, now);
                  m.nextRoachEatAt = now + MOUSE_ROACH_EAT_COOLDOWN_MS;
                  break;
                }
              }
            }
          }
          continue;
        }

        if (this.tryManholeTeleportMouse(m, now)) continue;

        if (!herdSeek && !royale) {
          if (now > m.retargetAt) {
            m.retargetAt = now + 1100 + Math.random() * 1100;
            this.pickMouseTarget(m);
          }
        }

        let mx = m.sprite.x;
        let my = m.sprite.y;
        const nearCat = this.nearestCatEntry(mx, my);
        const cx0 = nearCat ? nearCat.sprite.x : mx;
        const cy0 = nearCat ? nearCat.sprite.y : my;
        let mtx;
        let mty;
        let mlen;
        let flipLeft;

        let chaseRoachMouse = null;
        if (royale && this.roaches.length) {
          chaseRoachMouse = this.findNearestRoachPrey(mx, my);
        }
        const chaseAppleMouse =
          !chaseRoachMouse && !royale ? this.findNearestLandApple(mx, my, APPLE_ANIMAL_SEEK_RANGE) : null;

        const mousePanic =
          royale && chaseRoachMouse ? false : this.mouseSeeksManhole(m, cx0, cy0, now);
        const mh = mousePanic && this.manholes.length ? this.nearestManholeTo(mx, my) : null;

        if (chaseRoachMouse) {
          mtx = chaseRoachMouse.sprite.x - mx;
          mty = chaseRoachMouse.sprite.y - my;
          mlen = Math.hypot(mtx, mty) || 1;
          flipLeft = mtx < 0;
        } else if (chaseAppleMouse && !mousePanic) {
          mtx = chaseAppleMouse.ap.sprite.x - mx;
          mty = chaseAppleMouse.ap.sprite.y - my;
          mlen = Math.hypot(mtx, mty) || 1;
          flipLeft = mtx < 0;
        } else if (herdSeek && !mousePanic) {
          let bestD = Infinity;
          let ox = mx;
          let oy = my;
          for (const om of this.mice) {
            if (om === m) continue;
            const d = Math.hypot(om.sprite.x - mx, om.sprite.y - my);
            if (d < bestD) {
              bestD = d;
              ox = om.sprite.x;
              oy = om.sprite.y;
            }
          }
          mtx = ox - mx;
          mty = oy - my;
          mlen = Math.hypot(mtx, mty) || 1;
          if (mlen < 4) {
            const wobble = now * 0.0023 + (mx + my) * 0.01;
            mtx = Math.cos(wobble);
            mty = Math.sin(wobble);
            mlen = 1;
          }
          flipLeft = mtx < 0;
        } else if (mh) {
          mtx = mh.x - mx;
          mty = mh.y - my;
          mlen = Math.hypot(mtx, mty) || 1;
          if (mlen < 2) {
            mtx = 1;
            mty = 0;
            mlen = 1;
          }
          flipLeft = mtx < 0;
        } else {
          mtx = m.target.x - mx;
          mty = m.target.y - my;
          mlen = Math.hypot(mtx, mty) || 1;
          if (mlen < 5) {
            this.pickMouseTarget(m);
            mtx = m.target.x - mx;
            mty = m.target.y - my;
            mlen = Math.hypot(mtx, mty) || 1;
          }
          flipLeft = (m.target.x - mx) < 0;
        }

        const vMouse = (chaseRoachMouse || chaseAppleMouse ? 28 : 21) * ANIMAL_SPEED_MULT;

        if (chaseRoachMouse) {
          const sm = this.smoothSteer(m, mtx, mty, vMouse, dt);
          mx += sm.dx;
          my += sm.dy;
          flipLeft = sm.vx < 0;
        } else if (herdSeek && !mousePanic) {
          let sx = mtx / mlen;
          let sy = mty / mlen;
          const toCatX = cx0 - mx;
          const toCatY = cy0 - my;
          const dCat = Math.hypot(toCatX, toCatY) || 1;
          if (dCat < MOUSE_HERD_AVOID_CAT_OUT) {
            const awayX = -toCatX / dCat;
            const awayY = -toCatY / dCat;
            let blend =
              (MOUSE_HERD_AVOID_CAT_OUT - dCat) /
              (MOUSE_HERD_AVOID_CAT_OUT - MOUSE_HERD_AVOID_CAT_IN);
            blend = Math.max(0, Math.min(1, blend));
            blend *= blend;
            sx = sx * (1 - blend) + awayX * blend;
            sy = sy * (1 - blend) + awayY * blend;
            const sl = Math.hypot(sx, sy) || 1;
            sx /= sl;
            sy /= sl;
          }
          const sm = this.smoothSteer(m, sx, sy, vMouse, dt);
          mx += sm.dx;
          my += sm.dy;
          flipLeft = sm.vx < 0;
        } else {
          const sm = this.smoothSteer(m, mtx, mty, vMouse, dt);
          mx += sm.dx;
          my += sm.dy;
          flipLeft = sm.vx < 0;
          let mdx = mx - cx0;
          let mdy = my - cy0;
          let mdist = Math.hypot(mdx, mdy) || 1;
          if (mdist < 46) {
            const mf = (mousePanic ? 72 : 58) * dt;
            mx -= (mdx / mdist) * mf;
            my -= (mdy / mdist) * mf;
          }
        }

        m.sprite.setPosition(mx, my);
        this.clampSpriteToPlaza(m.sprite);
        this.applyAnimalFlip(m.sprite, m, flipLeft);
        if (this.bounceIfNearFountain(m.sprite, now)) {
          m.home.x = m.sprite.x;
          m.home.y = m.sprite.y;
          this.pickMouseTarget(m);
        }
        this.clampSpriteToPlaza(m.sprite);

        if (now >= (m.nextRoachEatAt || 0)) {
          for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
            const ro = this.roaches[ri];
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            if (Math.hypot(ro.sprite.x - m.sprite.x, ro.sprite.y - m.sprite.y) < MOUSE_ROACH_EAT_DIST) {
              this.removeRoachAt(ri, now);
              m.nextRoachEatAt = now + MOUSE_ROACH_EAT_COOLDOWN_MS;
              break;
            }
          }
        }
        if (!royale) this.tryEatLandApple(m.sprite.x, m.sprite.y, APPLE_EAT_DIST);
        if (now >= (m.nextEggEatAt || 0) && !royale) {
          for (let gi = this.lizardEggs.length - 1; gi >= 0; gi--) {
            const egg = this.lizardEggs[gi];
            if (Math.hypot(egg.sprite.x - m.sprite.x, egg.sprite.y - m.sprite.y) < EGG_EAT_DIST) {
              this.cancelStallShrimpEggPull(egg, true);
              egg.sprite.destroy();
              this.lizardEggs.splice(gi, 1);
              m.nextEggEatAt = now + MOUSE_SNAKE_EGG_EAT_COOLDOWN_MS;
              break;
            }
          }
        }
      }

      if (now > this.mouseBreedLock && this.mice.length < MAX_MICE) {
        outer: for (let i = 0; i < this.mice.length; i++) {
          for (let j = i + 1; j < this.mice.length; j++) {
            const a = this.mice[i].sprite;
            const b = this.mice[j].sprite;
            if (Math.hypot(a.x - b.x, a.y - b.y) < MOUSE_BREED_DIST) {
              const nx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 14;
              const ny = (a.y + b.y) / 2 + (Math.random() - 0.5) * 14;
              const bc = this.clampPosToPlaza(nx, ny);
              const nm = this.createMouseAt(bc.x, bc.y);
              nm.retargetAt = now + 500;
              this.pickMouseTarget(nm);
              this.mice.push(nm);
              this.mouseBreedLock = now + 2600;
              break outer;
            }
          }
        }
      }

      const ROACH_AGRO = royale ? 45 * ROACH_ROYALE_PREDATOR_AGRO_MULT : 45;
      const ROACH_EAT = 5;
      const V_ROACH = royale ? 8.2 * ROACH_ROYALE_FLEE_SPEED_MULT : 8.2;
      /** 略放宽，方便在蜥蜴压力下仍能碰头繁殖 */
      const ROACH_BREED_DIST = 26;
      const MAX_ROACHES = this.getMaxRoaches();
      /** 全广场只剩 1 只蟑螂时立刻在旁补殖的数量（不含母体；受 MAX_ROACHES 截断） */
      const ROACH_LAST_STAND_BROOD = royale ? ROACH_ROYALE_BREED_BATCH : ROACH_LAST_STAND_BROOD_NORMAL;
      const ROACH_BREED_BATCH = royale ? ROACH_ROYALE_BREED_BATCH : ROACH_BREED_BATCH_NORMAL;
      const V_LIZARD_CHASE_ROACH = royale ? 20 * 1.35 : 20;
      const ROACH_FLEE_LIZARD_RADIUS = 50;
      const ROACH_FLEE_ACCEL = 13;
      const ROACH_FLEE_SNAKE_RADIUS = 44;
      const ROACH_FLEE_SNAKE_ACCEL = 10;
      /** 蟑螂互斥：过近时轻微推开，减轻繁殖/死虾聚集挤成一团 */
      const ROACH_SEPARATE_RADIUS = 24;
      const ROACH_SEPARATE_ACCEL = 6.5;

      for (const ro of this.roaches) {
        if (this.tryManholeTeleportRoach(ro, now)) continue;

        const roachPanic = this.roachSeeksManhole(ro, now);
        const roachMh = roachPanic && this.manholes.length ? this.nearestManholeTo(ro.sprite.x, ro.sprite.y) : null;

        let rx = ro.sprite.x;
        let ry = ro.sprite.y;
        const deadTarget =
          royale || roachMh ? null : this.findNearestDeadStallShrimp(rx, ry);
        const deadShrimpSeek = !!deadTarget;
        const appleSeek =
          !royale && !roachMh && !deadShrimpSeek
            ? this.findNearestLandApple(rx, ry, APPLE_ANIMAL_SEEK_RANGE)
            : null;
        const deadFeeding = this.isRoachFeedingOnDeadShrimp(ro);
        const psRoach = this.plazaScale || 1;

        if (!roachMh && !deadShrimpSeek && !appleSeek && now > ro.retargetAt) {
          ro.retargetAt = now + (royale ? 420 : 1600) + Math.random() * (royale ? 600 : 2000);
          if (royale) this.pickRoachTargetAwayFromPredators(ro);
          else this.pickRoachTarget(ro);
        }
        let rtx;
        let rty;
        let rlen;
        if (roachMh) {
          rtx = roachMh.x - rx;
          rty = roachMh.y - ry;
          rlen = Math.hypot(rtx, rty) || 1;
          if (rlen < 2) {
            rtx = 1;
            rty = 0;
            rlen = 1;
          }
        } else if (deadShrimpSeek) {
          rtx = deadTarget.x - rx;
          rty = deadTarget.y - ry;
          rlen = Math.hypot(rtx, rty) || 1;
        } else if (appleSeek) {
          rtx = appleSeek.ap.sprite.x - rx;
          rty = appleSeek.ap.sprite.y - ry;
          rlen = Math.hypot(rtx, rty) || 1;
        } else {
          rtx = ro.target.x - rx;
          rty = ro.target.y - ry;
          rlen = Math.hypot(rtx, rty) || 1;
          if (rlen < 3) {
            this.pickRoachTarget(ro);
            rtx = ro.target.x - rx;
            rty = ro.target.y - ry;
            rlen = Math.hypot(rtx, rty) || 1;
          }
        }
        let vRoachEff = V_ROACH * ANIMAL_SPEED_MULT;
        if (roachPanic) vRoachEff = V_ROACH * 1.35 * ANIMAL_SPEED_MULT;
        else if (appleSeek) vRoachEff = V_ROACH * 1.12 * ANIMAL_SPEED_MULT;
        else if (deadShrimpSeek) {
          vRoachEff = deadFeeding
            ? V_ROACH * DEAD_SHRIMP_ROACH_FEED_SLOW_MULT * ANIMAL_SPEED_MULT
            : V_ROACH * DEAD_SHRIMP_ROACH_SEEK_SPEED_MULT * ANIMAL_SPEED_MULT;
        }
        {
          const sm = this.smoothSteer(ro, rtx, rty, vRoachEff, dt, ANIMAL_STEER_ACCEL * 1.15);
          rx += sm.dx;
          ry += sm.dy;
        }

        const fleeReduce = deadFeeding
          ? 0
          : deadShrimpSeek &&
              deadTarget.dist < DEAD_SHRIMP_ROACH_FLEE_REDUCE_DIST * psRoach
            ? DEAD_SHRIMP_ROACH_FLEE_REDUCE
            : 1;
        let fx = 0;
        let fy = 0;
        for (const lz of this.lizards) {
          const sp = lz.sprite;
          const dx = rx - sp.x;
          const dy = ry - sp.y;
          const d = Math.hypot(dx, dy);
          if (d < ROACH_FLEE_LIZARD_RADIUS && d > 0.01) {
            fx += dx / d;
            fy += dy / d;
          }
        }
        const fl = Math.hypot(fx, fy);
        if (fl > 0.01) {
          rx += (fx / fl) * ROACH_FLEE_ACCEL * fleeReduce * dt;
          ry += (fy / fl) * ROACH_FLEE_ACCEL * fleeReduce * dt;
        }
        for (const snk of this.snakes) {
          const ss = snk.sprite;
          const dx = rx - ss.x;
          const dy = ry - ss.y;
          const d = Math.hypot(dx, dy);
          if (d < ROACH_FLEE_SNAKE_RADIUS && d > 0.01) {
            rx += (dx / d) * ROACH_FLEE_SNAKE_ACCEL * fleeReduce * dt;
            ry += (dy / d) * ROACH_FLEE_SNAKE_ACCEL * fleeReduce * dt;
          }
        }
        if (royale) {
          const rv = this.roachRoyaleFleeVector(rx, ry, fleeReduce, dt);
          rx += rv.dx;
          ry += rv.dy;
        }

        const sepR = ROACH_SEPARATE_RADIUS * psRoach;
        let sx = 0;
        let sy = 0;
        for (const other of this.roaches) {
          if (other === ro || !other.sprite?.active) continue;
          const dx = rx - other.sprite.x;
          const dy = ry - other.sprite.y;
          const d = Math.hypot(dx, dy);
          if (d < sepR && d > 0.01) {
            const w = (sepR - d) / sepR;
            sx += (dx / d) * w;
            sy += (dy / d) * w;
          }
        }
        const sl = Math.hypot(sx, sy);
        if (sl > 0.01) {
          const sepMult = deadFeeding ? 0.42 : 1;
          rx += (sx / sl) * ROACH_SEPARATE_ACCEL * sepMult * dt;
          ry += (sy / sl) * ROACH_SEPARATE_ACCEL * sepMult * dt;
        }

        ro.sprite.setPosition(rx, ry);
        this.clampSpriteToPlaza(ro.sprite);
        if (roachMh) ro.sprite.setFlipX(rtx < 0);
        else if (deadShrimpSeek || appleSeek) ro.sprite.setFlipX(rtx < 0);
        else ro.sprite.setFlipX((ro.target.x - rx) < 0);
        if (!roachMh && !royale) this.tryEatLandApple(rx, ry, APPLE_EAT_DIST);
        if (this.bounceIfNearFountain(ro.sprite, now)) {
          ro.home.x = ro.sprite.x;
          ro.home.y = ro.sprite.y;
          this.pickRoachTarget(ro);
          ro.retargetAt = now + 400;
        }
        this.clampSpriteToPlaza(ro.sprite);
      }

      if (this.roaches.length === 1) {
        const sole = this.roaches[0];
        if (sole?.sprite?.active) {
          const room = MAX_ROACHES - this.roaches.length;
          const addN = Math.min(ROACH_LAST_STAND_BROOD, room);
          if (addN > 0) {
            const sx = sole.sprite.x;
            const sy = sole.sprite.y;
            for (let k = 0; k < addN; k++) {
              const nx = sx + (Math.random() - 0.5) * 40;
              const ny = sy + (Math.random() - 0.5) * 40;
              const bc = this.clampPosToPlaza(nx, ny);
              const nr = this.createRoachAt(bc.x, bc.y);
              this.pickRoachTarget(nr);
              nr.retargetAt = now + 450 + k * 70;
              this.roaches.push(nr);
            }
            this.roachBreedLock = now + 1400;
          }
        }
      }

      if (now > this.roachBreedLock && this.roaches.length < MAX_ROACHES) {
        outerRoach: for (let i = 0; i < this.roaches.length; i++) {
          for (let j = i + 1; j < this.roaches.length; j++) {
            const ra = this.roaches[i].sprite;
            const rb = this.roaches[j].sprite;
            if (Math.hypot(ra.x - rb.x, ra.y - rb.y) < ROACH_BREED_DIST) {
              const room = MAX_ROACHES - this.roaches.length;
              const addN = Math.min(ROACH_BREED_BATCH, room);
              for (let k = 0; k < addN; k++) {
                const nx = (ra.x + rb.x) / 2 + (Math.random() - 0.5) * 22;
                const ny = (ra.y + rb.y) / 2 + (Math.random() - 0.5) * 22;
                const bc = this.clampPosToPlaza(nx, ny);
                const nr = this.createRoachAt(bc.x, bc.y);
                this.pickRoachTarget(nr);
                nr.retargetAt = now + 500 + k * 80;
                this.roaches.push(nr);
              }
              this.roachBreedLock = now + 1400;
              break outerRoach;
            }
          }
        }
      }

      const V_SNAKE = (royale ? 24 : 22) * ANIMAL_SPEED_MULT;
      const SNAKE_HUNT_RANGE = 118;
      const SNAKE_WRIGGLE_SPEED = 13;
      const SNAKE_SIDE_SLEW = 26;
      const SNAKE_EAT_DIST = 12;
      const SNAKE_EAT_MOUSE_COOLDOWN_MS = 60_000;
      const SNAKE_EAT_ROACH_COOLDOWN_MS = 850;

      for (const snk of this.snakes) {
        if (!royale && this.updateSnakeSparrowEggClimb(snk, now, dt)) continue;
        if (royale) {
          snk.treeEggClimb = null;
          snk.chasingSparrow = null;
        }

        const sp = snk.sprite;
        let sx = sp.x;
        let sy = sp.y;

        if (
          !royale &&
          now >= (snk.nextEatSparrowEggAt || 0) &&
          !snk.treeEggClimb &&
          this.sparrowEggs.length
        ) {
          let bestEgg = null;
          let bestEggD = SNAKE_HUNT_RANGE * 1.45;
          for (const egg of this.sparrowEggs) {
            const d = Math.hypot(egg.tree.x - sx, egg.tree.y - sy);
            if (d < bestEggD) {
              bestEggD = d;
              bestEgg = egg;
            }
          }
          if (bestEgg) {
            snk.treeEggClimb = { egg: bestEgg, tree: bestEgg.tree, phase: "approach" };
            if (this.updateSnakeSparrowEggClimb(snk, now, dt)) continue;
          }
        }

        let preyX = null;
        let preyY = null;
        let bestPd = royale
          ? Infinity
          : SNAKE_HUNT_RANGE;
        let huntSparrow = null;
        const canHuntMouse = !royale && now >= (snk.nextEatMouseAt || 0);
        const canHuntEgg = !royale && now >= (snk.nextEatEggAt || 0);
        snk.chasingSparrow = null;
        if (royale) {
          const ro = this.findNearestRoachPrey(sx, sy);
          if (ro) {
            preyX = ro.sprite.x;
            preyY = ro.sprite.y;
          }
        } else {
          if (canHuntMouse) {
            for (const m of this.mice) {
              const d = Math.hypot(m.sprite.x - sx, m.sprite.y - sy);
              if (d < bestPd) {
                bestPd = d;
                preyX = m.sprite.x;
                preyY = m.sprite.y;
              }
            }
          }
          for (const ro of this.roaches) {
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            const d = Math.hypot(ro.sprite.x - sx, ro.sprite.y - sy);
            if (d < bestPd) {
              bestPd = d;
              preyX = ro.sprite.x;
              preyY = ro.sprite.y;
            }
          }
          for (const lz of this.lizards) {
            if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
            const lp = lz.sprite;
            const d = Math.hypot(lp.x - sx, lp.y - sy);
            if (d < bestPd) {
              bestPd = d;
              preyX = lp.x;
              preyY = lp.y;
            }
          }
          if (canHuntEgg) {
            for (const egg of this.lizardEggs) {
              const d = Math.hypot(egg.sprite.x - sx, egg.sprite.y - sy);
              if (d < bestPd) {
                bestPd = d;
                preyX = egg.sprite.x;
                preyY = egg.sprite.y;
              }
            }
          }
          for (const sv of this.sparrows) {
            if (sv.mode !== "land" || sv.fleeUntil > now) continue;
            const d = Math.hypot(sv.sprite.x - sx, sv.sprite.y - sy);
            if (d < bestPd) {
              bestPd = d;
              preyX = sv.sprite.x;
              preyY = sv.sprite.y;
              huntSparrow = sv;
            }
          }
        }

        let tx;
        let ty;
        if (preyX != null) {
          tx = preyX;
          ty = preyY;
          if (huntSparrow) {
            snk.chasingSparrow = huntSparrow;
            huntSparrow.chasedBySnake = snk;
            huntSparrow.beingChased = true;
          }
        } else {
          if (now > snk.retargetAt) {
            snk.retargetAt = now + 2200 + Math.random() * 1800;
            this.pickSnakeTarget(snk);
          }
          tx = snk.target.x;
          ty = snk.target.y;
        }

        let dx = tx - sx;
        let dy = ty - sy;
        let len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        snk.wrigglePhase += dt * SNAKE_WRIGGLE_SPEED;
        const side = Math.sin(snk.wrigglePhase) * SNAKE_SIDE_SLEW * dt;
        const px = -uy;
        const py = ux;
        {
          const sm = this.smoothSteer(snk, ux, uy, V_SNAKE, dt, ANIMAL_STEER_ACCEL * 0.85);
          sx += sm.dx + px * side;
          sy += sm.dy + py * side;
        }
        {
          const fled = this.applyFleeFromDog(sx, sy, now, dt);
          sx = fled.x;
          sy = fled.y;
        }

        sp.setPosition(sx, sy);
        this.clampSpriteToPlaza(sp);
        sp.setRotation(Math.atan2(uy, ux) + Math.sin(snk.wrigglePhase * 1.28) * 0.14);

        if (this.bounceIfNearFountain(sp, now)) {
          snk.home.x = sp.x;
          snk.home.y = sp.y;
          this.pickSnakeTarget(snk);
          snk.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(sp);

        if (!royale && now >= (snk.nextEatMouseAt || 0)) {
          for (let mi = this.mice.length - 1; mi >= 0; mi--) {
            const m = this.mice[mi];
            if (Math.hypot(m.sprite.x - sp.x, m.sprite.y - sp.y) < SNAKE_EAT_DIST) {
              m.sprite.destroy();
              this.mice.splice(mi, 1);
              snk.nextEatMouseAt = now + SNAKE_EAT_MOUSE_COOLDOWN_MS;
              break;
            }
          }
        }
        if (now >= (snk.nextEatRoachAt || 0)) {
          for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
            const ro = this.roaches[ri];
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            if (Math.hypot(ro.sprite.x - sp.x, ro.sprite.y - sp.y) < SNAKE_EAT_DIST) {
              this.removeRoachAt(ri, now);
              snk.nextEatRoachAt = now + (royale ? 420 : SNAKE_EAT_ROACH_COOLDOWN_MS);
              break;
            }
          }
        }
        if (!royale && now >= (snk.nextEatLizardAt || 0)) {
          for (let li = this.lizards.length - 1; li >= 0; li--) {
            const lz = this.lizards[li];
            if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
            const lsp = lz.sprite;
            if (Math.hypot(lsp.x - sp.x, lsp.y - sp.y) < SNAKE_EAT_DIST) {
              if (this.arboreal && this.arboreal.liz === lz) this.arboreal = null;
              lsp.destroy();
              this.lizards.splice(li, 1);
              snk.nextEatLizardAt = now + SNAKE_EAT_LIZARD_COOLDOWN_MS;
              break;
            }
          }
        }
        if (!royale && now >= (snk.nextEatEggAt || 0)) {
          for (let gi = this.lizardEggs.length - 1; gi >= 0; gi--) {
            const egg = this.lizardEggs[gi];
            if (Math.hypot(egg.sprite.x - sp.x, egg.sprite.y - sp.y) < EGG_EAT_DIST) {
              this.cancelStallShrimpEggPull(egg, true);
              egg.sprite.destroy();
              this.lizardEggs.splice(gi, 1);
              snk.nextEatEggAt = now + MOUSE_SNAKE_EGG_EAT_COOLDOWN_MS;
              break;
            }
          }
        }
        if (
          !royale &&
          snk.chasingSparrow?.sprite?.active &&
          snk.chasingSparrow.mode === "land"
        ) {
          const sv = snk.chasingSparrow;
          if (Math.hypot(sv.sprite.x - sp.x, sv.sprite.y - sp.y) < SNAKE_EAT_DIST) {
            this.resolveSparrowPredatorCatch(sv, now);
          }
        } else {
          snk.chasingSparrow = null;
        }
      }

      // 爬树：先处理蜥蜴独自下树 / 停在树枝；再给最近的猫指派上树
      if (this.arboreal && !royale) {
        const a = this.arboreal;
        const treeLizSp = a.liz.sprite;
        if (!a.catJoined && !a.lizardFled && now >= a.lizardSoloDownAt) {
          const lp = this.clampPosToPlaza(a.baseX + (Math.random() - 0.5) * 6, a.baseY + 2, treeLizSp);
          treeLizSp.setPosition(lp.x, lp.y);
          treeLizSp.setDepth(16);
          const lzRef = a.liz;
          this.arboreal = null;
          this._arborealCooldownUntil = now + 900;
          this.pickLizardTarget(lzRef);
          lzRef.retargetAt = now + 700;
        } else if (!a.lizardFled) {
          treeLizSp.setPosition(a.lizardPerchX, a.lizardPerchY);
          treeLizSp.setDepth(20);
          treeLizSp.setFlipX(a.lizardFlip);
        }
        if (this.arboreal && !a.catEntry) {
          const nearest = this.nearestCatEntry(a.baseX, a.baseY);
          if (nearest && !nearest.fishing) a.catEntry = nearest;
        }
      }

      // 多猫：爬树 / 捕鱼 / 地面追猎各自独立（同一时刻只有一只猫上树）
      for (const catEntry of catEntries) {
        const cat = catEntry.sprite;
        let skipCatGround = false;
        const chaseMouseSpriteEarly = this.resolveCatMouseChase(catEntry);

        if (this.arboreal && !royale && this.arboreal.catEntry === catEntry) {
          const a = this.arboreal;
          if (a.catJoined && a.lizardFled && a.catDownAt != null && now >= a.catDownAt) {
            const cp = this.clampPosToPlaza(a.baseX - 8 + (Math.random() - 0.5) * 4, a.baseY + 4, cat);
            cat.setPosition(cp.x, cp.y);
            cat.setDepth(15);
            const lzRef = a.liz;
            this.arboreal = null;
            this._arborealCooldownUntil = now + 900;
            this.pickLizardTarget(lzRef);
            lzRef.retargetAt = now + 700;
          } else if (!a.catJoined && !chaseMouseSpriteEarly && !a.lizardFled) {
            skipCatGround = true;
            const vCatUp = 34;
            const tcxUp = a.lizardPerchX;
            const tcyUp = a.lizardPerchY;
            const cdxUp = tcxUp - cat.x;
            const cdyUp = tcyUp - cat.y;
            const cup = Math.hypot(cdxUp, cdyUp) || 1;
            if (cup > 0.01) {
              const stepUp = Math.min(vCatUp * dt, cup);
              cat.x += (cdxUp / cup) * stepUp;
              cat.y += (cdyUp / cup) * stepUp;
              this.clampSpriteToPlaza(cat);
            }
            this.aimCatAt(cat, tcxUp, tcyUp);
            const dcb = Math.hypot(cat.x - a.baseX, cat.y - a.baseY);
            const dcl = Math.hypot(cat.x - a.lizardPerchX, cat.y - a.lizardPerchY);
            if (dcb < 46 || dcl < 36) {
              a.catJoined = true;
              a.catDownAt = now + 10000;
              a.lizardFled = true;
              catEntry.chaseMouse = null;
              this.fleeLizardFromCatArboreal(a, cat, now);
              cat.setPosition(a.catPerchX, a.catPerchY);
              cat.setDepth(21);
              skipCatGround = true;
            }
          } else if (a.catJoined && a.catDownAt != null && now < a.catDownAt) {
            skipCatGround = true;
            cat.setPosition(a.catPerchX, a.catPerchY);
            cat.setDepth(21);
            this.aimCatAt(cat, a.liz.sprite.x, a.liz.sprite.y);
          }
        }

        if (catEntry.fishing) {
          skipCatGround = true;
          this.updateCatFishing(catEntry, now, dt);
        }

        if (!skipCatGround) {
          const chaseLiz = this.nearestLizardEntry(cat);
          const chaseSparrowEntry = this.resolveCatSparrowChase(catEntry, chaseMouseSpriteEarly);

          let chaseMx = null;
          let chaseMy = null;
          let chaseMouseSprite = chaseMouseSpriteEarly;
          let vCat = 25;
          const dogFlee = this.isDogHunting(now)
            ? this.applyFleeFromDog(cat.x, cat.y, now, dt)
            : { fled: false };
          if (dogFlee.fled) {
            cat.x = dogFlee.x;
            cat.y = dogFlee.y;
            this.clampSpriteToPlaza(cat);
            const dogSp = this.dog?.sprite;
            if (dogSp?.active) this.aimCatAt(cat, cat.x * 2 - dogSp.x, cat.y * 2 - dogSp.y);
            if (this.bounceIfNearFountain(cat, now)) {
              catEntry.chaseMouse = null;
            }
            this.clampSpriteToPlaza(cat);
          } else {
            if (chaseMouseSprite) {
              chaseMx = chaseMouseSprite.x;
              chaseMy = chaseMouseSprite.y;
              vCat = 34;
            } else if (chaseSparrowEntry) {
              vCat = 32;
            }

            let tcx = cat.x;
            let tcy = cat.y;
            if (chaseMouseSprite) {
              tcx = chaseMx;
              tcy = chaseMy;
            } else if (chaseSparrowEntry) {
              tcx = chaseSparrowEntry.sprite.x;
              tcy = chaseSparrowEntry.sprite.y;
            } else if (chaseLiz) {
              tcx = chaseLiz.sprite.x;
              tcy = chaseLiz.sprite.y;
            }

            const cdx = tcx - cat.x;
            const cdy = tcy - cat.y;
            const sm = this.smoothSteer(catEntry, cdx, cdy, vCat * ANIMAL_SPEED_MULT, dt, ANIMAL_STEER_ACCEL * 1.05);
            cat.x += sm.dx;
            cat.y += sm.dy;
            this.clampSpriteToPlaza(cat);

            this.aimCatAt(cat, tcx, tcy);
            if (this.bounceIfNearFountain(cat, now)) {
              catEntry.chaseMouse = null;
            }
            this.clampSpriteToPlaza(cat);

            if (chaseMouseSprite) {
              const caught = Math.hypot(chaseMouseSprite.x - cat.x, chaseMouseSprite.y - cat.y);
              if (caught < MOUSE_CATCH) {
                const idx = this.mice.findIndex((mm) => mm.sprite === chaseMouseSprite);
                if (idx >= 0) {
                  this.mice[idx].sprite.destroy();
                  this.mice.splice(idx, 1);
                }
                this.clearCatChaseOfMouse(chaseMouseSprite);
              }
            } else if (chaseSparrowEntry?.sprite?.active && chaseSparrowEntry.mode === "land") {
              if (
                Math.hypot(chaseSparrowEntry.sprite.x - cat.x, chaseSparrowEntry.sprite.y - cat.y) <
                SPARROW_CATCH_DIST
              ) {
                this.resolveSparrowPredatorCatch(chaseSparrowEntry, now);
              }
            } else if (chaseLiz) {
              const lsp = chaseLiz.sprite;
              if (Math.hypot(lsp.x - cat.x, lsp.y - cat.y) < MOUSE_CATCH) {
                if (this.arboreal && this.arboreal.liz === chaseLiz) this.arboreal = null;
                lsp.destroy();
                const idx = this.lizards.indexOf(chaseLiz);
                if (idx >= 0) this.lizards.splice(idx, 1);
              }
            }
          }
        }
      }


      for (const lz of this.lizards) {
        if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) {
          continue;
        }
        const liz = lz.sprite;

        let chaseRoach = null;
        if (royale && this.roaches.length) {
          chaseRoach = this.findNearestRoachPrey(liz.x, liz.y);
        } else {
          let bestRoachD = ROACH_AGRO;
          for (const ro of this.roaches) {
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            const rd = Math.hypot(ro.sprite.x - liz.x, ro.sprite.y - liz.y);
            if (rd < bestRoachD) {
              bestRoachD = rd;
              chaseRoach = ro;
            }
          }
        }

        let lx = liz.x;
        let ly = liz.y;

        if (chaseRoach) {
          const tx = chaseRoach.sprite.x - lx;
          const ty = chaseRoach.sprite.y - ly;
          const sm = this.smoothSteer(lz, tx, ty, V_LIZARD_CHASE_ROACH * ANIMAL_SPEED_MULT, dt);
          lx += sm.dx;
          ly += sm.dy;
          if (Math.abs(sm.vx) > 1.2) liz.setFlipX(sm.vx > 0);
          else liz.setFlipX(tx > 0);
        } else if (!royale) {
          if (now > lz.retargetAt) {
            lz.retargetAt = now + 1600 + Math.random() * 1400;
            this.pickLizardTarget(lz);
          }

          let tx = lz.target.x - lx;
          let ty = lz.target.y - ly;
          let len = Math.hypot(tx, ty) || 1;
          if (len < 6) {
            this.pickLizardTarget(lz);
            tx = lz.target.x - lx;
            ty = lz.target.y - ly;
            len = Math.hypot(tx, ty) || 1;
          }
          const vL = 34 * ANIMAL_SPEED_MULT;
          const sm = this.smoothSteer(lz, tx, ty, vL, dt);
          lx += sm.dx;
          ly += sm.dy;
          if (Math.abs(sm.vx) > 1.2) liz.setFlipX(sm.vx > 0);
          else liz.setFlipX((lz.target.x - lx) < 0);
        }

        const nearCatLiz = this.nearestCatEntry(lx, ly);
        const cx0 = nearCatLiz ? nearCatLiz.sprite.x : lx;
        const cy0 = nearCatLiz ? nearCatLiz.sprite.y : ly;
        let dx = lx - cx0;
        let dy = ly - cy0;
        let dist = Math.hypot(dx, dy) || 1;
        if (!royale && dist < 40) {
          const flee = 78 * dt;
          lx += (dx / dist) * flee;
          ly += (dy / dist) * flee;
        }

        for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
          const ro = this.roaches[ri];
          if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
          if (Math.hypot(ro.sprite.x - lx, ro.sprite.y - ly) < ROACH_EAT) {
            this.removeRoachAt(ri, now);
            break;
          }
        }

        liz.setPosition(lx, ly);
        this.clampSpriteToPlaza(liz);
        if (chaseRoach) {
          const still = this.roaches.includes(chaseRoach);
          if (still) {
            const tx = chaseRoach.sprite.x - lx;
            liz.setFlipX(tx > 0);
          }
        }
        if (this.bounceIfNearFountain(liz, now)) {
          lz.home.x = liz.x;
          lz.home.y = liz.y;
          this.pickLizardTarget(lz);
          lz.retargetAt = now + 400;
        }
        this.clampSpriteToPlaza(liz);

        if (!royale && !this.arboreal && now > this._arborealCooldownUntil) {
          const nearTree = this.findNearestTreeSpot(liz.x, liz.y, 32);
          if (nearTree) this.startArboreal(nearTree, now, lz);
        }
      }

      const V_FROG = (royale ? 19 * 1.22 : 19) * ANIMAL_SPEED_MULT;
      const fPS = this.plazaScale || 1;
      const FROG_HUNT_RANGE = royale ? Infinity : 112 * fPS;
      const FROG_EAT_DIST = 12 * fPS;
      const FROG_EAT_COOLDOWN_MS = royale ? 420 : 720;

      for (const fr of this.frogs) {
        const fp = fr.sprite;
        let fx = fp.x;
        let fy = fp.y;

        if (fr.returningHome) {
          const tx = fr.target.x - fx;
          const ty = fr.target.y - fy;
          const len = Math.hypot(tx, ty) || 1;
          const vReturn = 22;
          if (len < 10) {
            fr.returningHome = false;
            const home = fr.pondHome || fr.home;
            fp.setPosition(home.x, home.y);
            fr.home.x = home.x;
            fr.home.y = home.y;
            this.pickFrogTargetInPool(fr, fr.poolIndex ?? 0);
            fr.retargetAt = now + 400;
          } else {
            fx += (tx / len) * vReturn * dt;
            fy += (ty / len) * vReturn * dt;
            fp.setPosition(fx, fy);
            fp.setRotation(Math.atan2(ty, tx) * 0.08);
            fp.setFlipX(tx < 0);
            this.clampSpriteToPlaza(fp, true);
          }
          continue;
        }

        let preyX = null;
        let preyY = null;
        let bestFd = FROG_HUNT_RANGE;
        if (royale) {
          const ro = this.findNearestRoachPrey(fx, fy);
          if (ro) {
            preyX = ro.sprite.x;
            preyY = ro.sprite.y;
          }
        } else {
          for (const m of this.mice) {
            const d = Math.hypot(m.sprite.x - fx, m.sprite.y - fy);
            if (d < bestFd) {
              bestFd = d;
              preyX = m.sprite.x;
              preyY = m.sprite.y;
            }
          }
          for (const ro of this.roaches) {
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            const d = Math.hypot(ro.sprite.x - fx, ro.sprite.y - fy);
            if (d < bestFd) {
              bestFd = d;
              preyX = ro.sprite.x;
              preyY = ro.sprite.y;
            }
          }
          for (const lz of this.lizards) {
            if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
            const lsp = lz.sprite;
            const d = Math.hypot(lsp.x - fx, lsp.y - fy);
            if (d < bestFd) {
              bestFd = d;
              preyX = lsp.x;
              preyY = lsp.y;
            }
          }
          for (const site of this.stallShrimpSites || []) {
            if (!this.canFrogTargetStallShrimp(site)) continue;
            const sp = site.npc;
            const d = Math.hypot(sp.x - fx, sp.y - fy);
            if (d < bestFd) {
              bestFd = d;
              preyX = sp.x;
              preyY = sp.y;
            }
          }
        }
        let ftx;
        let fty;
        if (preyX != null) {
          ftx = preyX;
          fty = preyY;
        } else {
          if (now > fr.retargetAt) {
            fr.retargetAt = now + 1800 + Math.random() * 1600;
            this.pickFrogTargetInPool(fr, fr.poolIndex ?? 0);
          }
          ftx = fr.target.x;
          fty = fr.target.y;
        }

        let fdx = ftx - fx;
        let fdy = fty - fy;
        {
          const sm = this.smoothSteer(fr, fdx, fdy, V_FROG, dt, ANIMAL_STEER_ACCEL * 1.1);
          fx += sm.dx;
          fy += sm.dy;
          fdx = sm.vx;
          fdy = sm.vy;
        }
        {
          const fled = this.applyFleeFromDog(fx, fy, now, dt);
          fx = fled.x;
          fy = fled.y;
        }
        fp.setPosition(fx, fy);
        fp.setRotation(Math.atan2(fdy, fdx) * 0.08);
        this.applyAnimalFlip(fp, fr, fdx < 0);
        this.clampSpriteToPlaza(fp, true);
        if (!royale || preyX == null) this.clampFrogToPoolShore(fp);
        if (this.bounceIfNearFountain(fp, now)) {
          fr.home.x = fp.x;
          fr.home.y = fp.y;
          this.pickFrogTargetInPool(fr, fr.poolIndex ?? 0);
          fr.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(fp, true);
        if (!royale || preyX == null) this.clampFrogToPoolShore(fp);

        if (now >= (fr.nextEatAt || 0)) {
          let ate = false;
          if (!royale) {
            for (let mi = this.mice.length - 1; mi >= 0; mi--) {
              const m = this.mice[mi];
              if (Math.hypot(m.sprite.x - fp.x, m.sprite.y - fp.y) < FROG_EAT_DIST) {
                m.sprite.destroy();
                this.mice.splice(mi, 1);
                ate = true;
                break;
              }
            }
          }
          if (!ate) {
            for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
              const ro = this.roaches[ri];
              if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
              if (Math.hypot(ro.sprite.x - fp.x, ro.sprite.y - fp.y) < FROG_EAT_DIST) {
                this.removeRoachAt(ri, now);
                ate = true;
                break;
              }
            }
          }
          if (!ate && !royale) {
            for (let li = this.lizards.length - 1; li >= 0; li--) {
              const lz = this.lizards[li];
              if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
              const lsp = lz.sprite;
              if (Math.hypot(lsp.x - fp.x, lsp.y - fp.y) < FROG_EAT_DIST) {
                if (this.arboreal && this.arboreal.liz === lz) this.arboreal = null;
                lsp.destroy();
                this.lizards.splice(li, 1);
                ate = true;
                break;
              }
            }
          }
          if (!ate) {
            for (const site of this.stallShrimpSites || []) {
              if (!this.canFrogTargetStallShrimp(site)) continue;
              const sp = site.npc;
              if (Math.hypot(sp.x - fp.x, sp.y - fp.y) < FROG_EAT_DIST) {
                if (Math.random() < FROG_KILL_STALL_SHRIMP_CHANCE) {
                  this.killStallShrimpAtSite(site, now);
                }
                ate = true;
                break;
              }
            }
          }
          if (ate) fr.nextEatAt = now + FROG_EAT_COOLDOWN_MS;
        }
      }

      for (const sv of this.sparrows) {
        const spr = sv.sprite;
        let sx = spr.x;
        let sy = spr.y;

        if (royale) {
          sv.fleeUntil = 0;
          sv.beingChased = false;
          sv.chasedBySnake = null;
          sv.mode = "land";
          sv.landUntil = now + ROACH_ROYALE_DURATION_MS;
          spr.setTexture("sparrow");
          spr.setDepth(16.8);
          const chaseRo = this.findNearestRoachPrey(sx, sy);
          if (chaseRo) {
            sv.target.x = chaseRo.sprite.x;
            sv.target.y = chaseRo.sprite.y;
            const tx = chaseRo.sprite.x - sx;
            const ty = chaseRo.sprite.y - sy;
            const len = Math.hypot(tx, ty) || 1;
            sx += (tx / len) * (SPARROW_LAND_SPEED + 10) * dt;
            sy += (ty / len) * (SPARROW_LAND_SPEED + 10) * dt;
            for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
              const ro = this.roaches[ri];
              if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
              if (Math.hypot(ro.sprite.x - sx, ro.sprite.y - sy) < SPARROW_ROACH_EAT_DIST) {
                this.removeRoachAt(ri, now);
                break;
              }
            }
          }
          spr.setPosition(sx, sy);
          spr.setFlipX((sv.target.x - sx) < 0);
          this.clampSpriteToPlaza(spr);
          continue;
        }

        const fleeing = sv.fleeUntil > now;
        const flying = sv.mode === "fly" || fleeing;

        if (flying) {
          spr.setTexture("sparrowFly");
          spr.setDepth(17.2);
          if (now > sv.retargetAt) {
            sv.retargetAt = now + 700 + Math.random() * 900;
            if (
              !fleeing &&
              (this.roaches.length || this.fallenApples?.some((a) => a.landed && !a.inWater)) &&
              Math.random() < (royale ? 1 : 0.28)
            ) {
              let bestRo = null;
              let bestRd = royale
                ? SPARROW_ROACH_HUNT_RANGE * ROACH_ROYALE_PREDATOR_AGRO_MULT
                : SPARROW_ROACH_HUNT_RANGE;
              for (const ro of this.roaches) {
                if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
                const d = Math.hypot(ro.sprite.x - sx, ro.sprite.y - sy);
                if (d < bestRd) {
                  bestRd = d;
                  bestRo = ro;
                }
              }
              const flyApple = this.findNearestLandApple(
                sx,
                sy,
                royale ? SPARROW_ROACH_HUNT_RANGE * ROACH_ROYALE_PREDATOR_AGRO_MULT : SPARROW_ROACH_HUNT_RANGE,
              );
              if (flyApple && (!bestRo || flyApple.dist < bestRd)) {
                sv.mode = "land";
                sv.landUntil = now + SPARROW_LAND_MIN_MS + Math.random() * 1800;
                sv.target.x = flyApple.ap.sprite.x;
                sv.target.y = flyApple.ap.sprite.y;
              } else if (bestRo) {
                sv.mode = "land";
                sv.landUntil = now + SPARROW_LAND_MIN_MS + Math.random() * 1800;
                sv.target.x = bestRo.sprite.x;
                sv.target.y = bestRo.sprite.y;
              } else {
                this.pickSparrowFlyTarget(sv);
              }
            } else {
              this.pickSparrowFlyTarget(sv);
            }
          }
        } else {
          spr.setTexture("sparrow");
          spr.setDepth(16.8);
          sv.beingChased =
            this.activeCatEntries().some(
              (ce) => Math.hypot(ce.sprite.x - sx, ce.sprite.y - sy) < SPARROW_PREDATOR_AGRO,
            ) ||
            this.snakes.some(
              (snk) =>
                snk.chasingSparrow === sv ||
                Math.hypot(snk.sprite.x - sx, snk.sprite.y - sy) < SPARROW_PREDATOR_AGRO,
            );
          if (now > sv.landUntil && !sv.beingChased) {
            sv.mode = "fly";
            sv.retargetAt = now;
            this.pickSparrowFlyTarget(sv);
          }
        }

        let tx = sv.target.x - sx;
        let ty = sv.target.y - sy;
        let len = Math.hypot(tx, ty) || 1;
        if (len < 4 && flying) {
          this.pickSparrowFlyTarget(sv);
          tx = sv.target.x - sx;
          ty = sv.target.y - sy;
          len = Math.hypot(tx, ty) || 1;
        }

        const speed = (flying ? SPARROW_FLY_SPEED : SPARROW_LAND_SPEED) * ANIMAL_SPEED_MULT;
        {
          const sm = this.smoothSteer(sv, tx, ty, speed, dt, flying ? ANIMAL_STEER_ACCEL * 1.35 : ANIMAL_STEER_ACCEL);
          sx += sm.dx;
          sy += sm.dy;
        }

        if (!flying) {
          let chaseRo = null;
          let chaseApple = null;
          let bestRd = royale
            ? SPARROW_ROACH_HUNT_RANGE * ROACH_ROYALE_PREDATOR_AGRO_MULT
            : SPARROW_ROACH_HUNT_RANGE;
          for (const ro of this.roaches) {
            if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
            const d = Math.hypot(ro.sprite.x - sx, ro.sprite.y - sy);
            if (d < bestRd) {
              bestRd = d;
              chaseRo = ro;
              chaseApple = null;
            }
          }
          const landApple = this.findNearestLandApple(sx, sy, bestRd);
          if (landApple && landApple.dist < bestRd) {
            chaseRo = null;
            chaseApple = landApple;
            bestRd = landApple.dist;
          }
          if (chaseRo) {
            tx = chaseRo.sprite.x - sx;
            ty = chaseRo.sprite.y - sy;
            len = Math.hypot(tx, ty) || 1;
            sx += (tx / len) * (SPARROW_LAND_SPEED + 6) * dt;
            sy += (ty / len) * (SPARROW_LAND_SPEED + 6) * dt;
            for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
              const ro = this.roaches[ri];
              if (this.isRoachFeedingOnDeadShrimp(ro)) continue;
              if (Math.hypot(ro.sprite.x - sx, ro.sprite.y - sy) < SPARROW_ROACH_EAT_DIST) {
                this.removeRoachAt(ri, now);
                sv.landUntil = now + 400;
                break;
              }
            }
          } else if (chaseApple) {
            tx = chaseApple.ap.sprite.x - sx;
            ty = chaseApple.ap.sprite.y - sy;
            len = Math.hypot(tx, ty) || 1;
            sx += (tx / len) * (SPARROW_LAND_SPEED + 6) * dt;
            sy += (ty / len) * (SPARROW_LAND_SPEED + 6) * dt;
            if (this.tryEatLandApple(sx, sy, APPLE_EAT_DIST)) sv.landUntil = now + 400;
          }
        }

        spr.setPosition(sx, sy);
        spr.setFlipX((sv.target.x - sx) < 0);
        if (flying) {
          this.clampSpriteFlying(spr);
        } else {
          this.clampSpriteToPlaza(spr);
          if (this.bounceIfNearFountain(spr, now)) {
            sv.home.x = spr.x;
            sv.home.y = spr.y;
            sv.target.x = spr.x + (Math.random() - 0.5) * 40;
            sv.target.y = spr.y + (Math.random() - 0.5) * 40;
          }
          this.clampSpriteToPlaza(spr);
        }
      }

      this.updateChickens(now, dt);
      this.updateSheep(now, dt);
      this.updateWeasels(now, dt);
      this.updateDog(now, dt);

      for (const npc of this.boothNpcs) {
        if (!npc?.active) continue;
        const site = this.stallShrimpSiteForNpc(npc);
        if (site?.dead || site?.incoming?.npc === npc) continue;
        if (site?.cooloff || site?.incoming) {
          this.clampSpriteToPlaza(npc, site?.cooloff?.phase === "in_pool");
          continue;
        }
        this.bounceIfNearFountain(npc, now);
        this.clampSpriteToPlaza(npc);
      }
    }

    create() {
      sceneRef = this;
      /* 核心广场尺寸（喷泉、路、分区）以 (0,0) 居中；外围再铺大地砖，缩到最小也不会露出背景色 */
      const TILE = 16;
      const ZOOM_MIN = PLAZA_ZOOM_SCENE_MIN;
      /** 相对最初版广场的边长倍数（1.5 = 在 PS=3 基础上缩小 2 倍） */
      const PS = 1.5;
      this.plazaScale = PS;
      this.fountainTeleportRadius = 34 * PS;
      const plazaW = 80 * TILE * PS;
      const plazaH = 54 * TILE * PS;
      const hw = plazaW / 2;
      const hh = plazaH / 2;

      const gw = Math.max(1, this.scale.gameSize.width);
      const gh = Math.max(1, this.scale.gameSize.height);
      const spanHalf =
        Math.max(
          110 * TILE * PS,
          Math.ceil((Math.max(gw, gh) / ZOOM_MIN / 2) / TILE) * TILE + TILE,
        );
      const boundsHalfW = Math.max(hw + TILE * 2, spanHalf);
      const boundsHalfH = Math.max(hh + TILE * 2, spanHalf);
      const boundsW = boundsHalfW * 2;
      const boundsH = boundsHalfH * 2;

      const roamPad = TILE * 2;
      this.mouseRoam = {
        minX: -boundsHalfW + roamPad,
        maxX: boundsHalfW - roamPad,
        minY: -boundsHalfH + roamPad,
        maxY: boundsHalfH - roamPad,
      };
      this.plazaTileGrid = {
        halfW: hw,
        halfH: hh,
        tile: TILE,
        cols: Math.round(plazaW / TILE),
        rows: Math.round(plazaH / TILE),
      };
      this.plazaWalkBounds = {
        minX: -hw + roamPad,
        maxX: hw - roamPad,
        minY: -hh + roamPad,
        maxY: hh - roamPad,
      };

      const cam = this.cameras.main;
      cam.setBackgroundColor("#3a332d");
      cam.setBounds(-boundsHalfW, -boundsHalfH, boundsW, boundsH);
      /* 默认 70% 缩放，移动端友好视角 */
      cam.setZoom(DEFAULT_PLAZA_ZOOM);
      // 亚像素位移，动物慢速走动更顺（贴图仍是像素风）
      cam.roundPixels = false;
      cam.centerOn(0, 0);
      this._roachRoyaleCycleStartAt = this.time.now;
      this._roachRoyaleBanner = this.add
        .text(0, -hh + 52 * PS, "", {
          fontFamily: '"ZCOOL KuaiLe", "Microsoft YaHei", sans-serif',
          fontSize: `${Math.round(13 * PS)}px`,
          color: "#fff6e8",
          backgroundColor: "rgba(26, 22, 18, 0.78)",
          padding: { x: 10, y: 6 },
        })
        .setOrigin(0.5, 0)
        .setScrollFactor(0)
        .setDepth(2000)
        .setVisible(false);

      // Golden Hour tiles（略加噪点边）
      makeTexture(this, "tileA", 16, 16, (g) => {
        g.fillStyle(0x5c5249, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x4a403a, 1).fillRect(0, 0, 16, 2);
        g.fillStyle(0x433830, 1).fillRect(0, 14, 16, 2);
        g.fillStyle(0x6a6258, 0.35).fillRect(3, 6, 2, 2);
      });
      makeTexture(this, "tileB", 16, 16, (g) => {
        g.fillStyle(0x4a403a, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x5c5249, 1).fillRect(0, 0, 16, 2);
        g.fillStyle(0x5c5249, 1).fillRect(0, 14, 16, 2);
        g.fillStyle(0x3d3630, 0.45).fillRect(10, 9, 2, 2);
      });
      makeTexture(this, "tilePath", 16, 16, (g) => {
        g.fillStyle(0x7a6e62, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x5c5249, 0.8).fillRect(0, 0, 16, 3);
        g.fillStyle(0x4a403a, 0.6).fillRect(2, 6, 12, 2);
      });
      // 草坪地砖（深浅两色交替）
      makeTexture(this, "tileGrassA", 16, 16, (g) => {
        g.fillStyle(0x3d6b42, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x4a8050, 1).fillRect(0, 0, 16, 3);
        g.fillStyle(0x2f5536, 0.85).fillRect(0, 13, 16, 3);
        g.fillStyle(0x5a9a58, 0.55).fillRect(2, 4, 1, 4);
        g.fillRect(7, 6, 1, 5);
        g.fillRect(12, 3, 1, 4);
        g.fillStyle(0x6bb86a, 0.35).fillRect(4, 9, 1, 3);
        g.fillRect(10, 11, 1, 2);
      });
      makeTexture(this, "tileGrassB", 16, 16, (g) => {
        g.fillStyle(0x355d3a, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x3d6b42, 1).fillRect(0, 0, 16, 2);
        g.fillStyle(0x2a4a30, 0.8).fillRect(0, 14, 16, 2);
        g.fillStyle(0x4f8f4e, 0.5).fillRect(3, 5, 1, 5);
        g.fillRect(9, 3, 1, 4);
        g.fillRect(14, 7, 1, 3);
        g.fillStyle(0x6bb86a, 0.3).fillRect(6, 10, 1, 3);
        g.fillRect(1, 8, 1, 2);
      });
      // 喷泉石框（内池 24×24 透明，由 fountainWaterG 每帧绘制动态水）
      makeTexture(this, "fountainMasonry", 40, 40, (g) => {
        g.fillStyle(0x5c5249, 1);
        g.fillRect(0, 0, 40, 8);
        g.fillRect(0, 32, 40, 8);
        g.fillRect(0, 8, 8, 24);
        g.fillRect(32, 8, 8, 24);
        g.fillStyle(0x6b5e54, 0.9);
        g.fillRect(1, 1, 38, 3);
        g.fillRect(1, 36, 38, 3);
        g.fillRect(1, 8, 3, 24);
        g.fillRect(36, 8, 3, 24);
        g.lineStyle(2, 0x3a332d, 1).strokeRect(4, 4, 32, 32);
      });
      // 阔叶树
      makeTexture(this, "tree", 28, 36, (g) => {
        g.fillStyle(0x3d5c44, 1).fillRect(4, 0, 20, 22);
        g.fillStyle(0x4a7254, 0.85).fillRect(6, 4, 16, 14);
        g.fillStyle(0x2a4028, 1).fillRect(10, 18, 10, 12);
        g.fillStyle(0x6b4a32, 1).fillRect(12, 26, 5, 10);
      });
      // 尖顶松树
      makeTexture(this, "treePine", 22, 40, (g) => {
        g.fillStyle(0x2f4a38, 1).fillRect(6, 0, 10, 8);
        g.fillStyle(0x3d5c44, 1).fillRect(4, 6, 14, 10);
        g.fillStyle(0x4a6b52, 1).fillRect(3, 14, 16, 10);
        g.fillStyle(0x355d45, 1).fillRect(2, 22, 18, 10);
        g.fillStyle(0x5a4634, 1).fillRect(9, 30, 5, 10);
      });
      // 圆冠橡树感
      makeTexture(this, "treeOak", 30, 34, (g) => {
        g.fillStyle(0x4a6238, 1).fillCircle(15, 14, 13);
        g.fillStyle(0x3d5028, 0.9).fillCircle(15, 16, 10);
        g.fillStyle(0x5a4634, 1).fillRect(12, 22, 6, 12);
      });
      // 秋色点缀
      makeTexture(this, "treeAutumn", 26, 34, (g) => {
        g.fillStyle(0xc17a3a, 1).fillRect(3, 2, 20, 20);
        g.fillStyle(0xa85c32, 1).fillRect(7, 8, 12, 12);
        g.fillStyle(0x5a4634, 1).fillRect(11, 20, 5, 14);
      });
      makeTexture(this, "bush", 16, 12, (g) => {
        g.fillStyle(0x3d5c44, 1).fillRect(2, 4, 12, 8);
        g.fillStyle(0x4a7254, 0.9).fillRect(4, 2, 8, 6);
      });
      makeTexture(this, "hedge", 40, 14, (g) => {
        g.fillStyle(0x2a5038, 1).fillRect(0, 4, 40, 10);
        g.fillStyle(0x3d6b48, 1).fillRect(0, 0, 40, 7);
        g.fillStyle(0x5a8a62, 0.35).fillRect(4, 2, 6, 3);
        g.fillRect(18, 1, 6, 3);
        g.fillRect(30, 2, 5, 3);
      });
      // 木栏杆：竖桩 + 两道横杆
      makeTexture(this, "fenceRail", 28, 20, (g) => {
        g.fillStyle(0x3a2e24, 0.4).fillRect(2, 17, 24, 2);
        g.fillStyle(0x6b5340, 1).fillRect(2, 2, 3, 16);
        g.fillRect(23, 2, 3, 16);
        g.fillStyle(0x8a6a4c, 1).fillRect(2, 1, 3, 3);
        g.fillRect(23, 1, 3, 3);
        g.fillStyle(0x7a5c42, 1).fillRect(1, 5, 26, 3);
        g.fillRect(1, 11, 26, 3);
        g.fillStyle(0xa08060, 0.55).fillRect(2, 5, 24, 1);
        g.fillRect(2, 11, 24, 1);
        g.fillStyle(0x4a3828, 0.7).fillRect(2, 7, 24, 1);
        g.fillRect(2, 13, 24, 1);
      });
      makeTexture(this, "fencePost", 8, 22, (g) => {
        g.fillStyle(0x3a2e24, 0.4).fillRect(1, 19, 6, 2);
        g.fillStyle(0x6b5340, 1).fillRect(2, 0, 4, 20);
        g.fillStyle(0x8a6a4c, 1).fillRect(2, 0, 4, 3);
        g.fillStyle(0xa08060, 0.5).fillRect(3, 1, 1, 16);
      });
      makeTexture(this, "flowerbed", 24, 16, (g) => {
        g.fillStyle(0x6b4a32, 1).fillRect(2, 8, 20, 8);
        g.fillStyle(0x3d5c44, 1).fillRect(4, 6, 16, 6);
        g.fillStyle(0xc1666b, 0.95).fillRect(6, 4, 4, 4);
        g.fillStyle(0xf4a900, 0.95).fillRect(14, 5, 3, 3);
        g.fillStyle(0xe8f4fc, 0.9).fillRect(10, 3, 3, 3);
      });
      makeTexture(this, "rock", 12, 10, (g) => {
        g.fillStyle(0x6a6258, 1).fillRect(2, 2, 8, 6);
        g.fillStyle(0x4a403a, 1).fillRect(4, 4, 5, 4);
      });
      makeTexture(this, "bench", 32, 20, (g) => {
        g.fillStyle(0x786046, 1).fillRect(2, 6, 28, 6);
        g.fillStyle(0x463c36, 1).fillRect(6, 12, 4, 8);
        g.fillStyle(0x463c36, 1).fillRect(22, 12, 4, 8);
        g.fillStyle(0x5c5249, 1).fillRect(2, 4, 28, 3);
      });
      makeTexture(this, "benchSide", 20, 28, (g) => {
        g.fillStyle(0x786046, 1).fillRect(6, 2, 6, 24);
        g.fillStyle(0x463c36, 1).fillRect(10, 6, 4, 18);
        g.fillStyle(0x5c5249, 1).fillRect(4, 4, 10, 4);
      });
      makeTexture(this, "stallVote", 44, 28, (g) => {
        g.fillStyle(0x3a3528, 1).fillRect(2, 6, 40, 18);
        g.fillStyle(0x5c5249, 1).fillRect(4, 8, 36, 14);
        g.lineStyle(2, 0xf4a900, 0.85).strokeRect(3, 7, 38, 16);
        g.fillStyle(0x231c18, 1).fillRect(16, 4, 12, 5);
        g.fillStyle(0x1a1612, 1).fillRect(18, 6, 8, 2);
        g.fillStyle(0xb8d4e8, 0.9).fillRect(6, 10, 6, 6);
        g.fillRect(14, 10, 6, 6);
        g.fillRect(24, 10, 6, 6);
        g.fillRect(32, 10, 6, 6);
      });
      makeTexture(this, "stallStrip", 44, 28, (g) => {
        g.fillStyle(0x4a403a, 1).fillRect(0, 18, 44, 10);
        g.fillStyle(0x6b93a8, 0.22).fillRect(2, 20, 40, 6);
        g.fillStyle(0xf4a900, 0.35).fillRect(2, 8, 40, 10);
        g.lineStyle(2, 0xc1666b, 0.75).strokeRect(1, 8, 42, 19);
        for (let x = 2; x < 42; x += 6) {
          g.fillStyle(0xf4a900, 0.75).fillRect(x, 2, 3, 6);
          g.fillStyle(0xc1666b, 0.55).fillRect(x + 3, 2, 3, 6);
        }
        g.fillStyle(0x231c18, 1).fillRect(2, 0, 40, 2);
        g.fillStyle(0xfef9f3, 0.9).fillRect(6, 0, 2, 8);
        g.fillStyle(0x7ec4e8, 0.85).fillRect(8, 0, 10, 4);
      });
      makeTexture(this, "stallAvatar", 44, 28, (g) => {
        g.fillStyle(0x4a403a, 1).fillRect(0, 18, 44, 10);
        g.fillStyle(0xf0b8bc, 0.4).fillRect(2, 20, 40, 6);
        g.fillStyle(0xe8a0b0, 0.55).fillRect(2, 8, 40, 10);
        g.lineStyle(2, 0xc1666b, 0.88).strokeRect(1, 8, 42, 19);
        for (let x = 2; x < 42; x += 6) {
          g.fillStyle(0xffc4d0, 0.85).fillRect(x, 2, 3, 6);
          g.fillStyle(0xfef9f3, 0.72).fillRect(x + 3, 2, 3, 6);
        }
        g.fillStyle(0x231c18, 1).fillRect(2, 0, 40, 2);
        g.fillStyle(0xc9a0dc, 0.65).fillRect(17, 0, 10, 6);
        g.fillStyle(0xfef9f3, 0.5).fillRect(19, 1, 6, 4);
      });
      makeTexture(this, "stallArena", 46, 30, (g) => {
        g.fillStyle(0x283828, 1).fillRect(0, 19, 46, 11);
        g.fillStyle(0x3d5c48, 0.9).fillRect(1, 10, 44, 9);
        for (let x = 1; x < 45; x += 8) {
          g.fillStyle(0x231c18, 1).fillRect(x, 2, 4, 7);
          g.fillStyle(0xf5f0e8, 0.94).fillRect(x + 4, 2, 4, 7);
        }
        g.lineStyle(2, 0xf4a900, 0.55).strokeRect(0, 1, 46, 28);
        g.fillStyle(0x1a2218, 1).fillRect(2, 0, 42, 2);
      });
      makeTexture(this, "stallForum", 44, 28, (g) => {
        g.fillStyle(0x3d2838, 1).fillRect(0, 18, 44, 10);
        g.fillStyle(0x6b3050, 0.7).fillRect(0, 7, 7, 20);
        g.fillRect(37, 7, 7, 20);
        g.fillStyle(0xd4963c, 0.72).fillRect(2, 8, 40, 10);
        g.lineStyle(2, 0xf4a900, 0.72).strokeRect(1, 8, 42, 19);
        g.fillStyle(0xffe8b8, 0.88).fillRect(6, 2, 32, 5);
        g.fillStyle(0x231c18, 1).fillRect(2, 0, 40, 2);
      });
      makeTexture(this, "shrimp", 18, 14, (g) => {
        g.fillStyle(0xe07a6a, 0.98).fillRect(3, 6, 10, 6);
        g.fillRect(1, 7, 2, 2);
        g.fillRect(13, 7, 2, 2);
        g.fillStyle(0x231c18, 1).fillRect(5, 8, 1, 1);
        g.fillRect(9, 8, 1, 1);
        g.fillStyle(0xf4a900, 0.95).fillRect(6, 12, 4, 1);
      });
      makeTexture(this, "goStones", 16, 12, (g) => {
        g.fillStyle(0x231c18, 1);
        g.fillCircle(5, 7, 3.5);
        g.fillStyle(0xfef9f3, 1);
        g.fillCircle(12, 7, 3.5);
      });
      // 双灯头路灯
      makeTexture(this, "lamp", 14, 32, (g) => {
        g.fillStyle(0x3a332d, 1).fillRect(6, 14, 2, 18);
        g.fillStyle(0x463c36, 1).fillRect(4, 12, 6, 4);
        g.fillStyle(0xf4a900, 0.95).fillRect(0, 0, 5, 8);
        g.fillStyle(0xf4a900, 0.95).fillRect(9, 0, 5, 8);
        g.fillStyle(0xffe8b8, 0.45).fillRect(-1, 2, 7, 12);
        g.fillRect(8, 2, 7, 12);
      });
      makeTexture(this, "signboard", 36, 14, (g) => {
        g.fillStyle(0x5a4634, 1).fillRect(16, 4, 4, 10);
        g.fillStyle(0xfef9f3, 0.95).fillRect(2, 0, 32, 10);
        g.lineStyle(2, 0x231c18, 1).strokeRect(2, 0, 32, 10);
      });
      makeTexture(this, "cat", 24, 18, (g) => {
        g.fillStyle(0xf0c86a, 1).fillRect(6, 8, 12, 8);
        g.fillRect(2, 4, 8, 8);
        g.fillStyle(0xd6a84f, 1).fillRect(2, 2, 2, 2);
        g.fillRect(8, 2, 2, 2);
        g.fillStyle(0x231c18, 1).fillRect(4, 7, 1, 1);
        g.fillRect(7, 7, 1, 1);
        g.fillStyle(0xd6a84f, 1).fillRect(18, 10, 4, 2);
      });
      // 狗：棕毛、垂耳、短尾；比猫略大一圈，追猫/蛇/牛蛙
      makeTexture(this, "dog", 28, 20, (g) => {
        g.fillStyle(0x6b4423, 1).fillRect(8, 9, 14, 8);
        g.fillStyle(0x8b5a2b, 1).fillRect(8, 9, 14, 5);
        g.fillStyle(0x5a3818, 1).fillRect(2, 5, 10, 9);
        g.fillStyle(0x4a2e12, 1).fillRect(1, 3, 4, 5);
        g.fillRect(9, 3, 4, 5);
        g.fillStyle(0x231c18, 1).fillRect(5, 8, 1, 1);
        g.fillRect(9, 8, 1, 1);
        g.fillStyle(0xc4a574, 1).fillRect(3, 11, 4, 2);
        g.fillStyle(0x5a3818, 1).fillRect(22, 12, 5, 3);
        g.fillStyle(0x3d2610, 1).fillRect(24, 11, 2, 2);
      });
// 小蜥蜴：浅色底 + setTint（绿 / 黄 / 白 / 橘）
      makeTexture(this, "lizard", 16, 10, (g) => {
        g.fillStyle(0xf2f0ec, 1).fillRect(2, 4, 10, 5);
        g.fillStyle(0xd8d4cc, 1).fillRect(0, 5, 3, 3);
        g.fillStyle(0xffffff, 0.85).fillRect(4, 3, 6, 3);
        g.fillStyle(0x231c18, 1).fillRect(9, 4, 1, 1);
        g.fillStyle(0xc1666b, 0.85).fillRect(12, 5, 3, 2);
      });
      makeTexture(this, "lizardEgg", 10, 12, (g) => {
        g.fillStyle(0xe8dcc8, 1).fillCircle(5, 6, 5);
        g.fillStyle(0xc9b89a, 1).fillCircle(5, 6, 3.5);
        g.fillStyle(0x8b7355, 0.75).fillRect(3, 4, 1, 1);
        g.fillRect(7, 7, 1, 1);
        g.fillRect(4, 9, 1, 1);
      });
      // 水池小鱼：浅色底 + setTint 成多彩；flipX 表示游向
      makeTexture(this, "pondFish", 16, 10, (g) => {
        g.fillStyle(0xf5f5f5, 1).fillEllipse(8, 5, 10, 5);
        g.fillStyle(0xe8e8e8, 1).fillTriangle(1, 5, 5, 2.5, 5, 7.5);
        g.fillStyle(0x1a1816, 0.9).fillCircle(11.5, 4.8, 1.1);
      });
      makeTexture(this, "mouse", 16, 10, (g) => {
        g.fillStyle(0x231c18, 1).fillRect(2, 4, 11, 5);
        g.fillStyle(0x9c8c82, 1).fillRect(3, 5, 9, 3);
        g.fillStyle(0xe8b8c8, 1).fillRect(0, 5, 3, 3);
        g.fillRect(12, 6, 4, 2);
        g.fillStyle(0x231c18, 1).fillRect(5, 5, 1, 1);
        g.fillRect(9, 5, 1, 1);
      });
      // 小蟑螂：红褐偏橙 + 浅边，与灰褐地砖强对比；纹理略缩小便于整体再 setScale
      makeTexture(this, "roach", 12, 8, (g) => {
        g.fillStyle(0x1a0c0a, 1).fillRect(0, 1, 12, 6);
        g.fillStyle(0xd14d3a, 1).fillRect(1, 2, 10, 4);
        g.fillStyle(0x8b2418, 1).fillRect(1, 2, 3, 4);
        g.fillStyle(0xffcc88, 1).fillRect(2, 3, 2, 1);
        g.fillStyle(0xfff2d8, 1).fillRect(7, 2, 2, 1);
        g.fillStyle(0x1a0c0a, 1).fillRect(10, 0, 2, 2);
        g.fillRect(11, 5, 2, 2);
      });
      makeTexture(this, "roachRoyaleTrophy", 14, 16, (g) => {
        g.fillStyle(0xf4a900, 1).fillRect(3, 0, 8, 3);
        g.fillStyle(0xffd700, 1).fillRect(4, 3, 6, 8);
        g.fillStyle(0xc1666b, 1).fillRect(2, 11, 10, 3);
        g.fillStyle(0xffe066, 1).fillRect(1, 4, 2, 4);
        g.fillRect(11, 4, 2, 4);
      });
      // 蛇身：浅色底 + setTint（黄 / 棕 / 绿）；侧向扭动由位移与旋转表现
      makeTexture(this, "snake", 26, 10, (g) => {
        g.fillStyle(0xf2f0ec, 1).fillRect(2, 3, 22, 4);
        g.fillStyle(0xd8d4cc, 1).fillRect(3, 4, 18, 2);
        g.fillStyle(0x2a2420, 1).fillRect(19, 2, 6, 6);
        g.fillRect(2, 3, 3, 2);
        g.fillStyle(0x1a1816, 1).fillRect(22, 4, 1, 1);
      });
      // 牛蛙（俯视）：四腿展开、亮腹 + 金眶眼，整体比猫小一圈
      makeTexture(this, "frog", 28, 22, (g) => {
        g.fillStyle(0x1a2820, 0.35).fillEllipse(14, 12, 22, 14);
        // 后肢（粗壮）
        g.fillStyle(0x2f4d3c, 1).fillEllipse(6, 15, 7, 5);
        g.fillEllipse(22, 15, 7, 5);
        g.fillStyle(0x3d6b52, 1).fillEllipse(6, 14.5, 5, 3.5);
        g.fillEllipse(22, 14.5, 5, 3.5);
        // 前肢
        g.fillStyle(0x355d48, 1).fillEllipse(8, 11, 5, 4);
        g.fillEllipse(20, 11, 5, 4);
        g.fillStyle(0x4a8062, 1).fillEllipse(8, 10.5, 3.5, 2.8);
        g.fillEllipse(20, 10.5, 3.5, 2.8);
        // 躯干
        g.fillStyle(0x3a6b52, 1).fillEllipse(14, 10, 16, 11);
        g.fillStyle(0x4d8f6e, 1).fillEllipse(14, 9, 12, 8);
        g.fillStyle(0x6ec498, 0.55).fillEllipse(14, 8.5, 9, 5);
        g.fillStyle(0xa8e8c8, 0.35).fillEllipse(13, 7.5, 5, 3);
        // 吻部三角
        g.fillStyle(0x2d5444, 1).fillTriangle(14, 4, 10, 8, 18, 8);
        g.fillStyle(0x4d8f6e, 1).fillTriangle(14, 4.5, 11, 7.5, 17, 7.5);
        // 背斑
        g.fillStyle(0x2a4034, 0.85).fillEllipse(10, 9, 2.2, 1.8);
        g.fillEllipse(18, 9, 2.2, 1.8);
        g.fillEllipse(14, 11.5, 2.5, 2);
        // 金眶眼
        g.fillStyle(0xc9a227, 1).fillCircle(10.5, 6.5, 2.8);
        g.fillCircle(17.5, 6.5, 2.8);
        g.fillStyle(0xf5e6a8, 0.9).fillCircle(10.5, 6.2, 1.6);
        g.fillCircle(17.5, 6.2, 1.6);
        g.fillStyle(0x1a1816, 1).fillCircle(10.6, 6.3, 1.1);
        g.fillCircle(17.6, 6.3, 1.1);
        g.fillStyle(0xffffff, 0.75).fillRect(11, 5.8, 1, 1);
        g.fillRect(18, 5.8, 1, 1);
        // 鼻线
        g.fillStyle(0x1a2820, 0.6).fillRect(13.5, 5, 1, 2);
      });
      // 麻雀：落地收翅 / 飞行展翼
      makeTexture(this, "sparrow", 14, 12, (g) => {
        g.fillStyle(0x6a5848, 1).fillEllipse(7, 7, 8, 5);
        g.fillStyle(0x8b7355, 1).fillEllipse(7, 6, 6, 4);
        g.fillStyle(0x231c18, 1).fillRect(10, 5, 1, 1);
        g.fillStyle(0xf4a900, 0.95).fillRect(11, 6, 2, 1);
        g.fillStyle(0x5a4a3a, 1).fillRect(2, 7, 3, 2);
        g.fillRect(9, 7, 3, 2);
      });
      makeTexture(this, "sparrowFly", 20, 14, (g) => {
        g.fillStyle(0x6a5848, 1).fillEllipse(10, 7, 7, 4);
        g.fillStyle(0x8b7355, 1).fillEllipse(10, 6.5, 5, 3);
        g.fillStyle(0x231c18, 1).fillRect(12, 5.5, 1, 1);
        g.fillStyle(0xf4a900, 0.95).fillRect(13, 6.5, 2, 1);
        g.fillStyle(0xa09078, 0.95).fillTriangle(1, 7, 6, 2, 6, 11);
        g.fillTriangle(19, 7, 14, 2, 14, 11);
        g.fillStyle(0x7a6a58, 0.85).fillTriangle(3, 7, 7, 4, 7, 10);
        g.fillTriangle(17, 7, 13, 4, 13, 10);
      });
      makeTexture(this, "sparrowEgg", 8, 10, (g) => {
        g.fillStyle(0xe8e4dc, 1).fillEllipse(4, 5.5, 3.5, 4.5);
        g.fillStyle(0xc8c0b0, 1).fillEllipse(4, 5.5, 2.5, 3.5);
        g.fillStyle(0x6a8090, 0.55).fillRect(3, 4.5, 1, 1);
        g.fillRect(5, 6.5, 1, 1);
      });
      makeTexture(this, "apple", 12, 14, (g) => {
        g.fillStyle(0x6b1010, 0.35).fillEllipse(6, 10, 8, 4);
        g.fillStyle(0xc62828, 1).fillEllipse(6, 8, 9, 10);
        g.fillStyle(0xe53935, 1).fillEllipse(5, 7, 5, 6);
        g.fillStyle(0xff7043, 0.55).fillEllipse(4.5, 6, 2.5, 3);
        g.fillStyle(0x2e7d32, 1).fillEllipse(8, 3.5, 4, 2.5);
        g.fillStyle(0x43a047, 1).fillEllipse(9, 3, 3, 2);
        g.fillStyle(0x5d4037, 1).fillRect(6, 1.5, 1.2, 2.5);
      });
      // 鸡：白羽、红冠、黄喙；地面啄食蟑螂
      makeTexture(this, "chicken", 18, 14, (g) => {
        g.fillStyle(0xf5f0e6, 1).fillEllipse(9, 8, 10, 7);
        g.fillStyle(0xffffff, 1).fillEllipse(9, 7, 8, 5);
        g.fillStyle(0xe8dcc8, 1).fillEllipse(4, 7, 4, 4);
        g.fillStyle(0xc62828, 1).fillRect(12, 3, 2, 3);
        g.fillRect(14, 4, 2, 2);
        g.fillStyle(0xf4a900, 1).fillRect(15, 7, 3, 2);
        g.fillStyle(0x231c18, 1).fillRect(13, 6, 1, 1);
        g.fillStyle(0xf4a900, 0.9).fillRect(6, 11, 2, 2);
        g.fillRect(10, 11, 2, 2);
      });
      makeTexture(this, "chickenEgg", 8, 10, (g) => {
        g.fillStyle(0xfff8e8, 1).fillEllipse(4, 5.5, 3.6, 4.6);
        g.fillStyle(0xf0e0c0, 1).fillEllipse(4, 5.5, 2.6, 3.4);
        g.fillStyle(0xd4c4a0, 0.5).fillRect(3, 4, 1, 1);
      });
      // 羊：白毛、黑蹄、侧脸
      makeTexture(this, "sheep", 22, 16, (g) => {
        g.fillStyle(0x3a332d, 0.35).fillEllipse(11, 13, 14, 4);
        g.fillStyle(0xf2efe8, 1).fillEllipse(11, 8, 14, 9);
        g.fillStyle(0xffffff, 1).fillEllipse(11, 7, 11, 7);
        g.fillStyle(0xe8e2d6, 1).fillEllipse(6, 6, 5, 5);
        g.fillEllipse(16, 7, 4, 4);
        g.fillStyle(0x2a2420, 1).fillEllipse(18, 7, 5, 5);
        g.fillStyle(0x3d3630, 1).fillEllipse(19, 6.5, 3, 3);
        g.fillStyle(0xf5f0e6, 0.9).fillEllipse(17.5, 6, 2, 2);
        g.fillStyle(0x1a1816, 1).fillRect(19, 5.5, 1.2, 1.2);
        g.fillStyle(0x2a2420, 1).fillRect(5, 12, 2.5, 3);
        g.fillRect(9, 12.5, 2.5, 3);
        g.fillRect(13, 12, 2.5, 3);
        g.fillRect(16.5, 12.5, 2.2, 2.5);
      });
      // 黄鼠狼：細长黄褐身、尖吻
      makeTexture(this, "weasel", 24, 12, (g) => {
        g.fillStyle(0x3a2a18, 0.35).fillEllipse(12, 10, 16, 3);
        g.fillStyle(0xc48a3a, 1).fillEllipse(11, 6, 16, 7);
        g.fillStyle(0xd4a04a, 1).fillEllipse(11, 5.5, 12, 5);
        g.fillStyle(0xe8c070, 0.7).fillEllipse(8, 5, 5, 3);
        g.fillStyle(0xb87328, 1).fillEllipse(20, 5.5, 6, 5);
        g.fillStyle(0xc48a3a, 1).fillEllipse(21, 5, 4, 3.5);
        g.fillStyle(0x1a1816, 1).fillRect(22, 4, 1.2, 1.2);
        g.fillStyle(0xf0d8a8, 0.85).fillEllipse(10, 7.5, 6, 3);
        g.fillStyle(0x8a5a28, 1).fillRect(2, 5, 4, 2);
        g.fillStyle(0xa86a30, 1).fillTriangle(1, 6, 3, 4.5, 3, 7.5);
        g.fillStyle(0x5a3a18, 1).fillRect(5, 9, 2, 2);
        g.fillRect(10, 9.5, 2, 2);
        g.fillRect(14, 9, 2, 2);
        g.fillRect(17, 9.5, 1.8, 1.8);
      });

      const ground = this.add.graphics().setDepth(0);
      for (let y = -boundsHalfH; y < boundsHalfH; y += TILE) {
        for (let x = -boundsHalfW; x < boundsHalfW; x += TILE) {
          const dark = (((x >> 4) + (y >> 4)) & 1) === 0;
          ground.fillStyle(dark ? 0x5c5249 : 0x4a403a, 1).fillRect(x, y, TILE, TILE);
        }
      }
      for (let y = -hh; y < hh; y += TILE) {
        for (let x = -hw; x < hw; x += TILE) {
          const darkA = (((x >> 4) + (y >> 4)) & 1) === 0;
          this.add
            .image(x, y, darkA ? "tileA" : "tileB")
            .setOrigin(0, 0)
            .setDepth(0);
        }
      }

      /* —— 四象限主题色：面积 = 原矩形 ×2（边长 ×√2），内沿仍贴环岛路口 —— */
      const zoneTint = (cx, cy, w, h, color, a) =>
        this.add.rectangle(cx, cy, w, h, color, a).setDepth(1).setStrokeStyle(2, 0x231c18, 0.22);
      const ztw = Math.round(400 * Math.SQRT2) * PS;
      const zth = Math.round(240 * Math.SQRT2) * PS;
      zoneTint(-283 * PS, -215 * PS, ztw, zth, 0x6b8cae, 0.11); // 投票街 VOTE · 偏冷
      zoneTint(283 * PS, -215 * PS, ztw, zth, 0xc1666b, 0.1); // AVATAR · 陶土
      zoneTint(-283 * PS, 225 * PS, ztw, zth, 0x4a8f5c, 0.09); // ARENA · 绿
      zoneTint(283 * PS, 225 * PS, ztw, zth, 0xd4963c, 0.11); // FORUM（自由发帖）· 金

      /* —— 分区草坪：铺在瓷砖之上、主路之下，边缘略不规则；格子可被羊吃掉 —— */
      this.lawnPatches = [];
      this.fencePaddocks = [];
      const paintLawn = (cx, cy, cols, rows, soft = 0.88) => {
        const ox = cx - (cols * TILE) / 2;
        const oy = cy - (rows * TILE) / 2;
        const patch = { cx, cy, tiles: [], fenced: false };
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const nx = (c + 0.5) / cols - 0.5;
            const ny = (r + 0.5) / rows - 0.5;
            const edge = nx * nx * 4 + ny * ny * 4;
            if (edge > soft && ((c * 17 + r * 31 + Math.round(cx + cy)) % 5) !== 0) continue;
            if (edge > soft + 0.18) continue;
            const key = ((c + r) & 1) === 0 ? "tileGrassA" : "tileGrassB";
            const gx = ox + c * TILE;
            const gy = oy + r * TILE;
            const sprite = this.add.image(gx, gy, key).setOrigin(0, 0).setDepth(1.15);
            patch.tiles.push({
              sprite,
              cx: gx + TILE / 2,
              cy: gy + TILE / 2,
              grassKey: key,
              eaten: false,
              regrowAt: 0,
            });
          }
        }
        if (patch.tiles.length) this.lawnPatches.push(patch);
        return patch;
      };
      // 四大草坪（四象限开阔处）
      const fencedLawn = paintLawn(-210 * PS, -165 * PS, 11, 8, 0.9);
      paintLawn(215 * PS, -160 * PS, 10, 8, 0.9);
      paintLawn(-215 * PS, 175 * PS, 11, 8, 0.9);
      paintLawn(210 * PS, 170 * PS, 10, 8, 0.9);
      // 小路旁小草坪条带
      paintLawn(-145 * PS, -72 * PS, 6, 4, 0.95);
      paintLawn(150 * PS, 68 * PS, 6, 4, 0.95);
      paintLawn(-70 * PS, 145 * PS, 5, 5, 0.92);
      paintLawn(75 * PS, -140 * PS, 5, 5, 0.92);
      // 靠外缘的碎草坪
      paintLawn(-300 * PS, -40 * PS, 5, 6, 0.86);
      paintLawn(305 * PS, 35 * PS, 5, 6, 0.86);

      // 西北大草坪上的木栏杆（三面围栏，朝路开口）；内部禁入
      {
        const lawnCx = -210 * PS;
        const lawnCy = -165 * PS;
        const halfW = (11 * TILE) / 2;
        const halfH = (8 * TILE) / 2;
        const fenceDepth = 6.1;
        const placeFenceH = (x, y) => {
          this.add.image(x, y, "fenceRail").setOrigin(0.5, 1).setDepth(fenceDepth).setScale(1.05);
        };
        const placeFenceV = (x, y) => {
          this.add
            .image(x, y, "fenceRail")
            .setOrigin(0.5, 1)
            .setDepth(fenceDepth)
            .setScale(1.05)
            .setAngle(90);
        };
        const placePost = (x, y) => {
          this.add.image(x, y, "fencePost").setOrigin(0.5, 1).setDepth(fenceDepth + 0.05).setScale(1.1);
        };
        for (let i = -2; i <= 2; i++) {
          placeFenceH(lawnCx + i * 26, lawnCy - halfH + 6);
        }
        for (let i = -1; i <= 1; i++) {
          placeFenceV(lawnCx - halfW + 8, lawnCy + i * 26);
        }
        for (let i = -1; i <= 1; i++) {
          placeFenceV(lawnCx + halfW - 8, lawnCy + i * 26);
        }
        placePost(lawnCx - halfW + 6, lawnCy - halfH + 8);
        placePost(lawnCx + halfW - 6, lawnCy - halfH + 8);
        placePost(lawnCx - halfW + 6, lawnCy + halfH - 10);
        placePost(lawnCx + halfW - 6, lawnCy + halfH - 10);

        if (fencedLawn) fencedLawn.fenced = true;
        this.fencePaddocks.push({
          minX: lawnCx - halfW + 2,
          maxX: lawnCx + halfW - 2,
          minY: lawnCy - halfH + 2,
          maxY: lawnCy + halfH - 2,
        });
      }

      /* —— 十字主路 + 喷泉环岛感 —— */
      const roadAsp = 0x2c2622;
      const roadInner = 0x362f29;
      const roadWMain = plazaW - 64 * PS;
      const roadHBand = 76 * PS;
      const roadVBand = 56 * PS;
      this.add.rectangle(0, 0, roadWMain, roadHBand, roadAsp, 0.94).setDepth(2);
      this.add.rectangle(0, 0, roadVBand, plazaH - 120 * PS, roadAsp, 0.94).setDepth(2);
      this.add.rectangle(0, 0, roadWMain - 10 * PS, roadHBand - 14 * PS, roadInner, 0.55).setDepth(2);
      this.add.rectangle(0, 0, roadVBand - 12 * PS, plazaH - 150 * PS, roadInner, 0.5).setDepth(2);

      // 路口加深
      this.add.rectangle(0, 0, roadVBand + 8 * PS, roadHBand + 8 * PS, 0x1e1a18, 0.35).setDepth(2);

      // 中央铺装圆（环喷泉）
      const plazaPad = this.add.graphics({ x: 0, y: 0 });
      plazaPad.fillStyle(0x6b5e54, 0.92);
      plazaPad.fillCircle(0, 0, 72 * PS);
      plazaPad.lineStyle(3, 0x231c18, 0.45);
      plazaPad.strokeCircle(0, 0, 72 * PS);
      plazaPad.setDepth(3);

      // 碎石小径（通向四区）
      const pathRay = (ang, len) => {
        const rad = (ang * Math.PI) / 180;
        const cx = Math.cos(rad) * (len / 2);
        const cy = Math.sin(rad) * (len / 2);
        for (let t = -len / 2; t < len / 2; t += TILE) {
          const px = Math.cos(rad) * t;
          const py = Math.sin(rad) * t;
          if (Math.hypot(px, py) < 52 * PS) continue;
          this.add.image(px, py, "tilePath").setOrigin(0.5).setDepth(3).setRotation(rad);
        }
      };
      pathRay(-90, Math.min(hh - 100 * PS, 268 * PS));
      pathRay(90, Math.min(hh - 100 * PS, 268 * PS));
      pathRay(0, Math.min(hw - 72 * PS, 380 * PS));
      pathRay(180, Math.min(hw - 72 * PS, 380 * PS));

      // 车道虚线（东西向）
      for (let x = -roadWMain / 2 + 20 * PS; x < roadWMain / 2 - 20 * PS; x += 36 * PS) {
        if (Math.abs(x) < 34 * PS) continue;
        this.add.rectangle(x, 0, 14 * PS, 3 * PS, 0xd4b896, 0.82).setDepth(3);
      }
      // 南北向短虚线
      for (let y = -plazaH / 2 + 80 * PS; y < plazaH / 2 - 80 * PS; y += 40 * PS) {
        if (Math.abs(y) < 40 * PS) continue;
        this.add.rectangle(0, y, 3 * PS, 12 * PS, 0xd4b896, 0.75).setDepth(3);
      }

      // 斑马线（四个方向靠圆心）
      const zebra = (ox, oy, horizontal) => {
        const st = 8 * PS;
        for (let i = -4; i <= 4; i++) {
          if (horizontal) this.add.rectangle(ox + i * st, oy, 4 * PS, 18 * PS, 0xefe6dc, 0.88).setDepth(3);
          else this.add.rectangle(ox, oy + i * st, 18 * PS, 4 * PS, 0xefe6dc, 0.88).setDepth(3);
        }
      };
      zebra(-52 * PS, 0, true);
      zebra(52 * PS, 0, true);
      zebra(0, -52 * PS, false);
      zebra(0, 52 * PS, false);

      // 井盖（坐标同步记入 manholes，供鼠蟑地下通道）
      this.manholes = [];
      const manhole = (x, y) => {
        this.manholes.push({ x, y });
        const m = this.add.circle(x, y, 7 * PS, 0x1e1a18, 0.65).setDepth(3);
        this.add.circle(x, y, 5 * PS, 0x2e2824, 0.85).setDepth(3);
        return m;
      };
      manhole(-210 * PS, 22 * PS);
      manhole(215 * PS, -18 * PS);
      manhole(-120 * PS, -30 * PS);
      manhole(95 * PS, 38 * PS);

      this.createPlazaZonePools();
      this.initPondFish();

      this.fountainWaterG = this.add.graphics().setDepth(5);
      this.updateFountainWater(this.time.now);
      this.add.image(0, 0, "fountainMasonry").setOrigin(0.5).setDepth(6);

      // 喷泉周水花（轻微动画）
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        const r = (38 + (i % 2) * 4) * PS;
        const splash = this.add
          .rectangle(Math.cos(ang) * r, Math.sin(ang) * r, 4 * PS, 3 * PS, 0xffffff, 0.35)
          .setDepth(4)
          .setRotation(ang);
        this.tweens.add({
          targets: splash,
          scaleY: { from: 0.6, to: 1.25 },
          alpha: { from: 0.2, to: 0.45 },
          duration: 860 + i * 90,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
      }

      const depthScenery = 6;

      const treeKeys = ["tree", "treePine", "treeOak", "treeAutumn"];
      const placeTree = (x, y, key, sc, flip) => {
        const t = this.add.image(x, y, key).setOrigin(0.5, 1).setScale(sc).setDepth(depthScenery);
        if (flip) t.setFlipX(true);
        this.treeSpots.push({ x, y, scale: sc });
        return t;
      };

      // 沿路林带 + 四角密林（再 ×3 → 相对最初共 ×9）
      const borderTrees = [
        [-hw + 40 * PS, -120 * PS, "treePine", 1],
        [-hw + 28 * PS, -40 * PS, "treeOak", 1.05],
        [-hw + 52 * PS, 40 * PS, "tree", 0.95],
        [-hw + 34 * PS, 118 * PS, "treeAutumn", 1],
        [hw - 42 * PS, -128 * PS, "treeOak", 1],
        [hw - 30 * PS, -48 * PS, "treePine", 1.08],
        [hw - 48 * PS, 52 * PS, "tree", 1],
        [hw - 36 * PS, 122 * PS, "treeAutumn", 0.98],
        [-280 * PS, -hh + 50 * PS, "treePine", 1.1],
        [12 * PS, -hh + 44 * PS, "treeOak", 1],
        [-24 * PS, -hh + 36 * PS, "tree", 0.95],
        [260 * PS, -hh + 48 * PS, "treePine", 1.05],
        [-268 * PS, hh - 52 * PS, "tree", 1],
        [8 * PS, hh - 46 * PS, "treeAutumn", 1.02],
        [248 * PS, hh - 50 * PS, "treeOak", 1],
      ];
      const TREE_MULT = 9;
      for (const [x, y, k, s] of borderTrees) {
        for (let m = 0; m < TREE_MULT; m++) {
          const ring = Math.floor(m / 3);
          const slot = m % 3;
          const ang = (slot / 3) * Math.PI * 2 + ring * 0.7;
          const rad = ring * 28 * PS + (slot === 0 && ring === 0 ? 0 : 18 * PS);
          const ox = Math.cos(ang) * rad;
          const oy = Math.sin(ang) * rad;
          const sc = s * (1 - Math.min(0.28, m * 0.02));
          placeTree(x + ox, y + oy, k, sc, ((x + y) / PS + m) % 2 === 0);
        }
      }

      // 集群小树丛（再 ×3 → 相对最初共 ×9）
      const clusters = [
        [-320 * PS, -220 * PS, 1],
        [300 * PS, -210 * PS, -1],
        [-310 * PS, 210 * PS, 1],
        [295 * PS, 218 * PS, -1],
        [-130 * PS, -250 * PS, 1],
        [125 * PS, -245 * PS, -1],
        [-135 * PS, 252 * PS, 1],
        [118 * PS, 248 * PS, -1],
      ];
      for (const [cx0, cy0, dir] of clusters) {
        for (let m = 0; m < TREE_MULT; m++) {
          const ring = Math.floor(m / 3);
          const slot = m % 3;
          const ang = (slot / 3) * Math.PI * 2 + ring * 0.55;
          const rad = ring * 32 * PS + (m === 0 ? 0 : 22 * PS);
          const cx = cx0 + Math.cos(ang) * rad * dir;
          const cy = cy0 + Math.sin(ang) * rad;
          placeTree(
            cx,
            cy,
            treeKeys[Math.abs(Math.round(cx + cy + m * 17)) % 4],
            0.92 - Math.min(0.2, m * 0.015),
            dir < 0,
          );
          placeTree(
            cx + 18 * PS * dir,
            cy + 10 * PS,
            "treePine",
            0.85 - Math.min(0.15, m * 0.012),
            dir > 0,
          );
          if (m === 0) {
            this.add
              .image(cx - 14 * PS * dir, cy - 8 * PS, "bush")
              .setOrigin(0.5)
              .setScale(1.15)
              .setDepth(depthScenery);
          }
        }
      }

      // 灌木与石块点缀（避开环岛）
      const scatter = [
        [-85 * PS, -95 * PS, "bush"],
        [92 * PS, -102 * PS, "bush"],
        [-78 * PS, 88 * PS, "bush"],
        [96 * PS, 92 * PS, "bush"],
        [-40 * PS, -132 * PS, "rock"],
        [48 * PS, 128 * PS, "rock"],
        [188 * PS, -88 * PS, "rock"],
        [-195 * PS, 72 * PS, "rock"],
        [0, -118 * PS, "flowerbed"],
        [-118 * PS, 0, "flowerbed"],
        [120 * PS, 6 * PS, "flowerbed"],
        [4 * PS, 118 * PS, "flowerbed"],
      ];
      for (const [x, y, key] of scatter) {
        const im = this.add.image(x, y, key).setOrigin(0.5).setDepth(depthScenery);
        if (key === "bush") im.setScale(1.05 + (Math.abs(x + y) % 5) * 0.03);
      }

      // 绿篱围角（四区内侧）
      const hedgeY = [-138 * PS, 138 * PS];
      const hedgeX = [-175 * PS, 175 * PS];
      for (const hy of hedgeY) {
        this.add.image(-285 * PS, hy, "hedge").setOrigin(0.5).setDepth(depthScenery);
        this.add.image(285 * PS, hy, "hedge").setOrigin(0.5).setDepth(depthScenery).setFlipX(true);
      }
      for (const hx of hedgeX) {
        const h = this.add.image(hx, -218 * PS, "hedge").setOrigin(0.5).setDepth(depthScenery);
        h.setAngle(90);
        const h2 = this.add.image(hx, 218 * PS, "hedge").setOrigin(0.5).setDepth(depthScenery);
        h2.setAngle(90);
      }

      // 长椅（沿路与广场边）
      const benches = [
        [-95 * PS, 62 * PS, 0, false],
        [88 * PS, -58 * PS, 0, true],
        [-210 * PS, 12 * PS, Math.PI / 2, false],
        [205 * PS, -8 * PS, Math.PI / 2, true],
        [-48 * PS, -195 * PS, 0, false],
        [40 * PS, 188 * PS, 0, true],
        [155 * PS, 95 * PS, Math.PI / 2, false],
        [-160 * PS, -105 * PS, Math.PI / 2, true],
      ];
      for (const [bx, by, ang, flip] of benches) {
        const b = this.add
          .image(bx, by, Math.abs(ang) > 0.1 ? "benchSide" : "bench")
          .setOrigin(0.5)
          .setDepth(depthScenery)
          .setRotation(ang);
        if (flip) b.setFlipX(true);
      }

      // 路灯：沿路网格 + 四向加密
      let lampPhase = 0;
      const lampRowY = [-38 * PS, 38 * PS];
      for (const ly of lampRowY) {
        for (let lx = -hw + 100 * PS; lx < hw - 60 * PS; lx += 130 * PS) {
          if (Math.abs(lx) < 70 * PS) continue;
          this.addLampWithGlow(lx, ly, depthScenery + 0.5, lampPhase);
          lampPhase += 110;
        }
      }
      for (let ly = -hh + 90 * PS; ly < hh - 70 * PS; ly += 140 * PS) {
        if (Math.abs(ly) < 55 * PS) continue;
        this.addLampWithGlow(-48 * PS, ly, depthScenery + 0.5, lampPhase);
        lampPhase += 80;
        this.addLampWithGlow(48 * PS, ly, depthScenery + 0.5, lampPhase);
        lampPhase += 80;
      }
      // 内环四盏
      this.addLampWithGlow(-62 * PS, -62 * PS, depthScenery + 0.5, 40);
      this.addLampWithGlow(62 * PS, -62 * PS, depthScenery + 0.5, 200);
      this.addLampWithGlow(-62 * PS, 62 * PS, depthScenery + 0.5, 320);
      this.addLampWithGlow(62 * PS, 62 * PS, depthScenery + 0.5, 480);

      // 指示牌
      const signs = [
        [-298 * PS, -22 * PS, "PIXEL"],
        [288 * PS, -22 * PS, "AVATAR"],
        [-298 * PS, 22 * PS, "ARENA"],
        [288 * PS, 22 * PS, "FORUM"],
      ];
      signs.forEach(([sx, sy, txt]) => {
        this.add.image(sx, sy, "signboard").setOrigin(0.5).setDepth(depthScenery + 1);
        this.add
          .text(sx, sy - 1, txt, {
            fontFamily: "Press Start 2P, ui-monospace, monospace",
            fontSize: "6px",
            color: "#231c18",
          })
          .setOrigin(0.5)
          .setDepth(depthScenery + 2);
      });

      this.cats = [];
      const catSpawns = [
        [-118 * PS, 88 * PS],
        [96 * PS, 100 * PS],
      ];
      for (let ci = 0; ci < CAT_COUNT; ci++) {
        const [cx, cy] = catSpawns[ci] || [
          (ci % 2 === 0 ? -1 : 1) * (90 + ci * 20) * PS,
          (80 + (ci % 3) * 12) * PS,
        ];
        const pos = this.clampPosToPlaza(cx, cy);
        const ce = this.createCatAt(pos.x, pos.y);
        ce.nextFishAt = this.time.now + CAT_FISH_INTERVAL_MS + ci * 8000;
        this.cats.push(ce);
      }
      this.syncPrimaryCat();
      {
        const dogPos = this.clampPosToPlaza(96 * PS, -72 * PS);
        this.dog = this.createDogAt(dogPos.x, dogPos.y);
        this.pickDogTarget(this.dog);
        this.dog.retargetAt = this.time.now + 600;
        this.dog.nextChickenChaseAt = this.time.now + DOG_CHICKEN_CHASE_INTERVAL_MS;
      }
      const lizardSpawns = [
        [-72 * PS, 82 * PS],
        [-58 * PS, 94 * PS],
        [-90 * PS, 72 * PS],
        [-48 * PS, 68 * PS],
        [-82 * PS, 100 * PS],
      ];
      this.lizards = [];
      for (let i = 0; i < lizardSpawns.length; i++) {
        const [x, y] = lizardSpawns[i];
        const lz = this.createLizardAt(x, y);
        lz.retargetAt = this.time.now + 800 + i * 220;
        this.lizards.push(lz);
        this.pickLizardTarget(lz);
      }
      this._nextLizardEggLayAt = this.time.now + 4000;

      /* 首次远离猫（约 -118,88），生在东西向干道东侧 */
      const mouseSpawns = [
        [168 * PS, 82 * PS],
        [198 * PS, 96 * PS],
        [142 * PS, 108 * PS],
        [218 * PS, 74 * PS],
        [182 * PS, 70 * PS],
        [230 * PS, 90 * PS],
        [155 * PS, 118 * PS],
        [205 * PS, 65 * PS],
      ];
      for (const [mx, my] of mouseSpawns) {
        const mm = this.createMouseAt(mx, my);
        mm.retargetAt = this.time.now + Math.random() * 700;
        this.pickMouseTarget(mm);
        this.mice.push(mm);
      }

      this.roaches = [];
      for (let ri = 0; ri < 15; ri++) {
        const ang = (ri / 15) * Math.PI * 2 + 0.2;
        const rad = (95 + (ri % 4) * 34) * PS;
        const rx = Math.cos(ang) * rad + ((ri * 17) % 40) * PS;
        const ry = Math.sin(ang) * rad + ((ri * 11) % 36) * PS;
        const rc = this.clampPosToPlaza(rx, ry);
        const ro = this.createRoachAt(rc.x, rc.y);
        ro.retargetAt = this.time.now + ri * 90;
        this.pickRoachTarget(ro);
        this.roaches.push(ro);
      }
      this.roachBreedLock = this.time.now + 800;

      this.snakes = [];
      const snakeSpawns = [
        { x: -38 * PS, y: -118 * PS, tint: 0xffd54f },
        { x: 52 * PS, y: 132 * PS, tint: 0xa1887f },
        { x: 175 * PS, y: -42 * PS, tint: 0x66bb6a },
      ];
      snakeSpawns.forEach((cfg, si) => {
        const c = this.clampPosToPlaza(cfg.x, cfg.y);
        const snk = this.createSnakeAt(c.x, c.y, cfg.tint);
        snk.retargetAt = this.time.now + 320 + si * 300;
        this.pickSnakeTarget(snk);
        this.snakes.push(snk);
      });

      this.frogs = [];
      const nFrogs = Math.min(4, this.plazaPools.length || 0);
      for (let fi = 0; fi < nFrogs; fi++) {
        const poolIndex = fi % this.plazaPools.length;
        const pool = this.plazaPools[poolIndex];
        const p0 = this.randomPointInsidePlazaPool(pool);
        const fr = this.createFrogAt(p0.x, p0.y, poolIndex);
        fr.pondHome = { x: p0.x, y: p0.y };
        fr.retargetAt = this.time.now + fi * 240;
        this.pickFrogTargetInPool(fr, poolIndex);
        this.frogs.push(fr);
      }

      this.sparrows = [];
      const sparrowSpawns = [
        [-200 * PS, -60 * PS],
        [-140 * PS, 40 * PS],
        [-30 * PS, -140 * PS],
        [40 * PS, -80 * PS],
        [120 * PS, 20 * PS],
        [200 * PS, -30 * PS],
        [-180 * PS, 120 * PS],
        [80 * PS, 140 * PS],
        [240 * PS, 90 * PS],
        [-60 * PS, 180 * PS],
      ];
      for (let spi = 0; spi < sparrowSpawns.length && this.sparrows.length < MAX_SPARROWS; spi++) {
        const [sx, sy] = sparrowSpawns[spi];
        const sc = this.clampPosToPlaza(sx, sy);
        this.sparrows.push(this.createSparrowAt(sc.x, sc.y, true));
      }
      this._nextSparrowEggLayAt = this.time.now + 12000;

      this.chickens = [];
      this.chickenEggs = [];
      const chickenSpawns = [
        [-150 * PS, 40 * PS],
        [-100 * PS, -50 * PS],
        [40 * PS, 60 * PS],
        [130 * PS, -20 * PS],
        [70 * PS, 110 * PS],
      ];
      for (let ci = 0; ci < chickenSpawns.length && this.chickens.length < MAX_CHICKENS; ci++) {
        const [cx, cy] = chickenSpawns[ci];
        const cc = this.clampPosToPlaza(cx, cy);
        const ch = this.createChickenAt(cc.x, cc.y);
        this.pickChickenTarget(ch);
        ch.retargetAt = this.time.now + ci * 200;
        this.chickens.push(ch);
      }
      this._nextChickenLayAt = this.time.now + 18000;

      this.sheep = [];
      const sheepSpawns = [
        [-160 * PS, -100 * PS],
        [200 * PS, 155 * PS],
      ];
      for (let si = 0; si < SHEEP_COUNT && si < sheepSpawns.length; si++) {
        const [sx, sy] = sheepSpawns[si];
        const sc = this.clampPosToPlaza(sx, sy);
        const sh = this.createSheepAt(sc.x, sc.y);
        this.pickSheepWanderTarget(sh);
        sh.retargetAt = this.time.now + si * 400;
        this.sheep.push(sh);
      }

      this.weasels = [];
      const weaselSpawns = [
        [180 * PS, -90 * PS],
        [-90 * PS, 160 * PS],
      ];
      for (let wi = 0; wi < WEASEL_COUNT && wi < weaselSpawns.length; wi++) {
        const [wx, wy] = weaselSpawns[wi];
        const wc = this.clampPosToPlaza(wx, wy);
        const w = this.createWeaselAt(wc.x, wc.y);
        this.pickWeaselTarget(w);
        w.retargetAt = this.time.now + wi * 350;
        this.weasels.push(w);
      }

      this.fallenApples = [];
      this._nextAppleDropAt = this.time.now + 3000 + Math.random() * 5000;

      // Zone titles sit above plaza tiles / trees (6) but below booths (7+) so stalls are never covered.
      const depthZoneTitle = 6.4;
      const mkLabel = (x, y, text, subHue) =>
        this.add
          .text(x, y, text, {
            fontFamily: "Press Start 2P, ui-monospace, monospace",
            fontSize: "10px",
            color: subHue || "#f4a900",
            backgroundColor: "rgba(35,28,24,0.78)",
            padding: { x: 8, y: 5 },
          })
          .setDepth(depthZoneTitle);
      mkLabel(-312 * PS, -292 * PS, "VOTE ST", "#b8d4e8");
      mkLabel(300 * PS, -292 * PS, "AVATAR ST", "#f0b8bc");
      mkLabel(-312 * PS, 302 * PS, "ARENA ST", "#b8e0c4");
      mkLabel(300 * PS, 302 * PS, "FORUM ST", "#ffe3a8");

      const Z_SCENE_MAX = PLAZA_ZOOM_SCENE_MAX;

      this.input.on("wheel", (_pointer, _go, _dx, dy) => {
        const c = this.cameras.main;
        const step = dy > 0 ? -0.12 : 0.12;
        const raw = clamp(c.zoom + step, ZOOM_MIN, Z_SCENE_MAX);
        c.setZoom(Math.round(raw * 40) / 40);
      });

      /** 捏合缩放：记下双指落下的初始间距与 zoom，按比例连续映射（单指拖拽平移） */
      this._pinchBaseline = null;

      this.input.on("pointermove", () => {
        const c = this.cameras.main;
        /** @type {Phaser.Input.Pointer[]} */
        const pts =
          typeof this.input.manager?.pointers?.filter === "function"
            ? this.input.manager.pointers.filter((pt) => pt && pt.isDown)
            : [];
        const nDown = pts.length;

        if (nDown >= 2) {
          const ax = pts[0].x;
          const ay = pts[0].y;
          const bx = pts[1].x;
          const by = pts[1].y;
          const dist = Math.hypot(ax - bx, ay - by);

          if (dist < 14) return;

          if (!this._pinchBaseline) {
            this._pinchBaseline = { d0: dist, z0: c.zoom };
          }
          let nz = this._pinchBaseline.z0 * (dist / Math.max(this._pinchBaseline.d0, 14));
          nz = clamp(nz, ZOOM_MIN, Z_SCENE_MAX);
          c.setZoom(nz);
          return;
        }

        this._pinchBaseline = null;

        if (nDown !== 1) return;
        if (this._draggingFenceAnimal) return;
        const q = pts[0];
        c.scrollX -= (q.x - q.prevPosition.x) / c.zoom;
        c.scrollY -= (q.y - q.prevPosition.y) / c.zoom;
      });

      this.input.on("pointerup", () => {
        const pts =
          typeof this.input.manager?.pointers?.filter === "function"
            ? this.input.manager.pointers.filter((pt) => pt && pt.isDown)
            : [];
        if (pts.length < 2) this._pinchBaseline = null;
      });

      this.input.on("pointerdown", (_pointer, currentlyOver) => {
        if (!this.dogSelectArmed) return;
        if (currentlyOver && currentlyOver.length) return;
        this.setDogSelectArmed(false);
      });

      this.refreshBooths(state.posts, state.matches, state.polls, state.spyGames, state.stallZoneFilter);
    }

    refreshBooths(posts, matches, polls, spyGames, zoneFilter) {
      this._boothGen = (this._boothGen || 0) + 1;
      const boothGen = this._boothGen;
      for (const e of [...this.pondFishEggs, ...this.lizardEggs]) {
        if (e.stallPull) this.cancelStallShrimpEggPull(e, false);
      }
      for (const s of this.stallShrimpSites || []) {
        this.clearStallEggBasketIcons(s, s.eggBasketIcons?.length ?? 0);
        if (s.eggBasket) s.eggBasket.length = 0;
      }
      for (const b of this.booths) b.destroy();
      this.booths = [];
      this.boothNpcs = [];
      this.stallShrimpSites = [];

      const postItems = posts || [];
      const matchItems = matches || [];
      const pollItems = polls || [];
      const spyItems = spyGames || [];
      const zf = zoneFilter || "all";
      const PS = this.plazaScale || 1;

      const zones = {
        vote: { x0: -498 * PS, y0: -302 * PS, cols: 4, dx: 94 * PS, dy: 66 * PS },
        avatar: { x0: 120 * PS, y0: -302 * PS, cols: 4, dx: 94 * PS, dy: 66 * PS },
        match: { x0: -498 * PS, y0: 186 * PS, cols: 4, dx: 94 * PS, dy: 66 * PS },
        forum: { x0: 120 * PS, y0: 186 * PS, cols: 4, dx: 94 * PS, dy: 66 * PS },
      };
      const idx = { vote: 0, avatar: 0, match: 0, forum: 0 };
      const stallTex = {
        vote: "stallVote",
        avatar: "stallAvatar",
        forum: "stallForum",
        match: "stallArena",
      };

      const placeBooth = (z, x, y, label, tweenSeed, onOpen, texOverride) => {
        const tex = texOverride || stallTex[z] || "stallStrip";
        const stall = this.add.image(x, y, tex).setOrigin(0.5).setDepth(7).setInteractive({ useHandCursor: true });
        const hover = z === "match" ? 0xa8e8ff : 0xffd485;
        stall.on("pointerdown", onOpen);
        stall.on("pointerover", () => stall.setTint(hover));
        stall.on("pointerout", () => stall.clearTint());

        let npc;
        const npcY = y + 10 * PS;
        if (z === "match") {
          npc = this.add.image(x - 16 * PS, npcY, "goStones").setOrigin(0.5).setDepth(8);
        } else {
          npc = this.add.image(x - 18 * PS, npcY, "shrimp").setOrigin(0.5).setDepth(8);
          const shrimpTint =
            z === "avatar" ? 0xffb8c6 : z === "forum" ? 0xffe8a0 : z === "vote" ? 0xa8c8e8 : 0xffffff;
          npc.setTint(shrimpTint);
        }
        this.tweens.add({
          targets: npc,
          y: npcY - 2,
          duration: 700 + (tweenSeed % 5) * 60,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        // 竞技场摊位的五子棋棋子图为装饰，不参与广场小动物碰撞逻辑
        if (z !== "match") {
          this.boothNpcs.push(npc);
          const siteObj = {
            npc,
            stallX: x,
            stallY: y,
            npcHomeX: npc.x,
            npcHomeY: npc.y,
            busy: false,
            eggBasket: [],
            eggBasketIcons: [],
            eggBatchResolving: false,
            dead: false,
            cooloff: null,
            incoming: null,
            stallTint:
              z === "avatar" ? 0xffb8c6 : z === "forum" ? 0xffe8a0 : z === "vote" ? 0xa8c8e8 : 0xffffff,
          };
          npc._stallSite = siteObj;
          this.stallShrimpSites.push(siteObj);
        }

        const bubble = this.add
          .text(x, y - 30 * PS, label, {
            fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
            fontSize: `${Math.max(12, Math.round(12 * PS))}px`,
            color: "#fef9f3",
            backgroundColor: "rgba(35,28,24,0.75)",
            padding: { x: Math.round(8 * PS), y: Math.round(5 * PS) },
          })
          .setOrigin(0.5, 1)
          .setDepth(9);
        bubble.setInteractive({ useHandCursor: true });
        bubble.on("pointerdown", onOpen);
        this.booths.push(stall, npc, bubble);
      };

      const placePollBooth = (poll, x, y, label, tweenSeed) => {
        const onOpen = () => {
          void openPollDrawer(poll);
        };
        const tex = "stallVote";
        const stall = this.add.image(x, y, tex).setOrigin(0.5).setDepth(7).setInteractive({ useHandCursor: true });
        stall.on("pointerdown", onOpen);
        stall.on("pointerover", () => stall.setTint(0xffd485));
        stall.on("pointerout", () => stall.clearTint());
        this.booths.push(stall);

        const sub = poll.plazaPromoted ? "★" : "票";
        const shrimpTint = 0x9ec5e8;
        const npc = this.add.image(x - 16 * PS, y + 10 * PS, "shrimp").setOrigin(0.5).setDepth(8).setTint(shrimpTint);
        this.tweens.add({
          targets: npc,
          y: y + 10 * PS - 2,
          duration: 700 + (tweenSeed % 5) * 60,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        this.boothNpcs.push(npc);
        const siteObj = {
          npc,
          stallX: x,
          stallY: y,
          npcHomeX: npc.x,
          npcHomeY: npc.y,
          busy: false,
          eggBasket: [],
          eggBasketIcons: [],
          eggBatchResolving: false,
          dead: false,
          cooloff: null,
          incoming: null,
          stallTint: shrimpTint,
        };
        npc._stallSite = siteObj;
        this.stallShrimpSites.push(siteObj);
        this.booths.push(npc);

        const bubble = this.add
          .text(x, y - 30 * PS, label, {
            fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
            fontSize: `${Math.max(12, Math.round(12 * PS))}px`,
            color: "#fef9f3",
            backgroundColor: "rgba(35,28,24,0.75)",
            padding: { x: Math.round(8 * PS), y: Math.round(5 * PS) },
          })
          .setOrigin(0.5, 1)
          .setDepth(9);
        bubble.setInteractive({ useHandCursor: true });
        bubble.on("pointerdown", onOpen);
        this.booths.push(bubble);

        const leadIdx =
          poll.plazaPromoted && poll.promotedOptionIndex != null
            ? poll.promotedOptionIndex
            : poll.leadingOptionIndex;
        const opt = (poll.options || [])[leadIdx];
        const url = opt?.imageUrl;
        if (url) {
          let abs;
          try {
            abs = new URL(url, window.location.origin).href;
          } catch {
            abs = url;
          }
          const k = `pld_${String(poll.id).replace(/[^a-zA-Z0-9_]/g, "_")}`;
          const kRaw = `${k}_raw`;
          const px = x + 44 * PS;
          const py = y - 2 * PS;
          const scene = this;
          const addSide = () => {
            if (scene._boothGen !== boothGen) return;
            if (!scene.textures.exists(k)) return;
            const img = scene.add.image(px, py, k).setOrigin(0.5).setDepth(8).setDisplaySize(42 * PS, 42 * PS);
            scene.booths.push(img);
          };
          if (scene.textures.exists(k)) addSide();
          else {
            scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
              if (scene._boothGen !== boothGen) return;
              if (!scene.textures.exists(kRaw)) return;
              const showKey = plazaKnockOutFlatBackdrop(scene, kRaw, k) ? k : kRaw;
              if (!scene.textures.exists(showKey)) return;
              if (showKey === k) {
                try {
                  scene.textures.remove(kRaw);
                } catch {
                  /* noop */
                }
              }
              const img = scene.add
                .image(px, py, showKey)
                .setOrigin(0.5)
                .setDepth(8)
                .setDisplaySize(42 * PS, 42 * PS);
              scene.booths.push(img);
            });
            scene.load.image(kRaw, abs);
            scene.load.start();
          }
        }

        const tag = this.add
          .text(x + 46 * PS, y + 22 * PS, sub, {
            fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
            fontSize: `${Math.max(10, Math.round(10 * PS))}px`,
            color: "#2a1f18",
            backgroundColor: "rgba(255,228,168,0.82)",
            padding: { x: 4, y: 2 },
          })
          .setOrigin(0.5)
          .setDepth(9);
        this.booths.push(tag);
      };

      /** 投票截止后起算 24h 内：**至少有一票**时，在投票街空地展示当期得票最高选项的像素图（固定底座，点开仍进投票抽屉） */
      const placePollWinnerPedestal = (poll, lingerSlot, winIdx) => {
        const tv = Number(poll.totalVotes);
        if (!Number.isFinite(tv) || tv < 1) return;
        const opts = poll.options || [];
        if (!opts.length) return;
        const wi = clamp(Number(winIdx) || 0, 0, opts.length - 1);
        const url = opts[wi]?.imageUrl;
        if (!url) return;
        let abs;
        try {
          abs = new URL(url, window.location.origin).href;
        } catch {
          abs = url;
        }
        const pid = String(poll.id).replace(/[^a-zA-Z0-9_]/g, "_");
        const k = `plwl_${pid}_opt${wi}`;
        const kRaw = `${k}_raw`;
        const gx = lingerSlot % 5;
        const gy = Math.floor(lingerSlot / 5);
        const pxRaw = -402 * PS + gx * 60 * PS;
        const pyRaw = -258 * PS + gy * 48 * PS;
        const pad = this.clampPosToPlaza(pxRaw, pyRaw);
        const scene = this;
        const onOpen = () => {
          void openPollDrawer(poll);
        };
        const mount = (showKey) => {
          if (scene._boothGen !== boothGen || !scene.textures.exists(showKey)) return;
          const foot = scene.add
            .ellipse(pad.x, pad.y + 4 * PS, 38 * PS, 11 * PS, 0x1a1614, 0.42)
            .setDepth(8.02);
          const sprite = scene.add
            .image(pad.x, pad.y - 10 * PS, showKey)
            .setOrigin(0.5, 1)
            .setDepth(8.35)
            .setInteractive({ useHandCursor: true })
            .setDisplaySize(48 * PS, 48 * PS);
          sprite.on("pointerdown", onOpen);
          scene.tweens.add({
            targets: sprite,
            y: pad.y - 14 * PS,
            duration: 1250 + (lingerSlot % 5) * 90,
            yoyo: true,
            repeat: -1,
            ease: "Sine.inOut",
          });
          const cap = scene.add
            .text(pad.x, pad.y - 56 * PS, "胜出 · 留影 24h", {
              fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
              fontSize: `${Math.max(10, Math.round(10 * PS))}px`,
              color: "#e8f4fc",
              backgroundColor: "rgba(35,28,24,0.72)",
              padding: { x: 5, y: 3 },
            })
            .setOrigin(0.5, 1)
            .setDepth(9);
          cap.setInteractive({ useHandCursor: true });
          cap.on("pointerdown", onOpen);
          scene.booths.push(foot, sprite, cap);
        };
        if (scene.textures.exists(k)) mount(k);
        else if (scene.textures.exists(kRaw)) mount(kRaw);
        else {
          scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
            if (scene._boothGen !== boothGen) return;
            if (!scene.textures.exists(kRaw)) return;
            const showKey = plazaKnockOutFlatBackdrop(scene, kRaw, k) ? k : kRaw;
            if (!scene.textures.exists(showKey)) return;
            if (showKey === k) {
              try {
                scene.textures.remove(kRaw);
              } catch {
                /* noop */
              }
            }
            mount(showKey);
          });
          scene.load.image(kRaw, abs);
          scene.load.start();
        }
      };

      for (const poll of pollItems) {
        if (zf !== "all" && zf !== "vote") continue;
        const zc = zones.vote;
        const i = idx.vote++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8 * PS;
        const y = zc.y0 + row * zc.dy;
        const rawTitle = poll.title || "投票";
        const title = rawTitle.length > 8 ? `${rawTitle.slice(0, 8)}…` : rawTitle;
        placePollBooth(poll, x, y, title, i + 31);
      }

      {
        const lingerNow = Date.now();
        /** 截止未满 24h、仍应在地图留影的投票 */
        const lingerActive = [];
        for (const p of pollItems) {
          if (!p || p.isOpen) continue;
          const votes = Number(p.totalVotes);
          if (!Number.isFinite(votes) || votes < 1) continue;
          const e = Number(p.endsAtMs) || 0;
          if (e && lingerNow >= e && lingerNow < e + POLL_WINNER_PLAZA_LINGER_MS) lingerActive.push(p);
        }
        lingerActive.sort((a, b) => (Number(b.endsAtMs) || 0) - (Number(a.endsAtMs) || 0));
        if (zf === "all" || zf === "vote") {
          let ls = 0;
          for (const p of lingerActive) {
            const maxIdx = Math.max(0, (p.options?.length || 1) - 1);
            const wi = clamp(Number(p.leadingOptionIndex) || 0, 0, maxIdx);
            placePollWinnerPedestal(p, ls++, wi);
          }
        }
      }

      for (const p of postItems) {
        const z = boothZoneForPost(p);
        if (zf !== "all" && zf !== z) continue;
        const zc = zones[z] || zones.vote;
        const i = idx[z]++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8 * PS;
        const y = zc.y0 + row * zc.dy;

        const rawTitle = p.title || "（无标题）";
        const title = rawTitle.length > 8 ? `${rawTitle.slice(0, 8)}…` : rawTitle;
        const texOv = z === "vote" ? "stallStrip" : undefined;
        placeBooth(z, x, y, title, i, () => openDrawer(p), texOv);
      }

      for (const m of matchItems) {
        const z = "match";
        if (zf !== "all" && zf !== "match") continue;
        const zc = zones.match;
        const i = idx.match++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8 * PS;
        const y = zc.y0 + row * zc.dy;

        const line = `${matchRuleLabel(m.rule)}·${matchStatusZh(m.status)}`;
        const label = line.length > 11 ? `${line.slice(0, 11)}…` : line;
        placeBooth(z, x, y, label, i + 17, () => {
          openMatchDrawer(m);
        });
      }

      for (const sg of spyItems) {
        const z = "match";
        if (zf !== "all" && zf !== "match") continue;
        const zc = zones.match;
        const i = idx.match++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8 * PS;
        const y = zc.y0 + row * zc.dy;
        const statusZh = sg.status === "waiting" ? "招募" : sg.status === "playing" ? "进行中" : "结束";
        const n = (sg.players || []).length;
        const mx = sg.maxPlayers || 8;
        const label = `卧底·${statusZh} ${n}/${mx}`;
        placeBooth(z, x, y, label, i + 43, () => {
          openSpyGameDrawer(sg);
        });
      }
    }
  }

  const pixelRatio = getSquarePixelRatio();
  const config = {
    type: Phaser.AUTO,
    parent: "world",
    width: Math.max(1, Math.floor(container.clientWidth || 980)),
    height: Math.max(1, Math.floor(container.clientHeight || 520)),
    resolution: pixelRatio,
    pixelArt: true,
    backgroundColor: "#2e2824",
    scene: [PlazaScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      pixelArt: true,
      antialias: false,
      roundPixels: false,
    },
  };

  // eslint-disable-next-line no-undef
  const game = new Phaser.Game(config);
  
  // 绑定缩放控制到 worldState
  const ZOOM_STEP = 0.2;

  state.setZoom = (zoom) => {
    const cam = sceneRef?.cameras?.main;
    if (!cam) return false;
    const z = clamp(Number(zoom) || DEFAULT_PLAZA_ZOOM, PLAZA_ZOOM_SCENE_MIN, PLAZA_ZOOM_SCENE_MAX);
    cam.setZoom(z);
    return true;
  };
  
  state.getZoom = () => {
    if (sceneRef && sceneRef.cameras && sceneRef.cameras.main) {
      return sceneRef.cameras.main.zoom;
    }
    return DEFAULT_PLAZA_ZOOM;
  };
  
  state.zoomIn = () => {
    const cam = sceneRef?.cameras?.main;
    if (!cam) return false;
    const newZoom = Math.min(PLAZA_ZOOM_SCENE_MAX, cam.zoom + ZOOM_STEP);
    cam.setZoom(Math.round(newZoom * 40) / 40);
    return true;
  };

  state.zoomOut = () => {
    const cam = sceneRef?.cameras?.main;
    if (!cam) return false;
    const newZoom = Math.max(PLAZA_ZOOM_SCENE_MIN, cam.zoom - ZOOM_STEP);
    cam.setZoom(Math.round(newZoom * 40) / 40);
    return true;
  };
  
  state.zoomReset = () => {
    const cam = sceneRef?.cameras?.main;
    if (!cam) return false;
    cam.setZoom(DEFAULT_PLAZA_ZOOM);
    return true;
  };
  
  return state;
}

window.addEventListener("DOMContentLoaded", async () => {
  worldState = initWorld();
  wireStallZoneFilter();
  document.getElementById("refreshBtn").onclick = refresh;
  document.getElementById("moreBtn").onclick = () => loadFeed({ append: true });

  document.getElementById("drawerClose").onclick = () => {
    selectedPostId = null;
    selectedPost = null;
    selectedMatch = null;
    selectedPollId = null;
    setDrawerMode("post");
    document.getElementById("drawer").classList.add("hidden");
  };
  document.getElementById("drawerCopyMatchId").onclick = async () => {
    const id = selectedMatch?.id || selectedSpyGameId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      prompt("场次 ID（手动复制）", id);
    }
  };
  document.getElementById("drawerLike").onclick = async () => {
    if (!selectedPostId) return;
    await api(`/api/v1/posts/${selectedPostId}/like`, { method: "POST", body: "{}" });
    await refresh();
    await syncDrawerIfOpen();
  };
  document.getElementById("drawerComment").onclick = async () => {
    if (!selectedPostId) return;
    const text = prompt("写一句温柔的话（200 字以内）");
    if (!text) return;
    await api(`/api/v1/posts/${selectedPostId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    await refreshComments();
    await refresh();
    await syncDrawerIfOpen();
  };
  document.getElementById("drawerDelete").onclick = async () => {
    if (!selectedPostId || !isMyPost(selectedPost)) return;
    if (!confirm("确定删除这条作品？")) return;
    await api(`/api/v1/posts/${selectedPostId}`, { method: "DELETE" });
    selectedPostId = null;
    selectedPost = null;
    document.getElementById("drawer").classList.add("hidden");
    await refresh();
  };

  // ====== 方案 C: 缩放按钮控制 ======
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomResetBtn = document.getElementById("zoomResetBtn");
  const zoomLevelDisplay = document.getElementById("zoomLevel");
  const zoomSlider = document.getElementById("zoomSlider");
  let zoomSliderFingerDown = false;

  if (zoomSlider) {
    zoomSlider.min = String(PLAZA_ZOOM_SCENE_MIN * 100);
    zoomSlider.max = String(PLAZA_ZOOM_SCENE_MAX * 100);
    zoomSlider.step = "1";

    zoomSlider.addEventListener("pointerdown", () => {
      zoomSliderFingerDown = true;
    });
    zoomSlider.addEventListener(
      "pointerup",
      () => {
        zoomSliderFingerDown = false;
      },
      { passive: true },
    );
    zoomSlider.addEventListener(
      "pointercancel",
      () => {
        zoomSliderFingerDown = false;
      },
      { passive: true },
    );
    zoomSlider.addEventListener(
      "touchend",
      () => {
        zoomSliderFingerDown = false;
      },
      { passive: true },
    );

    zoomSlider.addEventListener(
      "input",
      () => {
        const v = Number(zoomSlider.value);
        if (!Number.isFinite(v)) return;
        worldState.setZoom(v / 100);
        if (worldState?.getZoom && zoomLevelDisplay) {
          const zoom = worldState.getZoom();
          zoomLevelDisplay.textContent = `${Math.round(zoom * 100)}%`;
        }
      },
      { passive: true },
    );
  }

  function updateZoomLevel() {
    if (worldState?.getZoom && zoomLevelDisplay) {
      const zoom = worldState.getZoom();
      zoomLevelDisplay.textContent = `${Math.round(zoom * 100)}%`;
    }
    if (worldState?.getZoom && zoomSlider && !zoomSliderFingerDown) {
      const zPct = clamp(
        Math.round(worldState.getZoom() * 100),
        PLAZA_ZOOM_SCENE_MIN * 100,
        PLAZA_ZOOM_SCENE_MAX * 100,
      );
      zoomSlider.value = String(zPct);
    }
  }

  if (zoomInBtn) {
    zoomInBtn.onclick = () => {
      if (worldState && worldState.zoomIn) {
        worldState.zoomIn();
        updateZoomLevel();
      }
    };
  }

  if (zoomOutBtn) {
    zoomOutBtn.onclick = () => {
      if (worldState && worldState.zoomOut) {
        worldState.zoomOut();
        updateZoomLevel();
      }
    };
  }

  if (zoomResetBtn) {
    zoomResetBtn.onclick = () => {
      if (worldState && worldState.zoomReset) {
        worldState.zoomReset();
        updateZoomLevel();
      }
    };
  }

  // 初始更新缩放级别（Phaser 场景就绪后很快同步真实 zoom）
  setTimeout(updateZoomLevel, 150);
  // 定期同步
  setInterval(updateZoomLevel, 280);

  const roachRoyalePanel = document.getElementById("roachRoyalePanel");
  const roachRoyaleBadge = document.getElementById("roachRoyaleBadge");
  const roachRoyaleTimerLabel = document.getElementById("roachRoyaleTimerLabel");
  const roachRoyaleTimerValue = document.getElementById("roachRoyaleTimerValue");
  const roachRoyaleKills = document.getElementById("roachRoyaleKills");
  const roachRoyaleRoaches = document.getElementById("roachRoyaleRoaches");
  const roachRoyaleDuration = document.getElementById("roachRoyaleDuration");
  const roachRoyaleCycle = document.getElementById("roachRoyaleCycle");
  const roachRoyaleHint = document.getElementById("roachRoyaleHint");
  const roachRoyaleChip = document.getElementById("roachRoyaleChip");

  function updateRoachRoyaleHud() {
    const scene = sceneRef;
    if (!scene?.getRoachRoyaleUiState) {
      if (roachRoyaleChip) roachRoyaleChip.classList.add("hidden");
      return;
    }
    const ui = scene.getRoachRoyaleUiState();
    const clock = formatRoyaleClock(ui.active ? ui.remainSec : ui.nextStartSec);

    if (roachRoyalePanel) {
      roachRoyalePanel.classList.toggle("is-active", ui.active);
    }
    if (roachRoyaleBadge) {
      roachRoyaleBadge.textContent = ui.active ? "进行中" : "等待下一场";
      roachRoyaleBadge.classList.toggle("is-active", ui.active);
    }
    if (roachRoyaleTimerLabel) {
      roachRoyaleTimerLabel.textContent = ui.active ? "本场剩余" : "下一场开始";
    }
    if (roachRoyaleTimerValue) {
      roachRoyaleTimerValue.textContent = clock;
    }
    if (roachRoyaleKills) {
      roachRoyaleKills.textContent = ui.active ? `${ui.kills} / ${ui.winKills}` : "—";
    }
    if (roachRoyaleRoaches) {
      roachRoyaleRoaches.textContent = ui.active
        ? `${ui.roaches} / ${ui.maxRoaches}`
        : String(ui.roaches);
    }
    if (roachRoyaleDuration) {
      roachRoyaleDuration.textContent = `${ui.durationMin} 分钟`;
    }
    if (roachRoyaleCycle) {
      roachRoyaleCycle.textContent = `${ui.cycleDays} 天`;
    }
    if (roachRoyaleHint) {
      roachRoyaleHint.textContent = ui.active
        ? ui.endedEarly
          ? "本场已提前结束，计时器显示距离下一轮开始的倒计时。"
          : "猎食者正在追蟑。累计 >100 只或蟑螂清零即胜。"
        : "间歇期：广场恢复正常。倒计时归零时大逃杀自动开始。";
    }
    if (roachRoyaleChip) {
      roachRoyaleChip.classList.remove("hidden");
      roachRoyaleChip.classList.toggle("is-active", ui.active);
      roachRoyaleChip.textContent = ui.active ? `🪳 进行中 ${clock}` : `🪳 下一场 ${clock}`;
      roachRoyaleChip.title = ui.active
        ? `蟑螂大逃杀进行中，剩余 ${clock}`
        : `距离下一场大逃杀 ${clock}`;
    }
  }

  setTimeout(updateRoachRoyaleHud, 200);
  setInterval(updateRoachRoyaleHud, 500);

  await refresh();
});
