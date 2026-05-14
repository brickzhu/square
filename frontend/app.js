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
      this.cat = null;
      /** @type {{ sprite: Phaser.GameObjects.Image, home: {x:number,y:number}, target: {x:number,y:number}, retargetAt: number }[]} */
      this.lizards = [];
      this.mice = [];
      this.roaches = [];
      this.roachBreedLock = 0;
      this.snakes = [];
      /** 牛蛙：活动在水池内/旁；捕食除猫、蛇外的动物 */
      this.frogs = [];
      this.catChaseMouse = null;
      this.mouseBreedLock = 0;
      /** 老鼠随机游荡的轴对齐范围（与相机大地砖边界一致，留边避免贴边） */
      this.mouseRoam = null;
      /** 摊位前的虾 / 棋子等小 NPC（与猫鼠蜥蜴一样受喷泉弹射） */
      this.boothNpcs = [];
      /** 「虾扯蛋」：可拖蛋的摆摊小龙虾锚点（竞技场棋子摊除外）；含摊位中心与小虾归位坐标 */
      this.stallShrimpSites = [];
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
      /** @type {{ phase: string, poolIndex: number, catchDoneAt?: number, exitX?: number, exitY?: number, leaveUntil?: number } | null} */
      this.catFishing = null;
      this._nextCatFishAt = 0;
      /** 井盖世界坐标（与 create 里 manhole 圆心一致），供鼠蟑传送与寻路 */
      this.manholes = [];
    }

    syncPlazaChallengersFromFeed(items, boothGen) {
      const list = items || [];
      const wanted = new Set(list.map((x) => x.id));
      for (const id of [...this.plazaChallengerMap.keys()]) {
        if (!wanted.has(id)) {
          const o = this.plazaChallengerMap.get(id);
          try {
            o?.sprite?.destroy();
          } catch {
            /* noop */
          }
          try {
            o?.label?.destroy();
          } catch {
            /* noop */
          }
          this.plazaChallengerMap.delete(id);
        }
      }

      const PS = this.plazaScale || 1;
      const scene = this;

      for (const it of list) {
        if (!it?.id || !it.imageUrl) continue;
        if (this.plazaChallengerMap.has(it.id)) {
          const o = this.plazaChallengerMap.get(it.id);
          o.hp = Number(it.hp) || 0;
          o.maxHp = Math.max(1, Number(it.maxHp) || 8);
          if (o.label?.active) {
            o.label.setText(
              `${sanitizePlazaShortName(it.displayName)} · ♥${o.hp}/${o.maxHp}`,
            );
          }
          continue;
        }

        const pid = String(it.id).replace(/[^a-zA-Z0-9_]/g, "_");
        const k = `pch_${pid}`;
        const kRaw = `${k}_raw`;
        let abs;
        try {
          abs = new URL(it.imageUrl, window.location.origin).href;
        } catch {
          abs = it.imageUrl;
        }

        /** @type {{ x: number, y: number }} */
        const spawnPt = this.clampPosToPlaza(
          (Math.random() - 0.5) * 140 * PS,
          (Math.random() - 0.5) * 140 * PS,
        );

        const mount = (showKey) => {
          if (scene._boothGen !== boothGen) return;
          if (!scene.textures.exists(showKey)) return;
          if (scene.plazaChallengerMap.has(it.id)) return;
          const sp = scene.add
            .image(spawnPt.x, spawnPt.y, showKey)
            .setOrigin(0.5, 0.92)
            .setDepth(17.42)
            .setDisplaySize(38 * PS, 45 * PS);
          const cid = String(it.id);

          const lab = scene.add
            .text(
              spawnPt.x,
              spawnPt.y - 50 * PS,
              `${sanitizePlazaShortName(it.displayName)} · ♥${Number(it.hp) || 0}/${Math.max(
                1,
                Number(it.maxHp) || 8,
              )}`,
              {
                fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
                fontSize: `${Math.max(9, Math.round(9 * PS))}px`,
                color: "#fef9f3",
                backgroundColor: "rgba(28,22,18,0.74)",
                padding: { x: 4, y: 2 },
              },
            )
            .setOrigin(0.5, 1)
            .setDepth(17.45);

          scene.plazaChallengerMap.set(it.id, {
            sprite: sp,
            label: lab,
            hp: Number(it.hp) || 0,
            maxHp: Math.max(1, Number(it.maxHp) || 8),
            lastStrikeAttemptMs: 0,
          });
        };

        if (scene.textures.exists(k)) {
          mount(k);
          continue;
        }

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
    }

    async requestPlazaChallengerStrike(cid) {
      try {
        const j = await api(`/api/v1/plaza-challengers/${encodeURIComponent(cid)}/strike`, {
          method: "POST",
          body: "{}",
        });
        if (!j?.ok) return;
        const o = this.plazaChallengerMap.get(cid);
        if (j.eliminatedChallenger && o) {
          try {
            o.sprite.destroy();
          } catch {
            /* noop */
          }
          try {
            o.label.destroy();
          } catch {
            /* noop */
          }
          this.plazaChallengerMap.delete(cid);
          return;
        }
        if (j.item && o?.label?.active) {
          o.hp = Number(j.item.hp) || o.hp;
          o.maxHp = Math.max(1, Number(j.item.maxHp) || o.maxHp);
          o.label.setText(
            `${sanitizePlazaShortName(j.item.displayName)} · ♥${o.hp}/${o.maxHp}`,
          );
        }
      } catch {
        /* noop */
      }
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
      if (this.catChaseMouse === m.sprite) return true;
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

    roachSeeksManhole(ro, now) {
      const rx = ro.sprite.x;
      const ry = ro.sprite.y;
      for (const lz of this.lizards || []) {
        if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) continue;
        const sp = lz.sprite;
        if (Math.hypot(sp.x - rx, sp.y - ry) < ROACH_MANHOLE_PANIC_LIZARD) return true;
      }
      for (const snk of this.snakes || []) {
        if (Math.hypot(snk.sprite.x - rx, snk.sprite.y - ry) < ROACH_MANHOLE_PANIC_SNAKE) return true;
      }
      for (const fr of this.frogs || []) {
        const fp = fr.sprite;
        if (!fp || !fp.active) continue;
        if (Math.hypot(fp.x - rx, fp.y - ry) < ROACH_MANHOLE_PANIC_FROG) return true;
      }
      return false;
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
      if (this.catChaseMouse === m.sprite) this.catChaseMouse = null;
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
        if (!site.npc?.active || site.busy || site.eggBatchResolving) continue;
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
        if (now > f.retargetAt) {
          f.retargetAt = now + 900 + Math.random() * 1400;
          const p = this.randomPointInsidePlazaPool(pool);
          f.target.x = p.x;
          f.target.y = p.y;
        }
        let x = f.sprite.x;
        let y = f.sprite.y;
        const tx = f.target.x - x;
        const ty = f.target.y - y;
        const len = Math.hypot(tx, ty) || 1;
        x += (tx / len) * FISH_SWIM_SPEED * dt;
        y += (ty / len) * FISH_SWIM_SPEED * dt;
        f.sprite.setPosition(x, y);
        f.sprite.setFlipX(tx < 0);
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

    updateCatFishing(cat, now, dt) {
      const cf = this.catFishing;
      if (!cf) return;
      if (this.arboreal) {
        this.catFishing = null;
        this._nextCatFishAt = now + CAT_FISH_INTERVAL_MS;
        return;
      }
      const pool = this.plazaPools[cf.poolIndex];
      if (!pool) {
        this.catFishing = null;
        this._nextCatFishAt = now + CAT_FISH_INTERVAL_MS;
        return;
      }
      const center = this.poolCenter(pool);
      const vCat = 30;
      const pad = 11 * (this.plazaScale || 1);

      if (cf.phase === "approach") {
        const b = this.nearestPointOnPlazaPoolBoundary(pool, cat.x, cat.y);
        if (!b) {
          this.catFishing = null;
          this._nextCatFishAt = now + CAT_FISH_INTERVAL_MS;
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
        if (this.bounceIfNearFountain(cat, now)) this.catChaseMouse = null;
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
          this.catFishing = null;
          this._nextCatFishAt = now + CAT_FISH_INTERVAL_MS;
        } else {
          const step = Math.min(26 * dt, d);
          cat.x += (dx / d) * step;
          cat.y += (dy / d) * step;
          this.clampSpriteToPlaza(cat);
          if (this.bounceIfNearFountain(cat, now)) this.catChaseMouse = null;
          this.clampSpriteToPlaza(cat);
        }
        this.aimCatAt(cat, cf.exitX ?? cat.x, cf.exitY ?? cat.y);
      }
    }

    initPondFish() {
      this.pondFish = [];
      this.pondFishEggs = [];
      this.catFishing = null;
      this._nextCatFishAt = this.time.now + CAT_FISH_INTERVAL_MS;
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

    randomPlazaWalkPointAvoidingPools() {
      const p = this.plazaWalkBounds;
      if (!p) return null;
      for (let attempt = 0; attempt < 48; attempt++) {
        const tx = p.minX + Math.random() * (p.maxX - p.minX);
        const ty = p.minY + Math.random() * (p.maxY - p.minY);
        if (!this.pointInAnyPlazaPool(tx, ty)) return { x: tx, y: ty };
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

    createFrogAt(x, y) {
      const sprite = this.add
        .image(x, y, "frog")
        .setOrigin(0.5, 0.52)
        .setDepth(15.6)
        .setScale(0.58);
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        nextEatAt: 0,
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
      const lz = {
        sprite: this.add.image(c.x, c.y, "lizard").setOrigin(0.5).setDepth(16),
        home: { x: c.x, y: c.y },
        target: { x: c.x, y: c.y },
        retargetAt: this.time.now + 500 + Math.random() * 400,
      };
      this.pickLizardTarget(lz);
      this.lizards.push(lz);
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
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        nextRoachEatAt: 0,
        nextEggEatAt: 0,
        nextManholeAt: 0,
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

    createRoachAt(x, y) {
      const sprite = this.add
        .image(x, y, "roach")
        .setOrigin(0.5)
        .setDepth(15)
        .setScale(0.25);
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
        nextManholeAt: 0,
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
      };
    }

    aimCatAt(cat, tx, ty) {
      const dx = tx - cat.x;
      const dy = ty - cat.y;
      if (Math.hypot(dx, dy) < 0.01) return;
      cat.setRotation(0);
      if (Math.abs(dx) > 0.5) cat.setFlipX(dx > 0);
    }

    /** 当前帧猫是否在追老鼠（用于上树：追鼠时不爬树）。老鼠少于 3 只时暂停追猎，让种群恢复。 */
    resolveCatMouseChase(cat) {
      const MOUSE_AGRO = 52;
      const MIN_MICE_FOR_CAT_CHASE = 3;
      if (this.mice.length < MIN_MICE_FOR_CAT_CHASE) {
        this.catChaseMouse = null;
        return null;
      }
      let chaseMouseSprite = null;
      if (this.catChaseMouse) {
        const alive = this.mice.find((mm) => mm.sprite === this.catChaseMouse);
        if (alive) chaseMouseSprite = alive.sprite;
        else this.catChaseMouse = null;
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
          this.catChaseMouse = nearest.sprite;
          chaseMouseSprite = nearest.sprite;
        }
      }
      return chaseMouseSprite;
    }

    update(_t, delta) {
      const now = this.time.now;
      const dt = Math.min((delta || 16) / 1000, 0.045);
      this.updatePlazaPoolFlow(now);
      this.updateFountainWater(now);
      this.updateStallShrimpEggPulls(now, dt);
      this.updatePondFish(now, dt);
      const cat = this.cat;
      if (!cat) return;

      if (!this.catFishing && !this.arboreal && this.plazaPools.length && now >= this._nextCatFishAt) {
        const pi = this.nearestPlazaPoolIndexTo(cat.x, cat.y);
        if (pi >= 0) {
          this.catFishing = { phase: "approach", poolIndex: pi };
          this.catChaseMouse = null;
        }
      }
      const cx0 = cat.x;
      const cy0 = cat.y;
      const chaseMouseSpriteEarly = this.resolveCatMouseChase(cat);
      const MOUSE_AGRO = 52;
      const MOUSE_CATCH = 13;
      const MOUSE_BREED_DIST = 22;
      const MAX_MICE = 12;
      const MOUSE_ROACH_EAT_DIST = 10;
      const MOUSE_ROACH_EAT_COOLDOWN_MS = 30000;

      const herdSeek =
        this.mice.length < 6 && this.mice.length > 1;
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

      for (const m of this.mice) {
        if (this.tryManholeTeleportMouse(m, now)) continue;

        if (!herdSeek) {
          if (now > m.retargetAt) {
            m.retargetAt = now + 1100 + Math.random() * 1100;
            this.pickMouseTarget(m);
          }
        }

        let mx = m.sprite.x;
        let my = m.sprite.y;
        let mtx;
        let mty;
        let mlen;
        let flipLeft;

        const mousePanic = this.mouseSeeksManhole(m, cx0, cy0, now);
        const mh = mousePanic && this.manholes.length ? this.nearestManholeTo(mx, my) : null;

        if (herdSeek && !mousePanic) {
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

        const vMouse = 21;

        if (herdSeek && !mousePanic) {
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
          mx += sx * vMouse * dt;
          my += sy * vMouse * dt;
        } else {
          mx += (mtx / mlen) * vMouse * dt;
          my += (mty / mlen) * vMouse * dt;
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
        m.sprite.setFlipX(flipLeft);
        if (this.bounceIfNearFountain(m.sprite, now)) {
          m.home.x = m.sprite.x;
          m.home.y = m.sprite.y;
          this.pickMouseTarget(m);
        }
        this.clampSpriteToPlaza(m.sprite);

        if (now >= (m.nextRoachEatAt || 0)) {
          for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
            const ro = this.roaches[ri];
            if (Math.hypot(ro.sprite.x - m.sprite.x, ro.sprite.y - m.sprite.y) < MOUSE_ROACH_EAT_DIST) {
              ro.sprite.destroy();
              this.roaches.splice(ri, 1);
              m.nextRoachEatAt = now + MOUSE_ROACH_EAT_COOLDOWN_MS;
              break;
            }
          }
        }
        if (now >= (m.nextEggEatAt || 0)) {
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

      const ROACH_AGRO = 45;
      const ROACH_EAT = 5;
      const V_ROACH = 8.2;
      /** 略放宽，方便在蜥蜴压力下仍能碰头繁殖 */
      const ROACH_BREED_DIST = 26;
      const MAX_ROACHES = 96;
      /** 全广场只剩 1 只蟑螂时立刻在旁补殖的数量（不含母体；受 MAX_ROACHES 截断） */
      const ROACH_LAST_STAND_BROOD = 10;
      const V_LIZARD_CHASE_ROACH = 20;
      const ROACH_FLEE_LIZARD_RADIUS = 50;
      const ROACH_FLEE_ACCEL = 13;
      const ROACH_FLEE_SNAKE_RADIUS = 44;
      const ROACH_FLEE_SNAKE_ACCEL = 10;

      for (const ro of this.roaches) {
        if (this.tryManholeTeleportRoach(ro, now)) continue;

        const roachPanic = this.roachSeeksManhole(ro, now);
        const roachMh = roachPanic && this.manholes.length ? this.nearestManholeTo(ro.sprite.x, ro.sprite.y) : null;

        if (!roachMh && now > ro.retargetAt) {
          ro.retargetAt = now + 1600 + Math.random() * 2000;
          this.pickRoachTarget(ro);
        }
        let rx = ro.sprite.x;
        let ry = ro.sprite.y;
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
        const vRoachEff = roachPanic ? V_ROACH * 1.35 : V_ROACH;
        rx += (rtx / rlen) * vRoachEff * dt;
        ry += (rty / rlen) * vRoachEff * dt;

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
          rx += (fx / fl) * ROACH_FLEE_ACCEL * dt;
          ry += (fy / fl) * ROACH_FLEE_ACCEL * dt;
        }
        for (const snk of this.snakes) {
          const ss = snk.sprite;
          const dx = rx - ss.x;
          const dy = ry - ss.y;
          const d = Math.hypot(dx, dy);
          if (d < ROACH_FLEE_SNAKE_RADIUS && d > 0.01) {
            rx += (dx / d) * ROACH_FLEE_SNAKE_ACCEL * dt;
            ry += (dy / d) * ROACH_FLEE_SNAKE_ACCEL * dt;
          }
        }

        ro.sprite.setPosition(rx, ry);
        this.clampSpriteToPlaza(ro.sprite);
        ro.sprite.setFlipX(roachMh ? rtx < 0 : (ro.target.x - rx) < 0);
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
              const addN = Math.min(3, room);
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

      const V_SNAKE = 22;
      const SNAKE_HUNT_RANGE = 118;
      const SNAKE_WRIGGLE_SPEED = 13;
      const SNAKE_SIDE_SLEW = 26;
      const SNAKE_EAT_DIST = 12;
      const SNAKE_EAT_MOUSE_COOLDOWN_MS = 60_000;
      const SNAKE_EAT_ROACH_COOLDOWN_MS = 850;

      for (const snk of this.snakes) {
        const sp = snk.sprite;
        let sx = sp.x;
        let sy = sp.y;

        let preyX = null;
        let preyY = null;
        let bestPd = SNAKE_HUNT_RANGE;
        const canHuntMouse = now >= (snk.nextEatMouseAt || 0);
        const canHuntEgg = now >= (snk.nextEatEggAt || 0);
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

        let tx;
        let ty;
        if (preyX != null) {
          tx = preyX;
          ty = preyY;
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
        sx += ux * V_SNAKE * dt + px * side;
        sy += uy * V_SNAKE * dt + py * side;

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

        if (now >= (snk.nextEatMouseAt || 0)) {
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
            if (Math.hypot(ro.sprite.x - sp.x, ro.sprite.y - sp.y) < SNAKE_EAT_DIST) {
              ro.sprite.destroy();
              this.roaches.splice(ri, 1);
              snk.nextEatRoachAt = now + SNAKE_EAT_ROACH_COOLDOWN_MS;
              break;
            }
          }
        }
        if (now >= (snk.nextEatLizardAt || 0)) {
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
        if (now >= (snk.nextEatEggAt || 0)) {
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
      }

      let skipCatGround = false;
      if (this.arboreal) {
        const a = this.arboreal;
        const treeLizSp = a.liz.sprite;
        if (a.catJoined && a.lizardFled && a.catDownAt != null && now >= a.catDownAt) {
          const cp = this.clampPosToPlaza(a.baseX - 8 + (Math.random() - 0.5) * 4, a.baseY + 4, this.cat);
          this.cat.setPosition(cp.x, cp.y);
          this.cat.setDepth(15);
          const lzRef = a.liz;
          this.arboreal = null;
          this._arborealCooldownUntil = now + 900;
          this.pickLizardTarget(lzRef);
          lzRef.retargetAt = now + 700;
        } else if (!a.catJoined && !a.lizardFled && now >= a.lizardSoloDownAt) {
          const lp = this.clampPosToPlaza(a.baseX + (Math.random() - 0.5) * 6, a.baseY + 2, treeLizSp);
          treeLizSp.setPosition(lp.x, lp.y);
          treeLizSp.setDepth(16);
          const lzRef = a.liz;
          this.arboreal = null;
          this._arborealCooldownUntil = now + 900;
          this.pickLizardTarget(lzRef);
          lzRef.retargetAt = now + 700;
        } else {
          if (!a.lizardFled) {
            treeLizSp.setPosition(a.lizardPerchX, a.lizardPerchY);
            treeLizSp.setDepth(20);
            treeLizSp.setFlipX(a.lizardFlip);
          }
          if (!a.catJoined && !chaseMouseSpriteEarly && !a.lizardFled) {
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
              this.catChaseMouse = null;
              this.fleeLizardFromCatArboreal(a, cat, now);
              this.cat.setPosition(a.catPerchX, a.catPerchY);
              this.cat.setDepth(21);
              skipCatGround = true;
            }
          } else if (a.catJoined && a.catDownAt != null && now < a.catDownAt) {
            skipCatGround = true;
            this.cat.setPosition(a.catPerchX, a.catPerchY);
            this.cat.setDepth(21);
            this.aimCatAt(cat, a.liz.sprite.x, a.liz.sprite.y);
          }
        }
      }

      if (this.catFishing) {
        skipCatGround = true;
        this.updateCatFishing(cat, now, dt);
      }

      for (const lz of this.lizards) {
        if (this.arboreal && this.arboreal.liz === lz && !this.arboreal.lizardFled) {
          continue;
        }
        const liz = lz.sprite;

        let chaseRoach = null;
        let bestRoachD = ROACH_AGRO;
        for (const ro of this.roaches) {
          const rd = Math.hypot(ro.sprite.x - liz.x, ro.sprite.y - liz.y);
          if (rd < bestRoachD) {
            bestRoachD = rd;
            chaseRoach = ro;
          }
        }

        let lx = liz.x;
        let ly = liz.y;

        if (chaseRoach) {
          const tx = chaseRoach.sprite.x - lx;
          const ty = chaseRoach.sprite.y - ly;
          const len = Math.hypot(tx, ty) || 1;
          lx += (tx / len) * V_LIZARD_CHASE_ROACH * dt;
          ly += (ty / len) * V_LIZARD_CHASE_ROACH * dt;
          liz.setFlipX(tx > 0);
        } else {
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
          const vL = 34;
          lx += (tx / len) * vL * dt;
          ly += (ty / len) * vL * dt;
          liz.setFlipX((lz.target.x - lx) < 0);
        }

        let dx = lx - cx0;
        let dy = ly - cy0;
        let dist = Math.hypot(dx, dy) || 1;
        if (dist < 40) {
          const flee = 78 * dt;
          lx += (dx / dist) * flee;
          ly += (dy / dist) * flee;
        }

        for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
          const ro = this.roaches[ri];
          if (Math.hypot(ro.sprite.x - lx, ro.sprite.y - ly) < ROACH_EAT) {
            ro.sprite.destroy();
            this.roaches.splice(ri, 1);
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

        if (!this.arboreal && now > this._arborealCooldownUntil) {
          const nearTree = this.findNearestTreeSpot(liz.x, liz.y, 32);
          if (nearTree) this.startArboreal(nearTree, now, lz);
        }
      }

      const V_FROG = 19;
      const fPS = this.plazaScale || 1;
      const FROG_HUNT_RANGE = 112 * fPS;
      const FROG_EAT_DIST = 12 * fPS;
      const FROG_EAT_COOLDOWN_MS = 720;

      for (const fr of this.frogs) {
        const fp = fr.sprite;
        let fx = fp.x;
        let fy = fp.y;

        let preyX = null;
        let preyY = null;
        let bestFd = FROG_HUNT_RANGE;
        for (const m of this.mice) {
          const d = Math.hypot(m.sprite.x - fx, m.sprite.y - fy);
          if (d < bestFd) {
            bestFd = d;
            preyX = m.sprite.x;
            preyY = m.sprite.y;
          }
        }
        for (const ro of this.roaches) {
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
        let ftx;
        let fty;
        if (preyX != null) {
          ftx = preyX;
          fty = preyY;
        } else {
          if (now > fr.retargetAt) {
            fr.retargetAt = now + 1800 + Math.random() * 1600;
            this.pickFrogTarget(fr);
          }
          ftx = fr.target.x;
          fty = fr.target.y;
        }

        let fdx = ftx - fx;
        let fdy = fty - fy;
        let flen = Math.hypot(fdx, fdy) || 1;
        fx += (fdx / flen) * V_FROG * dt;
        fy += (fdy / flen) * V_FROG * dt;
        fp.setPosition(fx, fy);
        fp.setRotation(Math.atan2(fdy, fdx) * 0.08);
        fp.setFlipX(fdx < 0);
        this.clampSpriteToPlaza(fp, true);
        this.clampFrogToPoolShore(fp);
        if (this.bounceIfNearFountain(fp, now)) {
          fr.home.x = fp.x;
          fr.home.y = fp.y;
          this.pickFrogTarget(fr);
          fr.retargetAt = now + 500;
        }
        this.clampSpriteToPlaza(fp, true);
        this.clampFrogToPoolShore(fp);

        if (now >= (fr.nextEatAt || 0)) {
          let ate = false;
          for (let mi = this.mice.length - 1; mi >= 0; mi--) {
            const m = this.mice[mi];
            if (Math.hypot(m.sprite.x - fp.x, m.sprite.y - fp.y) < FROG_EAT_DIST) {
              m.sprite.destroy();
              this.mice.splice(mi, 1);
              ate = true;
              break;
            }
          }
          if (!ate) {
            for (let ri = this.roaches.length - 1; ri >= 0; ri--) {
              const ro = this.roaches[ri];
              if (Math.hypot(ro.sprite.x - fp.x, ro.sprite.y - fp.y) < FROG_EAT_DIST) {
                ro.sprite.destroy();
                this.roaches.splice(ri, 1);
                ate = true;
                break;
              }
            }
          }
          if (!ate) {
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
          if (ate) fr.nextEatAt = now + FROG_EAT_COOLDOWN_MS;
        }
      }

      if (!skipCatGround) {
        const chaseLiz = this.nearestLizardEntry(cat);

        let chaseMx = null;
        let chaseMy = null;
        let chaseMouseSprite = chaseMouseSpriteEarly;
        let vCat = 25;
        if (chaseMouseSprite) {
          chaseMx = chaseMouseSprite.x;
          chaseMy = chaseMouseSprite.y;
          vCat = 34;
        }

        let tcx = cat.x;
        let tcy = cat.y;
        if (chaseMouseSprite) {
          tcx = chaseMx;
          tcy = chaseMy;
        } else if (chaseLiz) {
          tcx = chaseLiz.sprite.x;
          tcy = chaseLiz.sprite.y;
        }

        const cdx = tcx - cat.x;
        const cdy = tcy - cat.y;
        const cdist = Math.hypot(cdx, cdy) || 1;
        if (cdist > 0.01) {
          const step = Math.min(vCat * dt, cdist);
          cat.x += (cdx / cdist) * step;
          cat.y += (cdy / cdist) * step;
        }
        this.clampSpriteToPlaza(cat);

        this.aimCatAt(cat, tcx, tcy);
        if (this.bounceIfNearFountain(cat, now)) {
          this.catChaseMouse = null;
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
            this.catChaseMouse = null;
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


      for (const npc of this.boothNpcs) {
        if (npc && npc.active) {
          this.bounceIfNearFountain(npc, now);
          this.clampSpriteToPlaza(npc);
        }
      }
    }

    create() {
      sceneRef = this;
      /* 核心广场尺寸（喷泉、路、分区）以 (0,0) 居中；外围再铺大地砖，缩到最小也不会露出背景色 */
      const TILE = 16;
      const ZOOM_MIN = PLAZA_ZOOM_SCENE_MIN;
      /** 相对最初版广场的边长倍数（1.5 = 在原始尺寸上再扩大半倍） */
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
      cam.roundPixels = true;
      cam.centerOn(0, 0);

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
// 小蜥蜴（在猫巡逻带附近溜达，被追时会加速甩开）
      makeTexture(this, "lizard", 16, 10, (g) => {
        g.fillStyle(0x4a8f5c, 1).fillRect(2, 4, 10, 5);
        g.fillStyle(0x3d6b48, 1).fillRect(0, 5, 3, 3);
        g.fillStyle(0x5ab070, 0.9).fillRect(4, 3, 6, 3);
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

      // 沿路林带 + 四角密林
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
      for (const [x, y, k, s] of borderTrees) placeTree(x, y, k, s, (x + y) % 2 === 0);

      // 集群小树丛
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
      for (const [cx, cy, dir] of clusters) {
        placeTree(cx, cy, treeKeys[Math.abs(cx + cy) % 4], 0.92, dir < 0);
        placeTree(cx + 18 * PS * dir, cy + 10 * PS, "treePine", 0.85, dir > 0);
        this.add
          .image(cx - 14 * PS * dir, cy - 8 * PS, "bush")
          .setOrigin(0.5)
          .setScale(1.15)
          .setDepth(depthScenery);
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

      this.cat = this.add.image(-118 * PS, 88 * PS, "cat").setOrigin(0.5).setDepth(15).setScale(1.18);
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
        const lz = {
          sprite: this.add.image(x, y, "lizard").setOrigin(0.5).setDepth(16),
          home: { x, y },
          target: { x, y },
          retargetAt: this.time.now + 800 + i * 220,
        };
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
        const pool = this.plazaPools[fi % this.plazaPools.length];
        const p0 = this.randomPointInsidePlazaPool(pool);
        const fr = this.createFrogAt(p0.x, p0.y);
        fr.retargetAt = this.time.now + fi * 240;
        this.pickFrogTarget(fr);
        this.frogs.push(fr);
      }

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
          if (z === "avatar") npc.setTint(0xffb8c6);
          else if (z === "forum") npc.setTint(0xffe8a0);
          else if (z === "vote") npc.setTint(0xa8c8e8);
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
          this.stallShrimpSites.push({
            npc,
            stallX: x,
            stallY: y,
            npcHomeX: npc.x,
            npcHomeY: npc.y,
            busy: false,
            eggBasket: [],
            eggBasketIcons: [],
            eggBatchResolving: false,
          });
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
        const npc = this.add.image(x - 16 * PS, y + 10 * PS, "shrimp").setOrigin(0.5).setDepth(8).setTint(0x9ec5e8);
        this.tweens.add({
          targets: npc,
          y: y + 10 * PS - 2,
          duration: 700 + (tweenSeed % 5) * 60,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        this.boothNpcs.push(npc);
        this.stallShrimpSites.push({
          npc,
          stallX: x,
          stallY: y,
          npcHomeX: npc.x,
          npcHomeY: npc.y,
          busy: false,
          eggBasket: [],
          eggBasketIcons: [],
          eggBatchResolving: false,
        });
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

      this.syncPlazaChallengersFromFeed(state.plazaChallengers || [], boothGen);
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
      roundPixels: true,
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

  await refresh();
});
