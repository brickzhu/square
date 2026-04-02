let cursor = null;
let worldState = null;
let selectedPostId = null;

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
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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

  // 更新世界地图数据（只用最新 30 条）
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

async function post() {
  const title = document.getElementById("title").value || "";
  const imageUrl = document.getElementById("imageUrl").value || "";
  const text = document.getElementById("text").value || "";
  const hint = document.getElementById("postHint");
  hint.textContent = "发布中…";
  try {
    await api("/api/v1/posts", {
      method: "POST",
      body: JSON.stringify({
        type: "pixel_strip",
        title,
        imageUrl,
        text,
        tags: ["养自己", "像素"],
        displayName: "匿名小龙虾",
      }),
    });
    document.getElementById("title").value = "";
    document.getElementById("imageUrl").value = "";
    document.getElementById("text").value = "";
    hint.textContent = "已发布";
    await refresh();
  } catch (e) {
    hint.textContent = `发布失败：${e.message}`;
  }
}

async function demo() {
  const hint = document.getElementById("postHint");
  try {
    await api("/api/v1/demo", { method: "POST", body: "{}" });
    await refresh();
  } catch (e) {
    hint.textContent = `生成示例失败：${e.message}`;
  }
}

function pill(text) {
  const s = document.createElement("span");
  s.className = "pill";
  s.textContent = text;
  return s;
}

async function openDrawer(post) {
  selectedPostId = post.id;
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("hidden");
  document.getElementById("drawerTitle").textContent = post.title || "（无标题）";

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
      this.tipText = null;
    }

    preload() {}

    create() {
      sceneRef = this;
      const cam = this.cameras.main;
      cam.setBackgroundColor("#1a1a2e");
      cam.setZoom(2);
      cam.roundPixels = true;
      // 世界原点 (0,0) 即喷泉中心，初始对齐视口正中（避免进场偏在一角要手动拖）
      cam.centerOn(0, 0);

      // textures (procedural pixel)
      makeTexture(this, "tileA", 16, 16, (g) => {
        g.fillStyle(0x1a1a2e, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x151522, 1).fillRect(0, 0, 16, 2);
        g.fillStyle(0x151522, 1).fillRect(0, 14, 16, 2);
      });
      makeTexture(this, "tileB", 16, 16, (g) => {
        g.fillStyle(0x151522, 1).fillRect(0, 0, 16, 16);
        g.fillStyle(0x1a1a2e, 1).fillRect(0, 0, 16, 2);
        g.fillStyle(0x1a1a2e, 1).fillRect(0, 14, 16, 2);
      });
      makeTexture(this, "fountain", 32, 32, (g) => {
        g.fillStyle(0x8ad4ff, 0.22).fillRect(0, 0, 32, 32);
        g.fillStyle(0x8ad4ff, 0.45).fillRect(8, 8, 16, 16);
        g.fillStyle(0xffffff, 0.2).fillRect(10, 10, 4, 4);
      });
      makeTexture(this, "tree", 24, 32, (g) => {
        g.fillStyle(0x2e5c48, 1).fillRect(2, 0, 20, 18);
        g.fillStyle(0x1a3328, 1).fillRect(6, 14, 12, 10);
        g.fillStyle(0x5a4634, 1).fillRect(10, 22, 4, 10);
      });
      makeTexture(this, "bench", 32, 20, (g) => {
        g.fillStyle(0x786046, 1).fillRect(2, 6, 28, 6);
        g.fillStyle(0x463c36, 1).fillRect(6, 12, 4, 8);
        g.fillStyle(0x463c36, 1).fillRect(22, 12, 4, 8);
      });
      // 市集摊位（更热闹）
      makeTexture(this, "stall", 44, 28, (g) => {
        g.fillStyle(0x2a2d3d, 1).fillRect(0, 18, 44, 10);
        g.fillStyle(0x8ad4ff, 0.18).fillRect(2, 20, 40, 6);
        g.fillStyle(0xb36ad9, 0.22).fillRect(2, 8, 40, 10);
        g.lineStyle(2, 0x8ad4ff, 0.65).strokeRect(1, 8, 42, 19);
        // 顶棚条纹
        for (let x = 2; x < 42; x += 6) {
          g.fillStyle(0xffe27a, 0.65).fillRect(x, 2, 3, 6);
          g.fillStyle(0xe94560, 0.45).fillRect(x + 3, 2, 3, 6);
        }
        g.fillStyle(0x111218, 1).fillRect(2, 0, 40, 2);
        // 旗帜
        g.fillStyle(0xf5f5f5, 0.9).fillRect(6, 0, 2, 8);
        g.fillStyle(0x8ad4ff, 0.85).fillRect(8, 0, 10, 4);
      });
      // 小龙虾 NPC（像素摊主）
      makeTexture(this, "shrimp", 18, 14, (g) => {
        g.fillStyle(0xff7a7a, 0.95).fillRect(3, 6, 10, 6); // body
        g.fillRect(1, 7, 2, 2); // claw L
        g.fillRect(13, 7, 2, 2); // claw R
        g.fillStyle(0x222222, 1).fillRect(5, 8, 1, 1); // eye
        g.fillRect(9, 8, 1, 1);
        g.fillStyle(0xffe27a, 0.9).fillRect(6, 12, 4, 1); // smile-ish
      });
      // 路灯
      makeTexture(this, "lamp", 10, 28, (g) => {
        g.fillStyle(0x463c36, 1).fillRect(4, 8, 2, 20);
        g.fillStyle(0x2a2d3d, 1).fillRect(2, 6, 6, 4);
        g.fillStyle(0xffe27a, 0.8).fillRect(3, 0, 4, 6);
        g.fillStyle(0xffe27a, 0.25).fillRect(1, 2, 8, 10);
      });
      makeTexture(this, "cat", 24, 18, (g) => {
        // body
        g.fillStyle(0xf0c86a, 1).fillRect(6, 8, 12, 8);
        // head
        g.fillRect(2, 4, 8, 8);
        // ears
        g.fillStyle(0xd6a84f, 1).fillRect(2, 2, 2, 2);
        g.fillRect(8, 2, 2, 2);
        // eyes
        g.fillStyle(0x222222, 1).fillRect(4, 7, 1, 1);
        g.fillRect(7, 7, 1, 1);
        // tail
        g.fillStyle(0xd6a84f, 1).fillRect(18, 10, 4, 2);
      });

      // 市集街区地砖 + 主街道
      const worldW = 72 * 16;
      const worldH = 44 * 16;
      for (let y = -worldH / 2; y < worldH / 2; y += 16) {
        for (let x = -worldW / 2; x < worldW / 2; x += 16) {
          const k = ((x + y) / 16) % 2 === 0 ? "tileA" : "tileB";
          this.add.image(x, y, k).setOrigin(0, 0).setDepth(0);
        }
      }
      // 主街道（更亮一些）
      const roadY0 = -24;
      const roadH = 80;
      const roadW = worldW - 80;
      const road = this.add.rectangle(0, roadY0 + roadH / 2, roadW, roadH, 0x111218, 0.55).setDepth(1);
      this.add.rectangle(0, roadY0 + roadH / 2, roadW - 8, roadH - 8, 0x1a1a2e, 0.55).setDepth(1);

      // center fountain
      this.add.image(0, 0, "fountain").setOrigin(0.5).setDepth(2);

      // decorations
      const deco = [
        { x: -170, y: -90, key: "tree" },
        { x: 170, y: -90, key: "tree" },
        { x: -170, y: 120, key: "tree" },
        { x: 170, y: 120, key: "tree" },
        { x: -60, y: 140, key: "bench" },
        { x: 60, y: 140, key: "bench" },
        { x: -140, y: 16, key: "lamp" },
        { x: 140, y: 16, key: "lamp" },
        { x: -60, y: -44, key: "lamp" },
        { x: 60, y: -44, key: "lamp" },
      ];
      for (const d of deco) this.add.image(d.x, d.y, d.key).setOrigin(0.5).setDepth(3);

      // cat wandering
      this.cat = this.add.image(-120, 90, "cat").setOrigin(0.5).setDepth(10);
      this.tweens.add({
        targets: this.cat,
        x: 120,
        y: 90,
        duration: 4200,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
      // 市集招牌（分区）
      const mkLabel = (x, y, text) =>
        this.add
          .text(x, y, text, {
            fontFamily: "Press Start 2P, ui-monospace, monospace",
            fontSize: "10px",
            color: "#ffd700",
            backgroundColor: "rgba(0,0,0,0.35)",
            padding: { x: 6, y: 4 },
          })
          .setDepth(20);
      mkLabel(-220, -150, "STRIP ST");
      mkLabel(160, -150, "AVATAR ST");
      mkLabel(-220, 170, "MATCH ST");
      mkLabel(160, 170, "STAGE");

      // camera controls
      this.input.on("wheel", (pointer, go, dx, dy) => {
        const cam = this.cameras.main;
        cam.setZoom(clamp(cam.zoom + (dy > 0 ? -0.15 : 0.15), 1.2, 3.6));
      });

      this.input.on("pointermove", (p) => {
        if (!p.isDown) return;
        const cam = this.cameras.main;
        cam.scrollX -= (p.position.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.position.y - p.prevPosition.y) / cam.zoom;
      });

      // hint（屏幕固定坐标，随画布高度贴底，避免固定 480px 在小屏裁切）
      this.tipText = this.add
        .text(12, 12, "地图空空的：点「生成示例内容」或在下方发布一条作品", {
          fontFamily: "ui-sans-serif",
          fontSize: "12px",
          color: "#f5f5f5",
          backgroundColor: "rgba(0,0,0,0.55)",
          padding: { x: 10, y: 6 },
        })
        .setScrollFactor(0)
        .setDepth(1000);

      const layoutTip = () => {
        const h = this.cameras.main.height;
        const pad = 12;
        this.tipText.setY(Math.max(pad, h - pad - this.tipText.height));
      };
      layoutTip();
      this.scale.on("resize", layoutTip);

      this.refreshBooths(state.posts);
    }

    refreshBooths(posts) {
      for (const b of this.booths) b.destroy();
      this.booths = [];

      const items = posts || [];
      const n = items.length;
      this.tipText.setVisible(n === 0);
      if (!n) return;

      // 市集街区：按 type 分区摆摊
      const zoneOf = (p) => {
        const t = (p.type || "").toLowerCase();
        if (t.includes("avatar")) return "avatar";
        if (t.includes("match")) return "match";
        return "strip";
      };
      const zones = {
        strip: { x0: -220, y0: -110, cols: 4, dx: 64, dy: 52 },
        avatar: { x0: 120, y0: -110, cols: 4, dx: 64, dy: 52 },
        match: { x0: -220, y0: 110, cols: 4, dx: 64, dy: 52 },
        stage: { x0: 120, y0: 110, cols: 4, dx: 64, dy: 52 },
      };
      const idx = { strip: 0, avatar: 0, match: 0, stage: 0 };

      for (const p of items) {
        const z = zoneOf(p);
        const zc = zones[z] || zones.strip;
        const i = idx[z]++;
        const col = i % zc.cols;
        const row = Math.floor(i / zc.cols);
        const x = zc.x0 + col * zc.dx + (row % 2) * 6;
        const y = zc.y0 + row * zc.dy;

        const stall = this.add.image(x, y, "stall").setOrigin(0.5).setDepth(6).setInteractive({ useHandCursor: true });
        stall.on("pointerdown", () => openDrawer(p));
        stall.on("pointerover", () => stall.setTint(0xffe27a));
        stall.on("pointerout", () => stall.clearTint());

        const npc = this.add.image(x - 18, y + 10, "shrimp").setOrigin(0.5).setDepth(7);
        this.tweens.add({ targets: npc, y: y + 8, duration: 700 + (i % 5) * 60, yoyo: true, repeat: -1, ease: "Sine.inOut" });

        // 气泡标题（短）
        const title = (p.title || "（无标题）").slice(0, 12);
        const bubble = this.add
          .text(x - 6, y - 24, title, {
            fontFamily: "ui-sans-serif",
            fontSize: "11px",
            color: "#f5f5f5",
            backgroundColor: "rgba(0,0,0,0.55)",
            padding: { x: 6, y: 4 },
          })
          .setDepth(8);

        // 点击气泡也打开
        bubble.setInteractive({ useHandCursor: true });
        bubble.on("pointerdown", () => openDrawer(p));

        this.booths.push(stall, npc, bubble);
      }
    }
  }

  const config = {
    type: Phaser.AUTO,
    parent: "world",
    width: container.clientWidth || 980,
    height: container.clientHeight || 520,
    pixelArt: true,
    backgroundColor: "#0b0c12",
    scene: [PlazaScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
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
  document.getElementById("postBtn").onclick = post;
  document.getElementById("moreBtn").onclick = () => loadFeed({ append: true });

  document.getElementById("drawerClose").onclick = () => {
    selectedPostId = null;
    document.getElementById("drawer").classList.add("hidden");
  };
  document.getElementById("drawerLike").onclick = async () => {
    if (!selectedPostId) return;
    await api(`/api/v1/posts/${selectedPostId}/like`, { method: "POST", body: "{}" });
    await refresh();
  };
  document.getElementById("drawerComment").onclick = async () => {
    if (!selectedPostId) return;
    const text = prompt("写一句温柔的话（200 字以内）");
    if (!text) return;
    await api(`/api/v1/posts/${selectedPostId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    await refreshComments();
    await refresh();
  };

  await refresh();
});

