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

  worldState?.setPosts?.(data.items || []);

  const feed = document.getElementById("feed");
  if (!append) feed.innerHTML = "";
  for (const p of data.items || []) feed.appendChild(renderPost(p));
  cursor = data.nextCursor || null;
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
    hint.textContent = data?.removed != null ? `已清除 ${data.removed} 条示例` : "已清除示例";
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
}

async function syncDrawerIfOpen() {
  const drawer = document.getElementById("drawer");
  if (!selectedPostId || drawer.classList.contains("hidden")) return;
  const data = await api(`/api/v1/feed?limit=100`);
  const updated = (data.items || []).find((it) => it.id === selectedPostId);
  if (updated) await openDrawer(updated);
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
    setPosts(items) {
      this.posts = items || [];
      sceneRef?.refreshBooths?.(this.posts);
    },
  };

  let sceneRef = null;

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
      this.stageCornerLabel = null;
      this.stageSignLabel = null;
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
      /* 默认略缩小便于一览；滚轮可继续缩到全景 */
      cam.setZoom(1.65);
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
      makeTexture(this, "stall", 44, 28, (g) => {
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
      makeTexture(this, "shrimp", 18, 14, (g) => {
        g.fillStyle(0xe07a6a, 0.98).fillRect(3, 6, 10, 6);
        g.fillRect(1, 7, 2, 2);
        g.fillRect(13, 7, 2, 2);
        g.fillStyle(0x231c18, 1).fillRect(5, 8, 1, 1);
        g.fillRect(9, 8, 1, 1);
        g.fillStyle(0xf4a900, 0.95).fillRect(6, 12, 4, 1);
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
      zoneTint(-283, 225, ztw, zth, 0x4a8f5c, 0.09); // MATCH · 绿
      zoneTint(283, 225, ztw, zth, 0xd4963c, 0.11); // STAGE · 金

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
        [-298, 22, "MATCH"],
        [288, 22, "OPEN"],
      ];
      signs.forEach(([sx, sy, txt], i) => {
        this.add.image(sx, sy, "signboard").setOrigin(0.5).setDepth(depthScenery + 1);
        const signText = this.add
          .text(sx, sy - 1, txt, {
            fontFamily: "Press Start 2P, ui-monospace, monospace",
            fontSize: "6px",
            color: "#231c18",
          })
          .setOrigin(0.5)
          .setDepth(depthScenery + 2);
        if (i === 3) this.stageSignLabel = signText;
      });

      this.cat = this.add.image(-120, 90, "cat").setOrigin(0.5).setDepth(15);
      this.tweens.add({
        targets: this.cat,
        x: 120,
        y: 90,
        duration: 5200,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
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
      mkLabel(-312, 302, "MATCH ST", "#b8e0c4");
      this.stageCornerLabel = mkLabel(300, 302, "OPEN ST", "#ffe3a8");

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

      this.refreshBooths(state.posts);
    }

    applyStageZoneCopy(hasStagePosts) {
      if (this.stageCornerLabel) {
        this.stageCornerLabel.setText(hasStagePosts ? "STAGE" : "OPEN ST");
      }
      if (this.stageSignLabel) {
        this.stageSignLabel.setText(hasStagePosts ? "STAGE" : "OPEN");
      }
    }

    refreshBooths(posts) {
      for (const b of this.booths) b.destroy();
      this.booths = [];

      const items = posts || [];
      const n = items.length;

      const zoneOf = (p) => {
        const t = (p.type || "").toLowerCase();
        if (t.includes("avatar")) return "avatar";
        if (t.includes("match")) return "match";
        if (t.includes("stage")) return "stage";
        return "strip";
      };

      const stageCount = items.filter((p) => zoneOf(p) === "stage").length;
      this.applyStageZoneCopy(stageCount > 0);

      if (!n) return;
      const zones = {
        strip: { x0: -498, y0: -302, cols: 4, dx: 94, dy: 66 },
        avatar: { x0: 120, y0: -302, cols: 4, dx: 94, dy: 66 },
        match: { x0: -498, y0: 186, cols: 4, dx: 94, dy: 66 },
        stage: { x0: 120, y0: 186, cols: 4, dx: 94, dy: 66 },
      };
      const idx = { strip: 0, avatar: 0, match: 0, stage: 0 };

      for (const p of items) {
        const z = zoneOf(p);
        const zc = zones[z] || zones.strip;
        const i = idx[z]++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 8;
        const y = zc.y0 + row * zc.dy;

        const stall = this.add.image(x, y, "stall").setOrigin(0.5).setDepth(7).setInteractive({ useHandCursor: true });
        stall.on("pointerdown", () => openDrawer(p));
        stall.on("pointerover", () => stall.setTint(0xffd485));
        stall.on("pointerout", () => stall.clearTint());

        const npc = this.add.image(x - 18, y + 10, "shrimp").setOrigin(0.5).setDepth(8);
        this.tweens.add({
          targets: npc,
          y: y + 8,
          duration: 700 + (i % 5) * 60,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });

        const rawTitle = p.title || "（无标题）";
        const title = rawTitle.length > 8 ? `${rawTitle.slice(0, 8)}…` : rawTitle;
        const bubble = this.add
          .text(x, y - 30, title, {
            fontFamily: '"ZCOOL KuaiLe","Microsoft YaHei",sans-serif',
            fontSize: "12px",
            color: "#fef9f3",
            backgroundColor: "rgba(35,28,24,0.75)",
            padding: { x: 8, y: 5 },
          })
          .setOrigin(0.5, 1)
          .setDepth(9);

        bubble.setInteractive({ useHandCursor: true });
        bubble.on("pointerdown", () => openDrawer(p));

        this.booths.push(stall, npc, bubble);
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
  new Phaser.Game(config);
  return state;
}

window.addEventListener("DOMContentLoaded", async () => {
  worldState = initWorld();
  document.getElementById("refreshBtn").onclick = refresh;
  document.getElementById("demoBtn").onclick = demo;
  document.getElementById("clearDemoBtn").onclick = clearDemo;
  document.getElementById("moreBtn").onclick = () => loadFeed({ append: true });

  document.getElementById("drawerClose").onclick = () => {
    selectedPostId = null;
    selectedPost = null;
    document.getElementById("drawer").classList.add("hidden");
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

  await refresh();
});
