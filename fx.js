/* ═══════════════════════════════════════════════════════════════════════
   《锅从天降》 特效层  fx.js
   ───────────────────────────────────────────────────────────────────────
   零依赖。接入只需要两行：
       <link rel="stylesheet" href="fx.css">
       <script src="fx.js"></script>

   默认 auto 模式：用 MutationObserver 盯住游戏里**已有的** class 变化，
   自己决定什么时候放什么特效 —— 所以 game.js 一行都不用改。

      .npc.hit        → 命中火花（琥珀 / 亮版换成星星彩纸）
      .npc.reject     → 冷雾爆开（暗版紫雾 / 亮版小乌云 + 汗滴）
      .npc.hold       → 冰化
      .pot.crashed    → 落地黑尘 + 边缘压暗
      .pot.caught     → 接锅光环
      .pot.held / .flying → 甩锅拖尾
      #flash.umb      → 接锅冲击波
      #stage.climax   → 环阵汇聚光束
      #stage.ending   → 紫光呼吸 + 灰烬上浮
      #stage.slowmo   → 时间变慢的浮尘

   也可以手动点名（demo 页 / 单测用）：
      BFfx.burst(x, y)  BFfx.mist(x, y)  BFfx.freeze(el)
      BFfx.beam(true)   BFfx.pulse(true) BFfx.embers(true) BFfx.trail(el, true)
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.BFfx) return;

  var SPRITES = {
    star: "fx-star.png", bubble: "fx-bubble.png", cloud: "fx-cloud.png",
    snow: "fx-snow.png", diamond: "fx-diamond.png", moon: "fx-moon.png",
    drop: "fx-drop.png", burst: "fx-burst.png"
  };

  var CFG = {
    theme: null,        // null = 跟随 <html data-theme>
    base: null,         // null = 按主题自动选 assets/fx/ 或 assets-light/fx/
    enabled: true,
    auto: true,
    count: 1            // 粒子数量系数
  };

  var LIGHT_DOTS = ["255,201,60", "255,127,176", "108,199,238", "255,224,102", "191,233,216"];
  var DARK_DOTS = ["240,165,44", "139,92,246", "255,209,102", "78,168,222"];
  var LIGHT_CONF = ["255,201,60", "255,127,176", "108,199,238", "122,215,150", "255,224,102", "190,150,255"];
  var DARK_CONF = ["240,165,44", "139,92,246", "226,86,77", "78,168,222", "255,209,102"];

  var RX = Math.random;
  function pick(a) { return a[(RX() * a.length) | 0]; }
  function node(tag, cls) { var d = document.createElement(tag); if (cls) d.className = cls; return d; }
  function theme() { return CFG.theme || document.documentElement.getAttribute("data-theme") || "dark"; }
  function isLight() { return theme() === "light"; }
  function base() { return CFG.base || (isLight() ? "assets-light/fx/" : "assets/fx/"); }
  function host() { return document.getElementById("fx"); }
  function durScale() {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fx-dur"));
    return (isNaN(v) || v <= 0) ? 1 : v;
  }
  function reap(n, ms) {
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, ms * durScale() * 1.4 + 180);
  }
  function centre(el) {
    var h = host(); if (!h) return null;
    var r = el.getBoundingClientRect(), q = h.getBoundingClientRect();
    return { x: r.left + r.width / 2 - q.left, y: r.top + r.height / 2 - q.top };
  }
  function local(el) {
    var h = host(); if (!h) return null;
    var r = el.getBoundingClientRect(), q = h.getBoundingClientRect();
    return { x: r.left - q.left, y: r.top - q.top, w: r.width, h: r.height };
  }

  /* ── 基础粒子 ─────────────────────────────────────────────────────── */
  function sprite(name, size, x, y, tx, ty, d, rot, sc) {
    if (!CFG.enabled) return null;
    var img = node("img", "fxp");
    img.src = base() + (SPRITES[name] || SPRITES.star);
    img.alt = "";
    img.style.left = x + "px"; img.style.top = y + "px";
    img.style.setProperty("--sz", size + "px");
    img.style.setProperty("--tx", tx + "px"); img.style.setProperty("--ty", ty + "px");
    img.style.setProperty("--d", d + "ms");
    img.style.setProperty("--r", (rot || 0) + "deg");
    img.style.setProperty("--sc", sc == null ? 0.3 : sc);
    host().appendChild(img); reap(img, d);
    return img;
  }
  function dot(x, y, size, tx, ty, d, rgb) {
    if (!CFG.enabled) return;
    var n = node("div", "fxdot");
    n.style.left = x + "px"; n.style.top = y + "px";
    n.style.width = size + "px"; n.style.height = size + "px";
    n.style.setProperty("--tx", tx + "px"); n.style.setProperty("--ty", ty + "px");
    n.style.setProperty("--d", d + "ms");
    n.style.background = "radial-gradient(circle at 38% 34%, rgba(" + rgb + ",1), rgba(" + rgb + ",.8) 46%, rgba(" + rgb + ",0) 72%)";
    host().appendChild(n); reap(n, d);
  }
  function puff(x, y, size, tx, ty, d, scale) {
    if (!CFG.enabled) return;
    var n = node("div", "fxmist");
    n.style.left = x + "px"; n.style.top = y + "px";
    n.style.width = size + "px"; n.style.height = size + "px";
    n.style.setProperty("--tx", tx + "px"); n.style.setProperty("--ty", ty + "px");
    n.style.setProperty("--d", d + "ms");
    n.style.setProperty("--sc", scale == null ? 1.6 : scale);
    host().appendChild(n); reap(n, d);
  }
  function ring(x, y, size, d) {
    if (!CFG.enabled) return;
    var n = node("div", "fxring");
    n.style.left = x + "px"; n.style.top = y + "px";
    n.style.width = size + "px"; n.style.height = size + "px";
    n.style.marginLeft = (-size / 2) + "px"; n.style.marginTop = (-size / 2) + "px";
    n.style.setProperty("--d", d + "ms");
    host().appendChild(n); reap(n, d);
  }
  function halo(x, y, size, d) {
    if (!CFG.enabled) return;
    var n = node("div", "fxhalo");
    n.style.left = x + "px"; n.style.top = y + "px";
    n.style.width = size + "px"; n.style.height = size + "px";
    n.style.marginLeft = (-size / 2) + "px"; n.style.marginTop = (-size / 2) + "px";
    n.style.setProperty("--d", d + "ms");
    host().appendChild(n); reap(n, d);
  }
  function confetti(x, y, n) {
    if (!CFG.enabled) return;
    for (var i = 0; i < n; i++) {
      var e = node("div", "fxconf");
      var w = 4 + RX() * 6, h = 6 + RX() * 9;
      e.style.width = w + "px"; e.style.height = h + "px";
      e.style.left = (x + (RX() - 0.5) * 18) + "px"; e.style.top = (y + (RX() - 0.5) * 14) + "px";
      e.style.setProperty("--cc", pick(LIGHT_CONF));
      e.style.setProperty("--tx", ((RX() - 0.5) * 150) + "px");
      e.style.setProperty("--ty", (30 + RX() * 110) + "px");
      e.style.setProperty("--r", ((RX() - 0.5) * 900) + "deg");
      e.style.setProperty("--d", (760 + RX() * 520) + "ms");
      host().appendChild(e); reap(e, 1300);
    }
  }

  /* ── 1. 命中：琥珀火花 / 亮版星星彩纸 ─────────────────────────────── */
  function burst(x, y, o) {
    o = o || {};
    var light = isLight();
    var n = Math.round((o.count || 15) * CFG.count);
    halo(x, y, o.halo || 74, 520);
    ring(x, y, o.ring || 48, o.ringDur || 540);
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + RX() * 0.55;
      var r = 32 + RX() * 50;
      var tx = Math.cos(ang) * r, ty = Math.sin(ang) * r * 0.9;
      var sz = 11 + RX() * 13;
      if (i % 3 === 0) {
        sprite(pick(light ? ["star", "diamond", "moon"] : ["star", "burst", "moon"]),
          sz, x, y, tx, ty, 600 + RX() * 280, -200 + RX() * 400, 0.22);
      } else {
        dot(x, y, sz * 0.7, tx, ty, 540 + RX() * 300, pick(light ? LIGHT_DOTS : DARK_DOTS));
      }
    }
    if (light) confetti(x, y, 9);
  }

  /* ── 2. 被拒：弹反回旋 ───────────────────────────────────────────── */
  /* 锅被「怼回来」：不是闷在原地爆开，而是被弹飞、划出一道回旋弧线再甩回去。
     视觉 = 一串沿弧线分布的虚线拖尾 + 弧线起点的反作用力火花 + 末端一击回甩。 */
  function mist(x, y, o) {
    o = o || {};
    var light = isLight();
    var dir = o.dir || (RX() < 0.5 ? 1 : -1);   // 弹飞方向（左右随机）
    var S = o.arc || 150;                        // 弧线半径（回旋幅度）
    var N = Math.round((o.count || 16) * CFG.count);

    // 反作用力：起点一圈火花（锅被弹开的瞬间）
    for (var k = 0; k < 6; k++) {
      var a0 = -Math.PI / 2 + (k / 6) * Math.PI * 2 + RX() * 0.4;
      dot(x, y, 8 + RX() * 8, Math.cos(a0) * (26 + RX() * 18), Math.sin(a0) * (26 + RX() * 18),
          520 + RX() * 240, pick(light ? LIGHT_DOTS : DARK_DOTS));
    }

    // 回旋弧线：参数方程 x=t, y = S * (t*(t-1)) * (1 - t*0.4)  → 一条「起→甩起→回落」的抛物线，
    // 叠加一段圆弧感。沿途撒虚线拖尾（.fxtrail），末端再甩一下。
    var T0 = 0.16;   // 起始出膛点（从锅心略偏下）
    for (var i = 0; i < N; i++) {
      var t = T0 + (i / (N - 1)) * (1 - T0);
      var px = x + dir * t * (S * 0.9);
      var py = y + S * (t * (t - 1)) * (1 - t * 0.4);
      var d = 620 + RX() * 260;
      var sz = 16 - i / N * 8 + RX() * 6;
      var n = node("div", "fxtrail");
      n.style.width = sz + "px"; n.style.height = sz + "px";
      n.style.left = (px - sz / 2) + "px"; n.style.top = (py - sz / 2) + "px";
      n.style.animationDelay = (i * 26) + "ms";
      host().appendChild(n); reap(n, d + i * 26);
    }

    // 弧线顶点：一枚被甩飞的小星（回旋的「转身点」）
    var apexT = 0.62;
    var ax = x + dir * apexT * (S * 0.9);
    var ay = y + S * (apexT * (apexT - 1)) * (1 - apexT * 0.4);
    sprite(pick(light ? ["star", "diamond", "moon"] : ["star", "burst", "moon"]),
           26 + RX() * 8, ax, ay, dir * 30, -46, 820, dir * -280, 0.2);

    // 末端回甩：锅「咻」地弹回，一道短促的收束光
    var ex = x + dir * (S * 0.9), ey = y + S * (0.0);
    ring(ex, ey, 40, 520);
    for (var m = 0; m < 3; m++) {
      dot(ex, ey, 7 + RX() * 5, -dir * (30 + RX() * 40), -10 - RX() * 30, 480, "255,209,102");
    }
  }

  /* ── 3. 冷战冰化 ─────────────────────────────────────────────────── */
  function freeze(target, ms) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el || !CFG.enabled) return;
    var b = local(el);
    if (!b) return;
    var shell = node("div", "fxshell");
    shell.style.left = b.x + "px"; shell.style.top = b.y + "px";
    shell.style.width = b.w + "px"; shell.style.height = b.h + "px";
    shell.style.animationDuration = (ms || 1500) + "ms";
    host().appendChild(shell); reap(shell, ms || 1500);
    for (var i = 0; i < 7; i++) {
      var s = 12 + RX() * 13;
      var img = node("img", "fxsnow");
      img.src = base() + SPRITES.snow; img.alt = "";
      img.style.width = s + "px"; img.style.height = s + "px";
      img.style.left = (b.x + RX() * b.w - s / 2) + "px";
      img.style.top = (b.y + RX() * b.h - s / 2) + "px";
      img.style.animationDelay = (RX() * 200) + "ms";
      host().appendChild(img); reap(img, 1400);
    }
  }

  /* ── 4. 甩锅拖尾 ─────────────────────────────────────────────────── */
  var trails = [];   // [{el, lx, ly}]
  function trail(el, on) {
    if (on) {
      for (var i = 0; i < trails.length; i++) if (trails[i].el === el) return;
      trails.push({ el: el, lx: null, ly: null });
    } else {
      trails = trails.filter(function (t) { return t.el !== el; });
    }
  }
  function trailTick() {
    if (!trails.length) return;
    for (var i = 0; i < trails.length; i++) {
      var t = trails[i];
      if (!t.el.isConnected) { trails.splice(i--, 1); continue; }
      var c = centre(t.el);
      if (!c) continue;
      if (t.lx == null) { t.lx = c.x; t.ly = c.y; continue; }
      var dx = c.x - t.lx, dy = c.y - t.ly;
      if (dx * dx + dy * dy < 60) continue;
      t.lx = c.x; t.ly = c.y;
      var n = node("div", "fxtrail");
      var s = 22 + RX() * 14;
      n.style.width = s + "px"; n.style.height = s + "px";
      n.style.left = (c.x - s / 2) + "px"; n.style.top = (c.y - s / 2) + "px";
      host().appendChild(n); reap(n, 540);
      if (RX() < 0.34) {
        var wrap = node("div", "fxtrail star");     // 注意是 div —— 外层不能是 <img>（无 src）
        var s2 = 12 + RX() * 8;
        wrap.style.width = s2 + "px"; wrap.style.height = s2 + "px";
        wrap.style.left = (c.x - s2 / 2) + "px"; wrap.style.top = (c.y - s2 / 2) + "px";
        var im = document.createElement("img");
        im.src = base() + SPRITES[pick(isLight() ? ["star", "diamond"] : ["star", "burst"])];
        im.alt = "";
        wrap.appendChild(im);
        host().appendChild(wrap); reap(wrap, 560);
      }
    }
  }

  /* ── 5. 环阵汇聚光束 ─────────────────────────────────────────────── */
  var beamEl = null;
  function beam(on) {
    var h = host(); if (!h) return;
    if (!beamEl) { beamEl = node("div", "fxbeam"); h.appendChild(beamEl); }
    beamEl.classList.toggle("on", !!on && CFG.enabled);
  }

  /* ── 6. 终幕：紫光呼吸 + 灰烬上浮 ─────────────────────────────────── */
  var pulseEl = null, emberOn = false;
  function pulse(on) {
    var h = host(); if (!h) return;
    if (!pulseEl) { pulseEl = node("div", "fxpulse"); h.appendChild(pulseEl); }
    pulseEl.classList.toggle("on", !!on && CFG.enabled);
  }
  function embers(on) { emberOn = !!on && CFG.enabled; }
  function emberBurst() {
    if (!emberOn || !CFG.enabled) return;
    var h = host(); if (!h) return;
    var w = h.clientWidth;
    var x = RX() * w, y = h.clientHeight - 8 - RX() * 40;
    var s = 6 + RX() * 9;
    var n = node("div", "fxember");
    n.style.width = s + "px"; n.style.height = s + "px";
    n.style.left = x + "px"; n.style.top = y + "px";
    n.style.setProperty("--tx", ((RX() - 0.5) * 70) + "px");
    n.style.setProperty("--ty", -(180 + RX() * 260) + "px");
    n.style.setProperty("--d", (2200 + RX() * 1600) + "ms");
    h.appendChild(n); reap(n, 4000);
  }

  /* ── 7. 崩坏 / 时间变慢 ──────────────────────────────────────────── */
  function crash(x, y) {
    var v = node("div", "fxvign"); host().appendChild(v); reap(v, 640);
    ring(x, y, 56, 560);
    for (var i = 0; i < 12; i++) {
      var ang = RX() * Math.PI * 2, r = 26 + RX() * 54;
      var n = node("div", "fxdust");
      var s = 14 + RX() * 22;
      n.style.width = s + "px"; n.style.height = s + "px";
      n.style.left = x + "px"; n.style.top = y + "px";
      n.style.setProperty("--tx", Math.cos(ang) * r + "px");
      n.style.setProperty("--ty", (Math.sin(ang) * r * 0.6 + 12) + "px");
      n.style.setProperty("--d", (620 + RX() * 320) + "ms");
      host().appendChild(n); reap(n, 1000);
    }
    for (var k = 0; k < 4; k++) dot(x, y, 10 + RX() * 8, (RX() - 0.5) * 90, -20 - RX() * 60, 700, "255,209,102");
  }

  var moteOn = false;
  function motes(on) { moteOn = !!on && CFG.enabled; }
  function moteBurst() {
    if (!moteOn || !CFG.enabled) return;
    var h = host(); if (!h) return;
    var n = node("div", "fxmote");
    var s = 2 + RX() * 4;
    n.style.width = s + "px"; n.style.height = s + "px";
    n.style.left = (RX() * h.clientWidth) + "px";
    n.style.top = (h.clientHeight + 6) + "px";
    n.style.setProperty("--tx", ((RX() - 0.5) * 50) + "px");
    n.style.setProperty("--d", (2600 + RX() * 2200) + "ms");
    h.appendChild(n); reap(n, 5200);
  }

  /* ── auto：观察既有 class ────────────────────────────────────────── */
  var lastFire = new WeakMap();
  function once(el, key, gap) {
    var m = lastFire.get(el);
    var t = Date.now();
    if (m && m[key] && t - m[key] < (gap || 380)) return false;
    if (!m) { m = {}; lastFire.set(el, m); }
    m[key] = t;
    return true;
  }

  function onClassChange(el) {
    var cl = el.classList;
    if (!cl) return;
    var c = centre(el);
    if (cl.contains("npc")) {
      if (cl.contains("hit") && once(el, "hit")) { if (c) burst(c.x, c.y, { count: 14, ring: 46 }); }
      if (cl.contains("reject") && once(el, "reject")) { if (c) mist(c.x, c.y); }
      if (cl.contains("hold") && once(el, "hold")) freeze(el, 1500);
    } else if (cl.contains("pot")) {
      if (cl.contains("crashed") && once(el, "crashed")) { if (c) crash(c.x, c.y); }
      if (cl.contains("caught") && once(el, "caught")) {
        if (c) { burst(c.x, c.y, { count: 12, ring: 60 }); }
        var a = document.getElementById("actor");
        if (a && once(a, "catch")) { var ac = centre(a); if (ac) { halo(ac.x, ac.y - 24, 96, 780); } }
      }
    }
    if (el.id === "stage") {
      pulse(cl.contains("ending"));
      embers(cl.contains("ending"));
      motes(cl.contains("slowmo"));
    }
    if (el.id === "flash" && cl.contains("umb")) {
      var a2 = document.getElementById("actor");
      if (a2) {
        var p = centre(a2);
        if (p && once(a2, "umb", 320)) { halo(p.x, p.y - 20, 118, 760); ring(p.x, p.y - 20, 66, 620); }
      }
    }
  }

  var obs = null;
  function attach() {
    if (obs) return;
    obs = new MutationObserver(function (muts) {
      if (!CFG.enabled) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type !== "attributes" || m.attributeName !== "class") continue;
        onClassChange(m.target);
      }
    });
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    var t0 = 0, t1 = 0;
    (function loop(ts) {
      if (CFG.enabled) {
        if (ts - t0 > 55) { trailTick(); t0 = ts; }
        if (ts - t1 > 150) { emberBurst(); moteBurst(); t1 = ts; }
      }
      requestAnimationFrame(loop);
    })(0);
  }

  /* ── 公开 API ────────────────────────────────────────────────────── */
  window.BFfx = {
    burst: burst,
    mist: mist,
    freeze: freeze,
    trail: trail,
    beam: beam,
    pulse: pulse,
    embers: embers,
    motes: motes,
    crash: crash,
    confetti: confetti,
    halo: halo,
    setEnabled: function (v) {
      CFG.enabled = !!v;
      var h = host(); if (h) h.classList.toggle("fx-off", !CFG.enabled);
      if (!CFG.enabled) { beam(false); pulse(false); embers(false); motes(false); trails = []; }
    },
    isEnabled: function () { return CFG.enabled; },
    theme: theme,
    setTheme: function (t) { CFG.theme = (t === "light" || t === "dark") ? t : null; },
    useBase: function (b) { CFG.base = b || null; },
    setCount: function (n) { CFG.count = n > 0 ? n : 1; },
    setAuto: function (v) { CFG.auto = !!v; if (CFG.auto) attach(); },
    attach: attach
  };

  attach();
})();
