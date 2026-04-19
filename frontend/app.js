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
/** 已加载的帖子（含「加载更多」追加），与对局合并后渲染动态 */
let feedPostsBuffer = [];

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

function isMyPost(p) {
  return !!(p && p.author && p.author.userId === getSquareUserId());
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
  return "strip";
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
  const m = entry.item;
  const u = Number(m.updatedAtMs);
  const c = Number(m.createdAtMs);
  if (Number.isFinite(u) && u > 0) return u;
  if (Number.isFinite(c) && c > 0) return c;
  return 0;
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

function rebuildFeedList() {
  const feed = document.getElementById("feed");
  if (!feed || !worldState) return;
  feed.innerHTML = "";
  const zf = worldState.stallZoneFilter || "all";
  const entries = [];
  for (const p of feedPostsBuffer) {
    if (zf === "all" || boothZoneForPost(p) === zf) entries.push({ kind: "post", item: p });
  }
  for (const m of worldState.matches || []) {
    if (isDemoMatch(m)) continue;
    if (zf === "all" || zf === "match") entries.push({ kind: "match", item: m });
  }
  entries.sort((a, b) => feedEntrySortKey(b) - feedEntrySortKey(a));
  for (const e of entries) {
    if (e.kind === "post") feed.appendChild(renderPost(e.item));
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
  if (!append) feedPostsBuffer = newPosts.slice();
  else feedPostsBuffer.push(...newPosts);
  cursor = data.nextCursor || null;

  if (worldState) {
    worldState.matches = matchesForMap;
    worldState.setPosts(feedPostsBuffer);
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
  if (!selectedPostId) return;
  const data = await api(`/api/v1/feed?limit=100`);
  const updated = (data.items || []).find((it) => it.id === selectedPostId);
  if (updated) await openDrawer(updated);
}

async function openMatchDrawer(m) {
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
    stallZoneFilter: "all",
    setPosts(items) {
      this.posts = items || [];
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.stallZoneFilter);
    },
    setStallZoneFilter(zone) {
      const ok = new Set(["all", "strip", "avatar", "match", "forum"]);
      this.stallZoneFilter = ok.has(zone) ? zone : "all";
      sceneRef?.refreshBooths?.(this.posts, this.matches, this.stallZoneFilter);
      rebuildFeedList();
    },
  };

  let sceneRef = null;
  /** 广场相机默认/重置缩放（与 UI 百分比一致，当前70%） */
  const DEFAULT_PLAZA_ZOOM = 0.7;

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
      this.catChaseMouse = null;
      this.mouseBreedLock = 0;
      /** 老鼠随机游荡的轴对齐范围（与相机大地砖边界一致，留边避免贴边） */
      this.mouseRoam = null;
      /** 摊位前的虾 / 棋子等小 NPC（与猫鼠蜥蜴一样受喷泉弹射） */
      this.boothNpcs = [];
      /** 中心喷泉 (0,0) 贴图约 40px；进入此半径则弹到内层分区铺砖格上（不外飞到外围大地砖） */
      this.fountainTeleportRadius = 34;
      /** create() 里填入：主广场四分区所在瓷砖网格（与 tileA/tileB 范围一致） */
      this.plazaTileGrid = null;
      /** 可爬的树（树干接地点，与 placeTree 的 x,y 一致） */
      this.treeSpots = [];
      /** 蜥蜴爬树 / 猫上树：猫上树后蜥蜴立刻逃走，猫独自在树上等 10s */
      this.arboreal = null;
      this._arborealCooldownUntil = 0;
      /** 主广场可行走矩形（核心 tileA/tileB 区，不含外围大地砖）；create() 赋值 */
      this.plazaWalkBounds = null;
      /** 四分区景观水池（随机形状）；动物不可进入，目标点也会避开 */
      this.plazaPools = [];
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

    createPlazaZonePools() {
      this.plazaPools = [];
      const zones = [
        { x: -283, y: -215, water: 0x3a6f94, edge: 0x3d4d3a },
        { x: 283, y: -215, water: 0x3d7090, edge: 0x2f4d68 },
        { x: -283, y: 225, water: 0x387d8c, edge: 0x2d5648 },
        { x: 283, y: 225, water: 0x3e7895, edge: 0x305d72 },
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
        const pcx = zc.x + sgn(zc.x) * (38 + Math.random() * 24);
        const pcy = zc.y + sgn(zc.y) * (28 + Math.random() * 22);
        const g = this.add.graphics().setDepth(dFill);
        const flowGraphics = this.add.graphics().setDepth(dFlow);
        const tracePoly = (verts) => {
          g.beginPath();
          g.moveTo(verts[0].x, verts[0].y);
          for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x, verts[i].y);
          g.closePath();
        };

        g.fillStyle(zc.water, 0.91);
        g.lineStyle(3, zc.edge, 0.95);

        let pool;

        if (shapeKind === 0) {
          const rx = 34 + Math.random() * 10;
          const ry = 14 + Math.random() * 8;
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
          const rx = 14 + Math.random() * 8;
          const ry = 32 + Math.random() * 12;
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
          const r0 = 24 + Math.random() * 14;
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
          const w = 28 + Math.random() * 10;
          const h = 17 + Math.random() * 9;
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

    clampPosToPlaza(x, y) {
      const b = this.plazaWalkBounds;
      let px = x;
      let py = y;
      if (b) {
        px = Math.max(b.minX, Math.min(b.maxX, x));
        py = Math.max(b.minY, Math.min(b.maxY, y));
      }
      if (this.plazaPools && this.plazaPools.length) {
        const q = this.pushOutOfPlazaPools(px, py, 11);
        px = q.x;
        py = q.y;
      }
      return { x: px, y: py };
    }

    clampSpriteToPlaza(sprite) {
      const p = this.clampPosToPlaza(sprite.x, sprite.y);
      sprite.setPosition(p.x, p.y);
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
      const pc = this.clampPosToPlaza(tree.x, perchY);
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
      const c0 = this.clampPosToPlaza(gx, gy);
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
      const avoidR = this.fountainTeleportRadius + 14;
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
        const fb = this.clampPosToPlaza(110, 0);
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
        .setScale(0.5);
      return {
        sprite,
        home: { x, y },
        target: { x, y },
        retargetAt: 0,
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
      this.updatePlazaPoolFlow(now);
      const cat = this.cat;
      if (!cat || !this.lizards.length) return;
      const dt = Math.min((delta || 16) / 1000, 0.045);
      const cx0 = cat.x;
      const cy0 = cat.y;
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

      for (const m of this.mice) {
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

        if (herdSeek) {
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

        if (herdSeek) {
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
            const mf = 58 * dt;
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
      const V_LIZARD_CHASE_ROACH = 20;
      const ROACH_FLEE_LIZARD_RADIUS = 50;
      const ROACH_FLEE_ACCEL = 13;
      const ROACH_FLEE_SNAKE_RADIUS = 44;
      const ROACH_FLEE_SNAKE_ACCEL = 10;

      for (const ro of this.roaches) {
        if (now > ro.retargetAt) {
          ro.retargetAt = now + 1600 + Math.random() * 2000;
          this.pickRoachTarget(ro);
        }
        let rx = ro.sprite.x;
        let ry = ro.sprite.y;
        let rtx = ro.target.x - rx;
        let rty = ro.target.y - ry;
        let rlen = Math.hypot(rtx, rty) || 1;
        if (rlen < 3) {
          this.pickRoachTarget(ro);
          rtx = ro.target.x - rx;
          rty = ro.target.y - ry;
          rlen = Math.hypot(rtx, rty) || 1;
        }
        rx += (rtx / rlen) * V_ROACH * dt;
        ry += (rty / rlen) * V_ROACH * dt;

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
        ro.sprite.setFlipX((ro.target.x - rx) < 0);
        if (this.bounceIfNearFountain(ro.sprite, now)) {
          ro.home.x = ro.sprite.x;
          ro.home.y = ro.sprite.y;
          this.pickRoachTarget(ro);
          ro.retargetAt = now + 400;
        }
        this.clampSpriteToPlaza(ro.sprite);
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
      }

      const chaseMouseSpriteEarly = this.resolveCatMouseChase(cat);
      let skipCatGround = false;
      if (this.arboreal) {
        const a = this.arboreal;
        const treeLizSp = a.liz.sprite;
        if (a.catJoined && a.lizardFled && a.catDownAt != null && now >= a.catDownAt) {
          const cp = this.clampPosToPlaza(a.baseX - 8 + (Math.random() - 0.5) * 4, a.baseY + 4);
          this.cat.setPosition(cp.x, cp.y);
          this.cat.setDepth(15);
          const lzRef = a.liz;
          this.arboreal = null;
          this._arborealCooldownUntil = now + 900;
          this.pickLizardTarget(lzRef);
          lzRef.retargetAt = now + 700;
        } else if (!a.catJoined && !a.lizardFled && now >= a.lizardSoloDownAt) {
          const lp = this.clampPosToPlaza(a.baseX + (Math.random() - 0.5) * 6, a.baseY + 2);
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

      if (!skipCatGround) {
        const chaseLiz = this.nearestLizardEntry(cat);
        let lx = chaseLiz.sprite.x;
        let ly = chaseLiz.sprite.y;

        let chaseMx = null;
        let chaseMy = null;
        let chaseMouseSprite = chaseMouseSpriteEarly;
        let vCat = 25;
        if (chaseMouseSprite) {
          chaseMx = chaseMouseSprite.x;
          chaseMy = chaseMouseSprite.y;
          vCat = 34;
        }

        let tcx;
        let tcy;
        if (chaseMouseSprite) {
          tcx = chaseMx;
          tcy = chaseMy;
        } else {
          tcx = lx;
          tcy = ly;
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
      const ZOOM_MIN = 0.42;
      const plazaW = 80 * TILE;
      const plazaH = 54 * TILE;
      const hw = plazaW / 2;
      const hh = plazaH / 2;

      const gw = Math.max(1, this.scale.gameSize.width);
      const gh = Math.max(1, this.scale.gameSize.height);
      const spanHalf =
        Math.max(
          110 * TILE,
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
      // 喷泉：石缘 + 多层水色
      makeTexture(this, "fountain", 40, 40, (g) => {
        g.fillStyle(0x5c5249, 1).fillRect(0, 0, 40, 40);
        g.fillStyle(0x6b5e54, 1).fillRect(2, 2, 36, 36);
        g.lineStyle(2, 0x3a332d, 1).strokeRect(4, 4, 32, 32);
        g.fillStyle(0x4a90c8, 0.45).fillRect(8, 8, 24, 24);
        g.fillStyle(0x5aa8d4, 0.65).fillRect(11, 11, 18, 18);
        g.fillStyle(0x8ec8f0, 0.55).fillRect(14, 14, 12, 12);
        g.fillStyle(0xe8f4fc, 0.65).fillRect(17, 10, 4, 4);
        g.fillStyle(0xffffff, 0.45).fillRect(13, 16, 3, 3);
        g.fillStyle(0xffffff, 0.35).fillRect(22, 18, 2, 2);
        g.fillStyle(0xffffff, 0.28).fillRect(19, 22, 2, 2);
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
      const ztw = Math.round(400 * Math.SQRT2);
      const zth = Math.round(240 * Math.SQRT2);
      zoneTint(-283, -215, ztw, zth, 0x6b8cae, 0.11); // STRIP · 偏冷
      zoneTint(283, -215, ztw, zth, 0xc1666b, 0.1); // AVATAR · 陶土
      zoneTint(-283, 225, ztw, zth, 0x4a8f5c, 0.09); // ARENA · 绿
      zoneTint(283, 225, ztw, zth, 0xd4963c, 0.11); // FORUM（自由发帖）· 金

      /* —— 十字主路 + 喷泉环岛感 —— */
      const roadAsp = 0x2c2622;
      const roadInner = 0x362f29;
      const roadWMain = plazaW - 64;
      const roadHBand = 76;
      const roadVBand = 56;
      this.add.rectangle(0, 0, roadWMain, roadHBand, roadAsp, 0.94).setDepth(2);
      this.add.rectangle(0, 0, roadVBand, plazaH - 120, roadAsp, 0.94).setDepth(2);
      this.add.rectangle(0, 0, roadWMain - 10, roadHBand - 14, roadInner, 0.55).setDepth(2);
      this.add.rectangle(0, 0, roadVBand - 12, plazaH - 150, roadInner, 0.5).setDepth(2);

      // 路口加深
      this.add.rectangle(0, 0, roadVBand + 8, roadHBand + 8, 0x1e1a18, 0.35).setDepth(2);

      // 中央铺装圆（环喷泉）
      const plazaPad = this.add.graphics({ x: 0, y: 0 });
      plazaPad.fillStyle(0x6b5e54, 0.92);
      plazaPad.fillCircle(0, 0, 72);
      plazaPad.lineStyle(3, 0x231c18, 0.45);
      plazaPad.strokeCircle(0, 0, 72);
      plazaPad.setDepth(3);

      // 碎石小径（通向四区）
      const pathRay = (ang, len) => {
        const rad = (ang * Math.PI) / 180;
        const cx = Math.cos(rad) * (len / 2);
        const cy = Math.sin(rad) * (len / 2);
        for (let t = -len / 2; t < len / 2; t += TILE) {
          const px = Math.cos(rad) * t;
          const py = Math.sin(rad) * t;
          if (Math.hypot(px, py) < 52) continue;
          this.add.image(px, py, "tilePath").setOrigin(0.5).setDepth(3).setRotation(rad);
        }
      };
      pathRay(-90, Math.min(hh - 100, 268));
      pathRay(90, Math.min(hh - 100, 268));
      pathRay(0, Math.min(hw - 72, 380));
      pathRay(180, Math.min(hw - 72, 380));

      // 车道虚线（东西向）
      for (let x = -roadWMain / 2 + 20; x < roadWMain / 2 - 20; x += 36) {
        if (Math.abs(x) < 34) continue;
        this.add.rectangle(x, 0, 14, 3, 0xd4b896, 0.82).setDepth(3);
      }
      // 南北向短虚线
      for (let y = -plazaH / 2 + 80; y < plazaH / 2 - 80; y += 40) {
        if (Math.abs(y) < 40) continue;
        this.add.rectangle(0, y, 3, 12, 0xd4b896, 0.75).setDepth(3);
      }

      // 斑马线（四个方向靠圆心）
      const zebra = (ox, oy, horizontal) => {
        for (let i = -4; i <= 4; i++) {
          if (horizontal) this.add.rectangle(ox + i * 8, oy, 4, 18, 0xefe6dc, 0.88).setDepth(3);
          else this.add.rectangle(ox, oy + i * 8, 18, 4, 0xefe6dc, 0.88).setDepth(3);
        }
      };
      zebra(-52, 0, true);
      zebra(52, 0, true);
      zebra(0, -52, false);
      zebra(0, 52, false);

      // 井盖
      const manhole = (x, y) => {
        const m = this.add.circle(x, y, 7, 0x1e1a18, 0.65).setDepth(3);
        this.add.circle(x, y, 5, 0x2e2824, 0.85).setDepth(3);
        return m;
      };
      manhole(-210, 22);
      manhole(215, -18);
      manhole(-120, -30);
      manhole(95, 38);

      this.createPlazaZonePools();

      this.add.image(0, 0, "fountain").setOrigin(0.5).setDepth(5);

      // 喷泉周水花（轻微动画）
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        const r = 38 + (i % 2) * 4;
        const splash = this.add
          .rectangle(Math.cos(ang) * r, Math.sin(ang) * r, 4, 3, 0xffffff, 0.35)
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
        [-hw + 40, -120, "treePine", 1],
        [-hw + 28, -40, "treeOak", 1.05],
        [-hw + 52, 40, "tree", 0.95],
        [-hw + 34, 118, "treeAutumn", 1],
        [hw - 42, -128, "treeOak", 1],
        [hw - 30, -48, "treePine", 1.08],
        [hw - 48, 52, "tree", 1],
        [hw - 36, 122, "treeAutumn", 0.98],
        [-280, -hh + 50, "treePine", 1.1],
        [12, -hh + 44, "treeOak", 1],
        [-24, -hh + 36, "tree", 0.95],
        [260, -hh + 48, "treePine", 1.05],
        [-268, hh - 52, "tree", 1],
        [8, hh - 46, "treeAutumn", 1.02],
        [248, hh - 50, "treeOak", 1],
      ];
      for (const [x, y, k, s] of borderTrees) placeTree(x, y, k, s, (x + y) % 2 === 0);

      // 集群小树丛
      const clusters = [
        [-320, -220, 1],
        [300, -210, -1],
        [-310, 210, 1],
        [295, 218, -1],
        [-130, -250, 1],
        [125, -245, -1],
        [-135, 252, 1],
        [118, 248, -1],
      ];
      for (const [cx, cy, dir] of clusters) {
        placeTree(cx, cy, treeKeys[Math.abs(cx + cy) % 4], 0.92, dir < 0);
        placeTree(cx + 18 * dir, cy + 10, "treePine", 0.85, dir > 0);
        this.add
          .image(cx - 14 * dir, cy - 8, "bush")
          .setOrigin(0.5)
          .setScale(1.15)
          .setDepth(depthScenery);
      }

      // 灌木与石块点缀（避开环岛）
      const scatter = [
        [-85, -95, "bush"],
        [92, -102, "bush"],
        [-78, 88, "bush"],
        [96, 92, "bush"],
        [-40, -132, "rock"],
        [48, 128, "rock"],
        [188, -88, "rock"],
        [-195, 72, "rock"],
        [0, -118, "flowerbed"],
        [-118, 0, "flowerbed"],
        [120, 6, "flowerbed"],
        [4, 118, "flowerbed"],
      ];
      for (const [x, y, key] of scatter) {
        const im = this.add.image(x, y, key).setOrigin(0.5).setDepth(depthScenery);
        if (key === "bush") im.setScale(1.05 + (Math.abs(x + y) % 5) * 0.03);
      }

      // 绿篱围角（四区内侧）
      const hedgeY = [-138, 138];
      const hedgeX = [-175, 175];
      for (const hy of hedgeY) {
        this.add.image(-285, hy, "hedge").setOrigin(0.5).setDepth(depthScenery);
        this.add.image(285, hy, "hedge").setOrigin(0.5).setDepth(depthScenery).setFlipX(true);
      }
      for (const hx of hedgeX) {
        const h = this.add.image(hx, -218, "hedge").setOrigin(0.5).setDepth(depthScenery);
        h.setAngle(90);
        const h2 = this.add.image(hx, 218, "hedge").setOrigin(0.5).setDepth(depthScenery);
        h2.setAngle(90);
      }

      // 长椅（沿路与广场边）
      const benches = [
        [-95, 62, 0, false],
        [88, -58, 0, true],
        [-210, 12, Math.PI / 2, false],
        [205, -8, Math.PI / 2, true],
        [-48, -195, 0, false],
        [40, 188, 0, true],
        [155, 95, Math.PI / 2, false],
        [-160, -105, Math.PI / 2, true],
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
      const lampRowY = [-38, 38];
      for (const ly of lampRowY) {
        for (let lx = -hw + 100; lx < hw - 60; lx += 130) {
          if (Math.abs(lx) < 70) continue;
          this.addLampWithGlow(lx, ly, depthScenery + 0.5, lampPhase);
          lampPhase += 110;
        }
      }
      for (let ly = -hh + 90; ly < hh - 70; ly += 140) {
        if (Math.abs(ly) < 55) continue;
        this.addLampWithGlow(-48, ly, depthScenery + 0.5, lampPhase);
        lampPhase += 80;
        this.addLampWithGlow(48, ly, depthScenery + 0.5, lampPhase);
        lampPhase += 80;
      }
      // 内环四盏
      this.addLampWithGlow(-62, -62, depthScenery + 0.5, 40);
      this.addLampWithGlow(62, -62, depthScenery + 0.5, 200);
      this.addLampWithGlow(-62, 62, depthScenery + 0.5, 320);
      this.addLampWithGlow(62, 62, depthScenery + 0.5, 480);

      // 指示牌
      const signs = [
        [-298, -22, "PIXEL"],
        [288, -22, "AVATAR"],
        [-298, 22, "ARENA"],
        [288, 22, "FORUM"],
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

      this.cat = this.add.image(-118, 88, "cat").setOrigin(0.5).setDepth(15).setScale(1.18);
      const lizardSpawns = [
        [-72, 82],
        [-58, 94],
        [-90, 72],
        [-48, 68],
        [-82, 100],
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

      /* 首次远离猫（约 -118,88），生在东西向干道东侧 */
      const mouseSpawns = [
        [168, 82],
        [198, 96],
        [142, 108],
        [218, 74],
        [182, 70],
        [230, 90],
        [155, 118],
        [205, 65],
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
        const rad = 95 + (ri % 4) * 34;
        const rx = Math.cos(ang) * rad + ((ri * 17) % 40);
        const ry = Math.sin(ang) * rad + ((ri * 11) % 36);
        const rc = this.clampPosToPlaza(rx, ry);
        const ro = this.createRoachAt(rc.x, rc.y);
        ro.retargetAt = this.time.now + ri * 90;
        this.pickRoachTarget(ro);
        this.roaches.push(ro);
      }
      this.roachBreedLock = this.time.now + 800;

      this.snakes = [];
      const snakeSpawns = [
        { x: -38, y: -118, tint: 0xffd54f },
        { x: 52, y: 132, tint: 0xa1887f },
        { x: 175, y: -42, tint: 0x66bb6a },
      ];
      snakeSpawns.forEach((cfg, si) => {
        const c = this.clampPosToPlaza(cfg.x, cfg.y);
        const snk = this.createSnakeAt(c.x, c.y, cfg.tint);
        snk.retargetAt = this.time.now + 320 + si * 300;
        this.pickSnakeTarget(snk);
        this.snakes.push(snk);
      });

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
      mkLabel(-312, -292, "STRIP ST", "#b8d4e8");
      mkLabel(300, -292, "AVATAR ST", "#f0b8bc");
      mkLabel(-312, 302, "ARENA ST", "#b8e0c4");
      mkLabel(300, 302, "FORUM ST", "#ffe3a8");

      this.input.on("wheel", (_pointer, _go, _dx, dy) => {
        const c = this.cameras.main;
        const step = dy > 0 ? -0.12 : 0.12;
        const raw = clamp(c.zoom + step, ZOOM_MIN, 4.2);
        c.setZoom(Math.round(raw * 40) / 40);
      });

      this.input.on("pointermove", (p) => {
        if (!p.isDown) return;
        const c = this.cameras.main;
        c.scrollX -= (p.position.x - p.prevPosition.x) / c.zoom;
        c.scrollY -= (p.position.y - p.prevPosition.y) / c.zoom;
      });

      this.refreshBooths(state.posts, state.matches, state.stallZoneFilter);
    }

    refreshBooths(posts, matches, zoneFilter) {
      for (const b of this.booths) b.destroy();
      this.booths = [];
      this.boothNpcs = [];

      const postItems = posts || [];
      const matchItems = matches || [];
      const zf = zoneFilter || "all";

      const zones = {
        strip: { x0: -498, y0: -302, cols: 4, dx: 94, dy: 66 },
        avatar: { x0: 120, y0: -302, cols: 4, dx: 94, dy: 66 },
        match: { x0: -498, y0: 186, cols: 4, dx: 94, dy: 66 },
        forum: { x0: 120, y0: 186, cols: 4, dx: 94, dy: 66 },
      };
      const idx = { strip: 0, avatar: 0, match: 0, forum: 0 };
      const stallTex = {
        strip: "stallStrip",
        avatar: "stallAvatar",
        forum: "stallForum",
        match: "stallArena",
      };

      const placeBooth = (z, x, y, label, tweenSeed, onOpen) => {
        const tex = stallTex[z] || stallTex.strip;
        const stall = this.add.image(x, y, tex).setOrigin(0.5).setDepth(7).setInteractive({ useHandCursor: true });
        const hover = z === "match" ? 0xa8e8ff : 0xffd485;
        stall.on("pointerdown", onOpen);
        stall.on("pointerover", () => stall.setTint(hover));
        stall.on("pointerout", () => stall.clearTint());

        let npc;
        const npcY = y + 10;
        if (z === "match") {
          npc = this.add.image(x - 16, npcY, "goStones").setOrigin(0.5).setDepth(8);
        } else {
          npc = this.add.image(x - 18, npcY, "shrimp").setOrigin(0.5).setDepth(8);
          if (z === "avatar") npc.setTint(0xffb8c6);
          else if (z === "forum") npc.setTint(0xffe8a0);
        }
        this.tweens.add({
          targets: npc,
          y: npcY - 2,
          duration: 700 + (tweenSeed % 5) * 60,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
        this.boothNpcs.push(npc);

        const bubble = this.add
          .text(x, y - 30, label, {
            fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
            fontSize: "12px",
            color: "#fef9f3",
            backgroundColor: "rgba(35,28,24,0.75)",
            padding: { x: 8, y: 5 },
          })
          .setOrigin(0.5, 1)
          .setDepth(9);
        bubble.setInteractive({ useHandCursor: true });
        bubble.on("pointerdown", onOpen);
        this.booths.push(stall, npc, bubble);
      };

      for (const p of postItems) {
        const z = boothZoneForPost(p);
        if (zf !== "all" && zf !== z) continue;
        const zc = zones[z] || zones.strip;
        const i = idx[z]++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8;
        const y = zc.y0 + row * zc.dy;

        const rawTitle = p.title || "（无标题）";
        const title = rawTitle.length > 8 ? `${rawTitle.slice(0, 8)}…` : rawTitle;
        placeBooth(z, x, y, title, i, () => openDrawer(p));
      }

      for (const m of matchItems) {
        const z = "match";
        if (zf !== "all" && zf !== "match") continue;
        const zc = zones.match;
        const i = idx.match++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8;
        const y = zc.y0 + row * zc.dy;

        const line = `${matchRuleLabel(m.rule)}·${matchStatusZh(m.status)}`;
        const label = line.length > 11 ? `${line.slice(0, 11)}…` : line;
        placeBooth(z, x, y, label, i + 17, () => {
          openMatchDrawer(m);
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
      roundPixels: true,
    },
  };

  // eslint-disable-next-line no-undef
  const game = new Phaser.Game(config);
  
  // 绑定缩放控制到 worldState
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN_BTN = 0.4;
  const ZOOM_MAX_BTN = 3.0;
  
  state.setZoom = (zoom) => {
    if (sceneRef && sceneRef.cameras && sceneRef.cameras.main) {
      sceneRef.cameras.main.setZoom(zoom);
      return true;
    }
    return false;
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
    const newZoom = Math.min(ZOOM_MAX_BTN, cam.zoom + ZOOM_STEP);
    cam.setZoom(Math.round(newZoom * 40) / 40);
    return true;
  };
  
  state.zoomOut = () => {
    const cam = sceneRef?.cameras?.main;
    if (!cam) return false;
    const newZoom = Math.max(ZOOM_MIN_BTN, cam.zoom - ZOOM_STEP);
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
    setDrawerMode("post");
    document.getElementById("drawer").classList.add("hidden");
  };
  document.getElementById("drawerCopyMatchId").onclick = async () => {
    const id = selectedMatch?.id;
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

  function updateZoomLevel() {
    if (worldState && worldState.getZoom && zoomLevelDisplay) {
      const zoom = worldState.getZoom();
      zoomLevelDisplay.textContent = Math.round(zoom * 100) + "%";
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
  setInterval(updateZoomLevel, 2000);

  await refresh();
});
