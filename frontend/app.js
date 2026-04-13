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

async function demo() {
  const hint = document.getElementById("demoHint");
  try {
    await api("/api/v1/demo", { method: "POST", body: "{}" });
    hint.textContent = "已生成示例";
    await refresh();
  } catch (e) {
    hint.textContent = `生成示例失败：${e.message}`;
  }
}

async function clearDemo() {
  const hint = document.getElementById("demoHint");
  try {
    const data = await api("/api/v1/demo/clear", { method: "POST", body: "{}" });
    const rp = data?.removed ?? 0;
    const rm = data?.removedMatches ?? 0;
    hint.textContent =
      rp > 0 || rm > 0 ? `已清除示例帖 ${rp} 条、示例对局 ${rm} 场` : "没有可清除的示例";
    await refresh();
  } catch (e) {
    hint.textContent = `清除示例失败：${e.message}`;
  }
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

  class PlazaScene extends Phaser.Scene {
    constructor() {
      super("plaza");
      this.booths = [];
      this.cat = null;
      this.lizard = null;
      this.lizardTarget = { x: 0, y: 0 };
      this.lizardHome = { x: -28, y: 92 };
      this.lizardRetargetAt = 0;
      this.mice = [];
      this.catChaseMouse = null;
      this.mouseBreedLock = 0;
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

    pickLizardTarget() {
      const { x: hx, y: hy } = this.lizardHome;
      const ang = Math.random() * Math.PI * 2;
      const r = 36 + Math.random() * 62;
      this.lizardTarget.x = hx + Math.cos(ang) * r;
      this.lizardTarget.y = hy + Math.sin(ang) * r;
    }

    pickMouseTarget(mouse) {
      const { x: hx, y: hy } = mouse.home;
      const ang = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 48;
      mouse.target.x = hx + Math.cos(ang) * r;
      mouse.target.y = hy + Math.sin(ang) * r;
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
      };
    }

    aimCatAt(cat, tx, ty) {
      const dx = tx - cat.x;
      const dy = ty - cat.y;
      if (Math.hypot(dx, dy) < 0.01) return;
      cat.setRotation(0);
      if (Math.abs(dx) > 0.5) cat.setFlipX(dx > 0);
    }

    update(_t, delta) {
      const cat = this.cat;
      const liz = this.lizard;
      if (!cat || !liz) return;
      const dt = Math.min((delta || 16) / 1000, 0.045);
      const now = this.time.now;
      const cx0 = cat.x;
      const cy0 = cat.y;
      const MOUSE_AGRO = 52;
      const MOUSE_CATCH = 13;
      const MOUSE_BREED_DIST = 22;
      const MAX_MICE = 6;

      for (const m of this.mice) {
        if (now > m.retargetAt) {
          m.retargetAt = now + 1100 + Math.random() * 1100;
          this.pickMouseTarget(m);
        }
        let mx = m.sprite.x;
        let my = m.sprite.y;
        let mtx = m.target.x - mx;
        let mty = m.target.y - my;
        let mlen = Math.hypot(mtx, mty) || 1;
        if (mlen < 5) {
          this.pickMouseTarget(m);
          mtx = m.target.x - mx;
          mty = m.target.y - my;
          mlen = Math.hypot(mtx, mty) || 1;
        }
        const vMouse = 21;
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
        m.sprite.setPosition(mx, my);
        m.sprite.setFlipX((m.target.x - mx) < 0);
      }

      if (now > this.mouseBreedLock && this.mice.length < MAX_MICE) {
        outer: for (let i = 0; i < this.mice.length; i++) {
          for (let j = i + 1; j < this.mice.length; j++) {
            const a = this.mice[i].sprite;
            const b = this.mice[j].sprite;
            if (Math.hypot(a.x - b.x, a.y - b.y) < MOUSE_BREED_DIST) {
              const nx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 14;
              const ny = (a.y + b.y) / 2 + (Math.random() - 0.5) * 14;
              const nm = this.createMouseAt(nx, ny);
              nm.retargetAt = now + 500;
              this.pickMouseTarget(nm);
              this.mice.push(nm);
              this.mouseBreedLock = now + 2600;
              break outer;
            }
          }
        }
      }

      if (now > this.lizardRetargetAt) {
        this.lizardRetargetAt = now + 1600 + Math.random() * 1400;
        this.pickLizardTarget();
      }

      let lx = liz.x;
      let ly = liz.y;

      let tx = this.lizardTarget.x - lx;
      let ty = this.lizardTarget.y - ly;
      let len = Math.hypot(tx, ty) || 1;
      if (len < 6) {
        this.pickLizardTarget();
        tx = this.lizardTarget.x - lx;
        ty = this.lizardTarget.y - ly;
        len = Math.hypot(tx, ty) || 1;
      }
      const vL = 34;
      lx += (tx / len) * vL * dt;
      ly += (ty / len) * vL * dt;

      let dx = lx - cx0;
      let dy = ly - cy0;
      let dist = Math.hypot(dx, dy) || 1;
      if (dist < 40) {
        const flee = 78 * dt;
        lx += (dx / dist) * flee;
        ly += (dy / dist) * flee;
        dist = Math.hypot(lx - cx0, ly - cy0) || 1;
        dx = lx - cx0;
        dy = ly - cy0;
      }

      liz.setPosition(lx, ly);
      liz.setFlipX((this.lizardTarget.x - lx) < 0);

      let chaseMx = null;
      let chaseMy = null;
      let chaseMouseSprite = null;
      let vCat = 25;

      if (this.catChaseMouse) {
        const alive = this.mice.find((mm) => mm.sprite === this.catChaseMouse);
        if (alive) {
          chaseMouseSprite = alive.sprite;
          chaseMx = alive.sprite.x;
          chaseMy = alive.sprite.y;
          vCat = 34;
        } else {
          this.catChaseMouse = null;
        }
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
          chaseMx = nearest.sprite.x;
          chaseMy = nearest.sprite.y;
          vCat = 34;
        }
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

      this.aimCatAt(cat, tcx, tcy);

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
      this.lizard = this.add.image(-72, 82, "lizard").setOrigin(0.5).setDepth(16);
      this.pickLizardTarget();
      this.lizardRetargetAt = this.time.now + 1800;

      /* 首次远离猫（约 -118,88），生在东西向干道东侧 */
      const mouseSpawns = [
        [168, 82],
        [198, 96],
        [142, 108],
        [218, 74],
      ];
      for (const [mx, my] of mouseSpawns) {
        const mm = this.createMouseAt(mx, my);
        mm.retargetAt = this.time.now + Math.random() * 700;
        this.pickMouseTarget(mm);
        this.mice.push(mm);
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
  document.getElementById("demoBtn").onclick = demo;
  document.getElementById("clearDemoBtn").onclick = clearDemo;
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
