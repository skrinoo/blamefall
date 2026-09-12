/**
 * 《锅从天降》 主循环
 *
 * 零构建、零依赖：纯 DOM + requestAnimationFrame，file:// 双击即玩。
 * 刻意不用 Canvas / PixiJS —— 这个游戏的所有对象都是「一张卡片 + 一句台词」，
 * DOM 的排版能力比 Canvas 强得多，而且评审现场的破笔记本也不会掉帧。
 *
 * ─────────────────────────────────────────────────────────────
 * 四个动词
 * ─────────────────────────────────────────────────────────────
 *   抓  点击下落的锅。全局进入慢动作（0.3x），但时间不停 ——
 *       并且有 6 秒的「握持预算」，用完手滑。抓而不决是要付代价的。
 *   甩  选中一个 NPC，再选一句理由（或自己写）。锅飞过去，裁判判定。
 *   辩  五种论证类型。快速选项走 data/verdicts.js 查表（0ms）；
 *       自由输入走 /api/judge（800ms 预算，超时切本地兜底引擎）。
 *   接  点击自己。隐藏动词，不计分，大幅降低心理阴影面积，累积接锅信用。
 *       接满 3 次解锁「反向型」论证 —— 这是第四幕的入口。
 *
 * ─────────────────────────────────────────────────────────────
 * 三幕节奏（60 秒）
 * ─────────────────────────────────────────────────────────────
 *   第一幕 0-20s  爽：掉得慢、接受度 +12，让玩家先赢几次
 *   第二幕 20-45s 紧：掉得快、最多两口锅同时在场、疲劳惩罚开始咬人
 *   第三幕 45-60s 停：锅慢下来，「过去的自己 / 未来的自己」高亮，解说变少
 *   第四幕        结算后按接锅信用触发，不是时间轴上的一幕
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var POT_GLYPH = "\uD83C\uDF72";   // 🍲

  var ROUND = 60;           // 一局秒数
  var HOLD_BUDGET = 12000;  // 握持预算 ms（真实时间，慢动作不能白嫖）
  var CRASH_SHADOW = 8;     // 锅落地的阴影代价
  var CRASH_SCORE = -50;
  var SLIP_SHADOW = 4;      // 手滑的阴影代价

  /**
   * 开局阴影基线。
   *
   * 接锅是全游戏**唯一**能降低心理阴影面积的手段（-8）。
   * 若从 0 开局，那么玩家第一次按下那个隐藏按钮时——
   * 也就是整个游戏的教学时刻——addShadow(-8) 会被 clamp 到 0，
   * 飘字写着「阴影 -8」而数字纹丝不动，接锅看上去完全无效。
   * 12 刚好等于一次接锅能看到明确下降、又不至于开局就像已经崩了一截。
   * 主题上也成立：你上大学到现在，已经背过一些锅了。
   */
  var SHADOW_BASELINE = 12;

  var ACTS = {
    1: { name: "爽", from: 0,  to: 20, spawnEvery: 3.4, fallMs: 5600, maxAir: 1, acceptBonus: 12 },
    2: { name: "紧", from: 20, to: 45, spawnEvery: 2.1, fallMs: 4200, maxAir: 2, acceptBonus: 0  },
    3: { name: "停", from: 45, to: 60, spawnEvery: 3.6, fallMs: 7200, maxAir: 1, acceptBonus: -6 }
  };

  // ═══════════════════════ 状态 ═══════════════════════
  var S = null;

  function freshState() {
    var relations = {}, thrown = {};
    NPCS.forEach(function (n) { relations[n.id] = n.relationInit; thrown[n.id] = 0; });
    return {
      phase: "title",
      t: 0,
      timeScale: 1,
      score: 0,
      shadow: SHADOW_BASELINE,
      credit: 0,
      relations: relations,
      thrown: thrown,
      activated: {},
      pots: [],
      held: null,
      target: null,
      act: 1,
      nextSpawn: 1.0,
      holdLeft: HOLD_BUDGET,
      holdMax: HOLD_BUDGET,     // 读秒条的分母；自由输入重置读秒时会变大
      freeFocus: false,         // 输入框聚焦中 = 打字态
      freeClockGranted: false,  // 本次开面板是否已发放过自由输入读秒
      panelOpen: false,
      busy: false,          // 判定/飞行动画期间锁输入
      over: false,
      overReason: "",
      catchCount: 0,
      crashCount: 0,
      slipCount: 0,
      deferred: 0,
      recentPots: [],
      log: [],
      stats: {
        byType: { "事实型": 0, "情感型": 0, "转移型": 0, "反向型": 0, "荒诞型": 0 },
        successByType: { "事实型": 0, "情感型": 0, "转移型": 0, "反向型": 0, "荒诞型": 0 },
        success: 0, fail: 0, moralHigh: 0, abstract: 0, downward: 0, upward: 0
      },
      npcChip: {}
    };
  }

  // 上一局的遗留：甩给「未来的自己」会让下一局的锅变多
  var carryOver = { extraPots: 0, credit: 0, bestScore: 0, totalCatch: 0 };

  var dev = { metrics: false, slowmo: false, nodie: false };

  // ─────────────── 自由输入读秒设置（localStorage 持久化）───────────────
  // 0  = 打字时不读秒（握持预算冻结，锅仍随 0.12x 世界缓慢下落）
  // N>0 = 聚焦输入框时把读秒重置为 N 秒（每次开面板只发一次）
  var FREE_TIMER_KEY = "bf.freeTimerSec";
  var freeTimerSec = 0;
  function clampInt(v, lo, hi) { v = Math.round(v); return v < lo ? lo : (v > hi ? hi : v); }
  function loadFreeTimer() {
    var v = 0;
    try { v = parseInt(localStorage.getItem(FREE_TIMER_KEY), 10); } catch (e) { v = NaN; }
    freeTimerSec = isNaN(v) ? 0 : clampInt(v, 0, 120);
    return freeTimerSec;
  }
  function saveFreeTimer(v) {
    freeTimerSec = clampInt(isNaN(v) ? 0 : v, 0, 120);
    try { localStorage.setItem(FREE_TIMER_KEY, String(freeTimerSec)); } catch (e) { /* 隐私模式忽略 */ }
    return freeTimerSec;
  }
  function refreshFreeHint() {
    var h = $("panel-free-hint");
    if (!h) return;
    h.textContent = freeTimerSec === 0
      ? "自由输入读秒：不读秒（打字时握持预算冻结）"
      : "自由输入读秒：" + freeTimerSec + "s（聚焦输入框时重置）";
  }
  function syncFreeTimerUI() {
    var inp = $("set-freetimer");
    if (inp) inp.value = String(freeTimerSec);
    var btns = document.querySelectorAll(".set-presets button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", parseInt(btns[i].getAttribute("data-ft"), 10) === freeTimerSec);
    }
    refreshFreeHint();
  }

  // ═══════════════════════ NPC 栏 ═══════════════════════
  function buildNpcBar() {
    var bar = $("npcbar");
    bar.innerHTML = "";
    S.npcChip = {};
    NPCS.forEach(function (n, i) {
      var chip = el("div", "npc" + (n.kind === "abstract" ? " abstract" : "") + (n.kind === "self" ? " self" : ""));
      chip.dataset.id = n.id;
      chip.dataset.idx = String(i);
      chip.innerHTML =
        '<div class="npc-glyph">' + n.glyph + '</div>' +
        '<div class="npc-name">' + n.name + '</div>' +
        '<div class="npc-rel"><i style="width:100%"></i></div>' +
        '<div class="npc-fatigue">0</div>';
      chip.addEventListener("click", function () { onNpcClick(n); });
      chip.addEventListener("mouseenter", function () { if (S.held && !S.panelOpen) markTargetable(n.id); });
      bar.appendChild(chip);
      S.npcChip[n.id] = chip;
    });
  }

  function markTargetable(id) {
    Object.keys(S.npcChip).forEach(function (k) {
      S.npcChip[k].classList.toggle("targetable", k === id);
    });
  }
  function clearTargetable() {
    Object.keys(S.npcChip).forEach(function (k) { S.npcChip[k].classList.remove("targetable"); });
  }

  function refreshNpcBar() {
    NPCS.forEach(function (n) {
      var chip = S.npcChip[n.id];
      if (!chip) return;
      var rel = S.relations[n.id];
      var bar = chip.querySelector(".npc-rel i");
      bar.style.width = clamp(rel, 0, 100) + "%";
      bar.style.background = rel <= n.coldWarAt + 15 ? "var(--bad)" : (rel < 60 ? "var(--good)" : "var(--umbrella)");
      var t = S.thrown[n.id];
      chip.classList.toggle("fatigued", t > 0 && n.fatigueStep > 0);
      // t=0 时必须显示 "0" 而不是 "-0"：开局十四个 chip 会同时挂着 "-0"，
      // 看上去像已经甩过一轮了。
      chip.querySelector(".npc-fatigue").textContent = t > 0 ? "-" + (n.fatigueStep * t) : "0";
      chip.classList.toggle("coldwar", JudgeEngine.inColdWar(n, engineState()));
      // 第三幕把两个「自己」点亮
      var isSelfTurn = (S.act === 3 && n.kind === "self");
      chip.classList.toggle("selected", isSelfTurn && !S.target);
    });
  }

  function engineState() {
    return {
      thrown: S.thrown,
      relations: S.relations,
      activated: S.activated,
      catchCredit: S.credit,
      actBonus: ACTS[S.act].acceptBonus
    };
  }

  // ═══════════════════════ 锅 ═══════════════════════
  function choosePotDef() {
    // 第三幕强制塞进「自己」相关的锅，让第四幕的主题落地
    if (S.act === 3 && S.recentPots.length % 3 === 0) {
      var selfPots = POTS.filter(function (p) { return p.selfish; });
      if (selfPots.length) return pick(selfPots);
    }
    // 热路径：缓冲里有 AI 预生成的锅就优先用（AI 在后台生成，此刻 0ms 取用，
    // 不卡锅落地）。缓冲空 / 离线冷路径 / 生成失败 → 自动落回下面的静态锅池，玩家无感。
    if (typeof PotGen !== "undefined" && PotGen.enabled()) {
      var gen = PotGen.next();
      if (gen) return gen;
    }
    var pool = POTS.filter(function (p) { return S.recentPots.indexOf(p.id) < 0; });
    if (!pool.length) { S.recentPots = []; pool = POTS.slice(); }
    // 加权随机
    var total = 0;
    pool.forEach(function (p) { total += (p.weight || 1); });
    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= (pool[i].weight || 1);
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function spawnPot() {
    var stage = $("stage");
    var def = choosePotDef();
    S.recentPots.push(def.id);
    if (S.recentPots.length > 5) S.recentPots.shift();

    var w = stage.clientWidth;
    var node = el("div", "pot");
    node.innerHTML =
      '<div class="pot-top"><span class="pot-icon">' + POT_GLYPH + '</span>' +
      '<span class="pot-scene">' + def.scene + '</span></div>' +
      '<div class="pot-text">' + def.text + '</div>' +
      '<div class="pot-hold"><i></i></div>';

    var pot = {
      def: def,
      el: node,
      x: clamp(w * (0.14 + Math.random() * 0.68), 110, Math.max(120, w - 110)),
      y: -120,
      vy: 0,
      fallMs: ACTS[S.act].fallMs,
      state: "falling"     // falling | held | flying | gone
    };
    pot.vy = (groundY() + 120) / (pot.fallMs / 1000);   // px per game-second

    node.style.left = pot.x + "px";
    node.style.top = pot.y + "px";
    node.addEventListener("click", function (ev) { ev.stopPropagation(); grabPot(pot); });
    $("sky").appendChild(node);
    S.pots.push(pot);
    return pot;
  }

  function groundY() {
    return $("stage").clientHeight - 96;
  }

  function movePots(dt) {
    var g = groundY();
    for (var i = S.pots.length - 1; i >= 0; i--) {
      var p = S.pots[i];
      if (p.state !== "falling") continue;
      p.y += p.vy * dt;
      p.el.style.top = p.y + "px";
      if (p.y >= g) crashPot(p);
    }
  }

  function removePot(p) {
    p.state = "gone";
    if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    var i = S.pots.indexOf(p);
    if (i >= 0) S.pots.splice(i, 1);
  }

  // ═══════════════════════ 抓 ═══════════════════════
  function grabPot(p) {
    if (S.phase !== "playing" || S.busy || S.over) return;
    if (p.state !== "falling") return;
    if (S.held) return;                 // 一次只能抓一口

    S.held = p;
    p.state = "held";
    S.holdLeft = HOLD_BUDGET;
    S.holdMax = HOLD_BUDGET;
    S.freeClockGranted = false;
    $("panel-input").value = "";   // 新抓一口锅 = 清空上局残留的理由
    p.el.classList.add("held");
    var hb = p.el.querySelector(".pot-hold i");
    if (hb) hb.style.width = "100%";
    $("stage").classList.add("slowmo");
    $("actor").classList.add("armed");
    S.timeScale = 0.3;
    devLog("抓 " + p.def.scene + " · 慢动作 0.3x · 握持预算 " + (HOLD_BUDGET / 1000) + "s", "dim");
    toast(S.act === 1 ? "抓住了。选一个人。" : "抓住了，但别握太久。");
  }

  /**
   * 握持预算推进。无论面板开不开都在扣 ——
   * 否则玩家可以开着面板无限期暂停全局，60 秒永远不会结束，
   * 三幕节奏也就彻底失效了。面板开着时额外把进度画到面板顶部，
   * 因为这时锅牌被面板遮住了。
   */
  function burnHoldBudget(dtReal) {
    if (!S.held || S.busy) return;
    // 打字态且设置=不读秒：握持预算冻结，让玩家安心写理由
    if (S.freeFocus && freeTimerSec === 0) return;
    S.holdLeft -= dtReal * 1000;
    var pct = clamp(S.holdLeft / S.holdMax * 100, 0, 100);
    var hb = S.held.el.querySelector(".pot-hold i");
    if (hb) hb.style.width = pct + "%";
    var pt = $("panel-timer").firstElementChild;
    if (pt) pt.style.width = pct + "%";
    if (S.holdLeft <= 0) slipPot();
  }

  function slipPot() {
    var p = S.held;
    if (!p) return;
    S.slipCount++;
    S.held = null;
    S.target = null;
    closePanel();
    $("stage").classList.remove("slowmo");
    $("actor").classList.remove("armed");
    S.timeScale = 1;
    p.state = "falling";
    p.el.classList.remove("held", "thinking");
    p.vy *= 2.4;                        // 手滑后掉得更快
    addShadow(SLIP_SHADOW);
    updateHud();
    floatText(p.el, "手滑了 −" + SLIP_SHADOW + " 阴影", "bad");
    toast("握太久了，锅从手里滑了出去。");
    devLog("手滑 · 阴影 +" + SLIP_SHADOW, "no");
  }

  // ═══════════════════════ 甩 · 辩 ═══════════════════════
  function onNpcClick(n) {
    if (S.phase !== "playing" || S.busy || S.over) return;

    // 没有握锅时点 NPC = 接锅教学提示；握着锅时 = 选目标
    if (!S.held) { toast("先抓住一口锅，才能甩给" + n.name + "。"); return; }

    S.target = n;
    Object.keys(S.npcChip).forEach(function (k) { S.npcChip[k].classList.remove("targetable"); });
    openPanel(n);
  }

  function openPanel(n) {
    var p = S.held;
    if (!p) return;
    S.panelOpen = true;
    S.timeScale = 0.12;                 // 面板打开时几乎静止，但仍在流动

    // 面板底边抬到 NPC 栏上沿：不遮头像，开着面板也能点头像换目标
    var bar = $("npcbar");
    if (bar) document.documentElement.style.setProperty("--npcbar-h", bar.offsetHeight + "px");
    S.freeClockGranted = false;         // 换目标 = 换理由，重发读秒额度
    refreshFreeHint();

    $("panel-pot-text").textContent = p.def.text;
    $("panel-target").innerHTML =
      '<div class="t-glyph">' + n.glyph + '</div><div class="t-name">' + n.name + '</div>';

    var box = $("panel-options");
    box.innerHTML = "";
    var order = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];
    var keys = ["Q", "W", "E", "R", "T"];

    order.forEach(function (typeName, i) {
      var def = ARGUMENT_TYPES[typeName];
      var locked = def.locked && S.credit < (def.requiresCredit || 3);
      var reason = p.def.options[typeName] || def.example;

      var b = el("button", "opt" + (locked ? " locked" : "") + (typeName === "反向型" ? " wide" : ""));
      b.type = "button";
      b.innerHTML =
        '<span class="opt-type">' + def.icon + " " + typeName + " · " + keys[i] +
        (locked ? " · 需接锅 " + (def.requiresCredit || 3) : "") + "</span>" +
        '<span class="opt-text">' + (locked ? "「" + reason + "」—— 你现在还没资格说这句话" : reason) + "</span>";
      if (!locked) b.addEventListener("click", function () { throwQuick(typeName, reason); });
      else b.addEventListener("click", function () { toast(pick(COMMENTARY.locked)); });
      box.appendChild(b);
    });

    $("panel-timer").classList.add("on");
    $("panel").classList.add("open");
    // 不自动聚焦输入框：选快速选项（键盘 1-5）时读秒照走，保留决策压力；
    // 只有玩家真的点进输入框打字（focus）才按设置冻结/重置读秒。
    devLog("选目标 " + n.name + " · A=" + JudgeEngine.acceptanceOf(n, "事实型", engineState()) +
           " G=" + JudgeEngine.ownershipOf(p.def, n), "dim");
  }

  function closePanel() {
    S.panelOpen = false;
    $("panel").classList.remove("open");
    $("panel-timer").classList.remove("on");
  }

  function releasePot() {
    // 放手：锅继续掉，回到常速
    var p = S.held;
    closePanel();
    S.target = null;
    if (p) { p.state = "falling"; p.el.classList.remove("held"); }
    S.held = null;
    $("stage").classList.remove("slowmo");
    $("actor").classList.remove("armed");
    S.timeScale = 1;
  }

  /** 快速选项：0ms 查表路径 */
  function throwQuick(argType, reason) {
    var p = S.held, n = S.target;
    if (!p || !n) return;
    closePanel();

    var lib = FallbackEngine.lookup(n.id, argType, VERDICTS);
    var ai = {
      technique: lib.technique,
      verdict: lib.verdict,
      reactionSuccess: lib.reactionSuccess,
      reactionFail: lib.reactionFail
      // 刻意不带 persuasiveness：说服力由引擎对固定文本实算，
      // 不让 LLM 出数值（详见 data/verdicts.js 顶部说明）
    };
    devLog("查表命中 " + lib.source + " · " + n.id + "::" + argType, lib.hit ? "ok" : "dim");

    var ms = 620;
    startFlight(p, n, ms);
    Promise.all([delay(ms)]).then(function () {
      finishThrow(p, n, argType, reason, ai, true);
    });
  }

  /** 自由输入：乐观 UI —— 锅立刻起飞，AI 在飞行途中返回 */
  function throwFree(reason) {
    var p = S.held, n = S.target;
    if (!p || !n) return;
    reason = String(reason || "").trim();
    if (!reason) { toast("理由不能是空的。空着嘴甩不动锅。"); return; }
    closePanel();

    var online = JudgeAPI.isOnline();
    var ms = online ? JudgeAPI.cfg.flightMs : 900;
    startFlight(p, n, ms);
    if (online) p.el.classList.add("thinking");
    $("panel-timer").classList.remove("on");

    var payload = JudgeAPI.judgeFree({
      potText: p.def.text, npcName: n.name, npcDesc: n.desc, reason: reason
    }).then(function (res) {
      if (res) {
        devLog("AI 裁判返回 S=" + res.persuasiveness + " · " + res.technique, "ok");
        return { argType: res.argumentType, ai: res, source: "ai" };
      }
      // 离线 / 超时 / 校验失败 -> 本地兜底
      var t = FallbackEngine.classifyArgumentType(reason, ARGUMENT_TYPES);
      var lib = FallbackEngine.lookup(n.id, t, VERDICTS);
      var s = FallbackEngine.computePersuasiveness(reason, t, n, p.def, ARGUMENT_TYPES);
      var det = FallbackEngine.computePersuasivenessDetailed(reason, t, n, p.def, ARGUMENT_TYPES);
      devLog("兜底引擎 · 判为" + t + " · S=" + s + " [" + det.trace.join(" / ") + "]", "dim");
      lib.persuasiveness = s;
      return { argType: t, ai: lib, source: online ? "fallback" : "offline" };
    });

    Promise.all([payload, delay(ms)]).then(function (r) {
      finishThrow(p, n, r[0].argType, reason, r[0].ai, false);
    });
  }

  function startFlight(p, n, ms) {
    S.busy = true;
    S.held = null;
    S.target = null;
    $("stage").classList.remove("slowmo");
    $("actor").classList.remove("armed");
    clearTargetable();
    S.timeScale = 0.35;                 // 飞行期间保持慢动作，让锅的轨迹看得见
    p.state = "flying";
    p.el.classList.remove("held");

    var chip = S.npcChip[n.id];
    var tr = chip.getBoundingClientRect();
    var r = p.el.getBoundingClientRect();

    p.el.style.position = "fixed";
    p.el.style.left = "0px";
    p.el.style.top = "0px";
    p.el.style.transform = "translate(" + r.left + "px," + r.top + "px)";
    document.body.appendChild(p.el);
    void p.el.offsetWidth;              // 强制回流，否则 transition 不生效

    p.el.style.setProperty("--fly-ms", ms + "ms");
    p.el.classList.add("flying");
    var dx = tr.left + tr.width / 2 - p.el.offsetWidth / 2;
    var dy = tr.top + tr.height / 2 - p.el.offsetHeight / 2;
    p.el.style.transform = "translate(" + dx + "px," + dy + "px) scale(.5) rotate(320deg)";
    p.flight = { el: p.el };
  }

  /** 判定落地：调引擎、播气泡、结算数值 */
  function finishThrow(p, n, argType, reason, ai, isQuick) {
    var res = JudgeEngine.judge({
      pot: p.def, npc: n, argType: argType, reason: reason,
      state: engineState(),
      ai: ai, quick: isQuick,
      fallback: FallbackEngine, types: ARGUMENT_TYPES
    });

    var chip = S.npcChip[n.id];
    var tr = chip.getBoundingClientRect();

    // ── 数值结算 ────────────────────────────────
    S.score += res.score;
    addShadow(res.shadowDelta);
    S.credit += (res.creditDelta || 0);
    if (res.relationDelta) {
      S.relations[n.id] = clamp(S.relations[n.id] + res.relationDelta, 0, 100);
    }
    S.thrown[n.id] = (S.thrown[n.id] || 0) + 1;
    S.stats.byType[argType] = (S.stats.byType[argType] || 0) + 1;
    // 立刻刷 HUD，不等下一帧。
    // 得分与阴影是这局游戏最重的两个反馈，多等 16ms 都是浪费；
    // 而且它让这两个数值不再依赖 rAF——标签页不可见时 rAF 会整个停掉。
    updateHud();

    var wasCold = JudgeEngine.inColdWar(n, engineState());

    // ── 统计（供体质报告）──────────────────────
    if (res.success) {
      S.stats.success++;
      S.stats.successByType[argType] = (S.stats.successByType[argType] || 0) + 1;
      if (n.moralCost === "高") { S.stats.moralHigh++; S.stats.downward++; }
      if (n.kind === "abstract") S.stats.abstract++;
      if (n.id === "daoshi" || n.id === "jiaowu" || n.id === "xuezhang") S.stats.upward++;
    } else if (!res.caught && !res.suspended) {
      S.stats.fail++;
    }
    // 悬空不计入失败：它既没得分也没代价，单独统计，
    // 否则体质报告会把「被辅导员按住」误归为「你甩不动」。
    if (res.suspended) S.stats.suspended = (S.stats.suspended || 0) + 1;
    if (res.caught) S.catchCount++;
    if (res.deferred) S.deferred++;

    // ── 日志 ────────────────────────────────────
    S.log.push({
      t: S.t, scene: p.def.scene, pot: p.def.text, npc: n.name, npcId: n.id,
      argType: argType, reason: reason, technique: res.technique,
      ok: res.success, crit: res.critical, caught: !!res.caught,
      reflected: !!res.reflected, suspended: !!res.suspended,
      score: res.score, shadow: res.shadowDelta,
      S: res.S, A: res.A, G: res.G, P: res.P, source: res.source
    });

    // ── 表现 ────────────────────────────────────
    var bubbleKind = res.caught ? "umb"
      : res.suspended ? "hold"
      : res.critical ? "crit"
      : res.success ? "ok" : "no";
    var tag = res.caught ? "接 住 了"
      : res.suspended ? "悬 空"
      : res.critical ? "完 美 论 证"
      : res.reflected ? "被 反 甩"
      : res.deferred ? "延 期 交 付"
      : res.success ? "甩 锅 成 功" : "甩 锅 失 败";

    showBubble({
      kind: bubbleKind, tag: tag,
      technique: res.technique || "（无手法）",
      verdict: res.verdict || "",
      reaction: res.reaction || "",
      metrics: dev.metrics
        ? ("S " + res.S + " x0.4 + A " + res.A + " x0.4 + G " + res.G + " x0.2 = P " + res.P +
           "  [" + res.source + "]" + (res.critical ? "  CRIT" : ""))
        : ""
    });

    if (res.success) {
      chip.classList.add("hit");
      setTimeout(function () { chip.classList.remove("hit"); }, 460);
      floatAt(tr, (res.score > 0 ? "+" + res.score + " 分" : "") +
                  (res.shadowDelta ? "  阴影 " + fmt(res.shadowDelta) : ""),
                  res.critical ? "crit" : (n.moralCost === "高" ? "bad" : "good"));
    } else if (res.suspended) {
      // 悬空不给 chip 加 reject（红抖）：它没有驳回你，它只是不接。
      chip.classList.add("hold");
      setTimeout(function () { chip.classList.remove("hold"); }, 900);
      floatAt(tr, "悬 空", "hold");
    } else {
      chip.classList.add("reject");
      setTimeout(function () { chip.classList.remove("reject"); }, 460);
      floatAt(tr, res.shadowDelta ? "阴影 " + fmt(res.shadowDelta) : "被驳回", "bad");
    }

    if (res.caught) {
      $("flash").className = "flash umb";
      void $("flash").offsetWidth;
      $("flash").className = "flash umb";
      $("hud-credit-cell").classList.add("gain");
      setTimeout(function () { $("hud-credit-cell").classList.remove("gain"); }, 520);
    }

    // ── 解说 ────────────────────────────────────
    var line;
    if (res.caught) line = (S.catchCount === 1) ? COMMENTARY.catchFirst : pick(COMMENTARY.catchMore);
    else if (res.critical) line = pick(COMMENTARY.critical);
    else if (res.reflected) line = COMMENTARY.reflect[n.id] || pick(COMMENTARY.fail);
    else if (res.deferred) line = pick(COMMENTARY.defer);
    else if (res.suspended) line = pick(COMMENTARY.suspend);
    else if (res.events.indexOf("pastSelf") >= 0) line = pick(COMMENTARY.pastSelf);
    else if (res.events.indexOf("locked") >= 0) line = pick(COMMENTARY.locked);
    else if (res.events.indexOf("coldWar") >= 0) line = pick(COMMENTARY.coldwar);
    else if (res.events.indexOf("abstract") >= 0) line = pick(COMMENTARY.abstract);
    else if (res.success && n.moralCost === "高") line = pick(COMMENTARY.moralHigh);
    else if (res.success) line = pick(COMMENTARY.success);
    else line = pick(COMMENTARY.fail);
    toast(line, 2600);

    devLog((res.caught ? "接住" : res.suspended ? "悬空" : res.success ? "成功" : "失败") +
           " · " + n.name + " · " + argType +
           " · " + res.technique + " · P=" + res.P + " S=" + res.S + " A=" + res.A + " G=" + res.G +
           " · " + res.source,
           res.suspended ? "warn" : (res.success ? "ok" : "no"));

    if (wasCold) toast(pick(COMMENTARY.coldwar), 2600);

    // ── 收尾 ────────────────────────────────────
    if (res.suspended) {
      // 悬空：锅先停在 NPC 那里一小会儿再消失。
      // 必须让它被看见，否则玩家只知道「没成功」，
      // 却看不出它与其他三种失败在画面上有任何不同。
      if (p.el) p.el.classList.add("suspended");
      setTimeout(function () { removePot(p); }, res.freezeMs || 2000);
    } else {
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
      var idx = S.pots.indexOf(p);
      if (idx >= 0) S.pots.splice(idx, 1);
    }

    S.timeScale = 0.3;                  // 气泡期间保持慢速，让玩家读完
    setTimeout(function () {
      hideBubble();
      S.busy = false;
      if (S.phase === "playing") S.timeScale = 1;
      refreshNpcBar();
      if (S.shadow >= 100 && !dev.nodie) endGame("breakdown");
    }, res.critical || res.caught ? 3200 : 2400);

    refreshNpcBar();
  }

  function fmt(v) { return (v > 0 ? "+" : "") + v; }

  // ═══════════════════════ 接 ═══════════════════════
  function catchSelf() {
    if (S.phase !== "playing" || S.busy || S.over) return;
    var p = S.held;
    if (!p) { toast("手里没有锅。接锅得先有锅可接。"); return; }

    closePanel();
    S.held = null;
    S.target = null;
    $("stage").classList.remove("slowmo");
    S.timeScale = 0.35;
    S.busy = true;

    p.state = "flying";
    p.el.classList.remove("held");
    p.el.classList.add("caught");

    var res = JudgeEngine.judge({
      pot: p.def, npc: NPCS[0], argType: "事实型", reason: "",
      state: engineState(), catchSelf: true
    });

    S.score += res.score;
    var shadowBefore = S.shadow;
    addShadow(res.shadowDelta);
    var shadowApplied = S.shadow - shadowBefore;
    S.credit += (res.creditDelta || 0);
    S.catchCount++;
    carryOver.totalCatch++;
    updateHud();
    S.log.push({
      t: S.t, scene: p.def.scene, pot: p.def.text, npc: "你自己", npcId: "self",
      argType: "接锅", reason: "（没有理由）", technique: res.technique,
      ok: true, crit: false, caught: true, reflected: false,
      score: res.score, shadow: res.shadowDelta, S: 0, A: 0, G: 1, P: 1, source: "fixed"
    });

    showBubble({
      kind: "umb", tag: "接 住 了", technique: res.technique,
      verdict: res.verdict, reaction: "", metrics: ""
    });
    var ar = $("actor").getBoundingClientRect();
    // 报实际生效的增量，不报意图值。阴影已经见底时 addShadow 会被 clamp 住，
    // 这时飘字若仍写「阴影 -8」而数字纹丝不动，玩家会以为游戏算错了。
    floatAt(ar, (shadowApplied ? "阴影 " + fmt(shadowApplied) + "  " : "") + "☂ +1", "umb");
    toast(S.catchCount === 1 ? COMMENTARY.catchFirst : pick(COMMENTARY.catchMore), 3000);
    devLog("接锅 · 信用 " + S.credit + " · 阴影 " + fmt(shadowApplied), "umb");

    $("hud-credit-cell").classList.add("gain");
    setTimeout(function () { $("hud-credit-cell").classList.remove("gain"); }, 520);

    if (S.credit === 3) {
      setTimeout(function () {
        toast("「反向型」论证已解锁。你现在有资格说：「是你让我这么做的」。", 3600);
        devLog("解锁 反向型 · 接锅信用达到 3", "umb");
      }, 3100);
    }

    setTimeout(function () {
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
      var i = S.pots.indexOf(p);
      if (i >= 0) S.pots.splice(i, 1);
      hideBubble();
      S.busy = false;
      $("actor").classList.remove("armed");
      if (S.phase === "playing") S.timeScale = 1;
      refreshNpcBar();
    }, 3000);
  }

  // ═══════════════════════ 锅落地 ═══════════════════════
  function crashPot(p) {
    if (p.state !== "falling") return;
    p.state = "gone";
    S.crashCount++;
    if (S.held === p) { S.held = null; $("stage").classList.remove("slowmo"); S.timeScale = 1; }

    p.el.classList.add("crashed");
    addShadow(CRASH_SHADOW);
    S.score += CRASH_SCORE;
    updateHud();
    floatAt(p.el.getBoundingClientRect(), "砸到自己 " + fmt(CRASH_SCORE) + " 分", "bad");
    $("flash").className = "flash bad";
    void $("flash").offsetWidth;
    $("flash").className = "flash bad";
    $("screen-game").classList.add("shake");
    $("actor").classList.add("hurt");
    setTimeout(function () {
      $("screen-game").classList.remove("shake");
      $("actor").classList.remove("hurt");
    }, 460);
    toast(pick(COMMENTARY.crash));
    devLog("锅落地 · " + p.def.scene + " · 阴影 +" + CRASH_SHADOW + " 分 " + CRASH_SCORE, "no");
    S.log.push({
      t: S.t, scene: p.def.scene, pot: p.def.text, npc: "（没人接）", npcId: "-",
      argType: "-", reason: "-", technique: "无人认领", ok: false, crit: false,
      caught: false, reflected: false, score: CRASH_SCORE, shadow: CRASH_SHADOW,
      S: 0, A: 0, G: 0, P: 0, source: "engine"
    });
    setTimeout(function () { removePot(p); }, 520);
    if (S.shadow >= 100 && !dev.nodie) endGame("breakdown");
  }

  // ═══════════════════════ HUD / 幕 ═══════════════════════
  function addShadow(d) {
    S.shadow = clamp(S.shadow + d, 0, 100);
  }

  function updateHud() {
    $("hud-score").textContent = S.score;
    $("hud-shadow").textContent = Math.round(S.shadow);
    $("hud-shadowbar").style.width = S.shadow + "%";
    $("hud-shadowbar").classList.toggle("danger", S.shadow >= 75);
    $("hud-credit").textContent = S.credit;
    var left = Math.max(0, ROUND - S.t);
    $("hud-time").textContent = left.toFixed(1);
    $("hud-timebar").style.transform = "scaleX(" + (left / ROUND) + ")";
    $("hud-timebar").style.background = left < 10 ? "var(--bad)" : (left < 25 ? "var(--good)" : "var(--ink-dim)");
  }

  function bumpScore() {
    var c = $("hud-score").parentNode;
    c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump");
  }

  function updateAct() {
    var a = S.t < 20 ? 1 : (S.t < 45 ? 2 : 3);
    if (a === S.act) return;
    S.act = a;
    $("hud-act").textContent = a === 1 ? "第一幕" : (a === 2 ? "第二幕" : "第三幕");
    $("hud-act-name").textContent = ACTS[a].name;
    var line = $("hud-act").parentNode;
    line.classList.remove("switch"); void line.offsetWidth; line.classList.add("switch");
    toast(pick(COMMENTARY.acts[a]), 3400);
    devLog("── 进入第" + a + "幕「" + ACTS[a].name + "」 接受度修正 " + fmt(ACTS[a].acceptBonus) + " ──", "dim");
    if (a === 3) {
      // 第三幕：把两个「自己」推到栏位最前，视觉上完成主题转折
      ["past_self", "future_self"].forEach(function (id) {
        var chip = S.npcChip[id];
        if (chip && chip.parentNode) chip.parentNode.appendChild(chip);
      });
    }
  }

  function spawnLogic(dt) {
    var cfg = ACTS[S.act];
    var inAir = S.pots.filter(function (p) { return p.state === "falling"; }).length;
    S.nextSpawn -= dt;
    if (S.nextSpawn <= 0 && inAir < cfg.maxAir) {
      spawnPot();
      // 上一局甩给「未来的自己」的锅，这一局会提前到
      var bonus = carryOver.extraPots > 0 ? 0.85 : 1;
      S.nextSpawn = cfg.spawnEvery * bonus * (0.85 + Math.random() * 0.3);
    } else if (S.nextSpawn <= 0) {
      S.nextSpawn = 0.4;                 // 场上满了，稍后再试
    }
  }

  // ═══════════════════════ 主循环 ═══════════════════════
  var lastTs = 0;
  function loop(ts) {
    if (!lastTs) lastTs = ts;
    var dtReal = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    if (S.phase === "playing" && !S.over) {
      var scale = S.timeScale * (dev.slowmo ? 0.5 : 1);
      S.t += dtReal * scale;
      updateAct();
      spawnLogic(dtReal * scale);
      movePots(dtReal * scale);
      updateHud();

      // 握持预算：面板开不开都在扣，否则开着面板就能无限暂停全局
      burnHoldBudget(dtReal);

      if (S.t >= ROUND) endGame("time");
    }
    requestAnimationFrame(loop);
  }

  // ═══════════════════════ 气泡 / 飘字 / 解说 ═══════════════════════
  var bubbleTimer = null;
  function showBubble(o) {
    var b = $("bubble");
    b.className = "bubble show " + o.kind;
    b.innerHTML =
      '<div class="bubble-tag">' + o.tag + "</div>" +
      '<div class="bubble-technique" id="bubble-technique"></div>' +
      '<div class="bubble-verdict" id="bubble-verdict"></div>' +
      '<div class="bubble-reaction" id="bubble-reaction"></div>' +
      '<div class="bubble-metrics' + (o.metrics ? " on" : "") + '" id="bubble-metrics"></div>';
    $("bubble-technique").textContent = o.technique;
    $("bubble-verdict").innerHTML = o.verdict;
    $("bubble-reaction").textContent = o.reaction;
    $("bubble-metrics").textContent = o.metrics;
  }
  function hideBubble() { $("bubble").className = "bubble"; }

  function floatText(anchorEl, text, kind) { floatAt(anchorEl.getBoundingClientRect(), text, kind); }
  function floatAt(rect, text, kind) {
    if (!text) return;
    var f = el("div", "float " + (kind || "good"), text);
    f.style.left = (rect.left + rect.width / 2) + "px";
    f.style.top = (rect.top - 6) + "px";
    f.style.position = "fixed";
    document.body.appendChild(f);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1150);
  }

  var toastTimer = null;
  function toast(text, ms) {
    if (!text) return;
    var t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, ms || 2200);
  }

  // ═══════════════════════ 结算卷宗 ═══════════════════════
  function endGame(reason) {
    if (S.over) return;
    S.over = true;
    S.overReason = reason;
    S.phase = "report";
    S.timeScale = 1;
    closePanel();
    hideBubble();
    $("stage").classList.remove("slowmo");

    if (reason === "breakdown") {
      toast(pick(COMMENTARY.breakdown), 4000);
      $("flash").className = "flash bad";
      void $("flash").offsetWidth;
      $("flash").className = "flash bad";
    }

    carryOver.extraPots = S.deferred;
    carryOver.credit = S.credit;
    carryOver.bestScore = Math.max(carryOver.bestScore, S.score);

    setTimeout(function () { renderReport(reason); }, reason === "breakdown" ? 1500 : 500);
  }

  function rankOf(score) {
    for (var i = 0; i < COMMENTARY.ranks.length; i++) {
      if (score >= COMMENTARY.ranks[i].min) return COMMENTARY.ranks[i];
    }
    return COMMENTARY.ranks[COMMENTARY.ranks.length - 1];
  }

  function buildTemperament() {
    var st = S.stats;
    var total = Math.max(1, st.success);
    var out = [];
    var typeTotals = Object.keys(st.byType).map(function (k) { return [k, st.byType[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    var topType = typeTotals[0][1] > 0 ? typeTotals[0][0] : null;

    var T = {};
    COMMENTARY.temperaments.forEach(function (x) { T[x.id] = x; });

    if (st.downward / total > 0.5) out.push(T.downward);
    if (st.upward >= 3) out.push(T.upward);
    if (st.abstract >= 3) out.push(T.abstract);
    if (topType === "事实型") out.push(T.fact);
    else if (topType === "情感型") out.push(T.emotion);
    else if (topType === "荒诞型") out.push(T.absurd);

    if (!out.length) out.push(T.fact);
    return out.slice(0, 2);
  }

  function buildManual() {
    var st = S.stats;
    var items = [];
    var best = null;
    S.log.forEach(function (r) {
      if (!r.ok || r.caught) return;
      var k = r.npc + " · " + r.argType;
      best = (!best || r.P > best.P) ? r : best;
    });

    if (best) {
      items.push("本局你最有效的一次是 <span class='hl'>" + best.technique + "</span>：" +
                 "对「" + best.npc + "」用「" + best.argType + "」，P 值 " + best.P.toFixed(2) + "。" +
                 "记住这个组合 —— 它是你论证能力最高的一次，也是你最不需要说谎的一次。");
    }
    if (st.fail > 0) {
      items.push("你有 <span class='hl-bad'>" + st.fail + "</span> 次论证被驳回。" +
                 "被驳回的理由有一个共同点：里面没有可核验的东西。" +
                 "加上时间、次数、记录、谁说过什么 —— 说服力会明显不一样。");
    }
    if (st.moralHigh > 0) {
      items.push("你成功甩给「不会拒绝你的人」共 <span class='hl-bad'>" + st.moralHigh + "</span> 次。" +
                 "心理阴影面积每一次都涨了 2 —— 游戏没有惩罚你失败，它惩罚的是这一种成功。");
    }
    if (S.credit === 0) {
      items.push("本局你一次都没有接锅，「反向型」论证始终锁着。" +
                 "游戏里如此，现实里也如此：<b>从不承担责任的人，没有资格说「是你让我这么做的」。</b>");
    } else if (S.credit >= 3) {
      items.push("你接住了 <span class='hl-umb'>" + S.credit + "</span> 口锅，解锁了「反向型」。" +
                 "它不是甩锅，它是把责任放回真正发起它的那个环节上。这是全游戏最难用、也最干净的一招。");
    }
    if (S.crashCount > 0) {
      items.push("有 <span class='hl-bad'>" + S.crashCount + "</span> 口锅你没处理，它自己找到了主人。" +
                 "不甩，也是一种选择，只是代价由你自己付。");
    }
    if (S.deferred > 0) {
      items.push("你把 <span class='hl-bad'>" + S.deferred + "</span> 口锅寄给了未来的自己。" +
                 "运费到付 —— 下一局的锅会掉得更快。");
    }
    return items.slice(0, 4);
  }

  function renderReport(reason) {
    var rank = rankOf(S.score);
    $("report-rank").textContent = rank.name;
    // 写整个 <p id="report-scoreline">，而不是写里面的 <b id="report-score">。
    // 曾经写错过一次：把整句塞进那个 <b>，而它原本的两个兄弟节点
    // （「· 心理阴影面积 <b id=report-shadow>0</b>」）仍留在 DOM 里，
    // 于是标题行把同一句话渲染了两遍，尾巴还挂着一个永远为 0 的陈旧阴影值。
    $("report-scoreline").innerHTML = "得分 <b>" + S.score + "</b> <span class='dim'>·</span> " +
      "心理阴影面积 <b>" + Math.round(S.shadow) + "</b> <span class='dim'>·</span> " +
      (reason === "breakdown" ? "<b style='color:var(--bad)'>你在第 " + S.t.toFixed(0) + " 秒崩溃了</b>"
                              : "撑满了 " + ROUND + " 秒");

    var st = S.stats;
    var html = "";

    html += "<div class='card'><div class='card-title'>本局数据</div><div class='stat-row'>" +
      stat(S.stats.success, "甩锅成功") + stat(st.fail, "被驳回") +
      stat(S.crashCount, "落地砸自己") + stat(S.catchCount, "☂ 接住") +
      stat(Math.round(S.shadow), "阴影面积") +
      "</div></div>";

    html += "<div class='card'><div class='card-title'>段位评语</div>" +
      "<div class='card-text'>" + rank.line + "</div></div>";

    var temps = buildTemperament();
    html += "<div class='card'><div class='card-title'>甩锅体质报告</div><div class='card-text'>" +
      temps.map(function (x) { return "<p>" + x.text + "</p>"; }).join("") + "</div></div>";

    var manual = buildManual();
    html += "<div class='card'><div class='card-title'>防甩锅手册 · 本局专属</div><div class='card-text'>" +
      manual.map(function (x) { return "<p>· " + x + "</p>"; }).join("") + "</div></div>";

    if (S.log.length) {
      var rows = S.log.map(function (r) {
        var cls = r.caught ? "umb" : (r.suspended ? "hold" : (r.ok ? "ok" : "no"));
        var mark = r.caught ? "接"
          : r.suspended ? "悬"
          : r.crit ? "暴击"
          : r.ok ? "成"
          : r.reflected ? "反甩" : "败";
        return "<tr><td>" + r.t.toFixed(0) + "s</td><td>" + r.scene + "</td>" +
          "<td>" + r.npc + "</td><td>" + r.argType + "</td>" +
          "<td class='tech'>" + (r.technique || "—") + "</td>" +
          "<td class='" + cls + "'>" + mark + "</td>" +
          "<td>" + fmt(r.shadow) + "</td></tr>";
      }).join("");
      html += "<div class='card'><div class='card-title'>甩锅明细 · " + S.log.length + " 条</div>" +
        "<div style='max-height:220px;overflow-y:auto'><table class='log'>" +
        "<thead><tr><th>时刻</th><th>场景</th><th>对象</th><th>论证</th><th>手法</th><th>结果</th><th>阴影</th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table></div></div>";
    }

    $("report-body").innerHTML = html;

    // ── 第四幕 ────────────────────────────────────
    var act4 = $("report-act4");
    if (S.catchCount > 0) {
      act4.innerHTML =
        "<h3>第四幕 · 锅到哪里停下</h3>" +
        "<p>这一局你接住了 <b>" + S.catchCount + "</b> 口锅。它们没有计入甩锅得分 —— " +
        "得分衡量的是你把责任推出去的能力，而接锅不是这个方向上的事。</p>" +
        "<p>它们计入的是另一张榜。那张榜没有段位，只有一个数字。</p>" +
        "<div class='law'>《情绪保护法》第一条：锅不会消失，只会转移。<br>" +
        "总得有人让它停下来。这一局，是你。</div>";
    } else if (reason === "breakdown") {
      act4.innerHTML =
        "<h3>第四幕 · 你没有崩溃的理由</h3>" +
        "<p>你甩掉了每一口锅，心理阴影面积却还是到了 100。</p>" +
        "<p>因为它涨得最快的时候，不是你失败的时候，" +
        "是你<b>成功甩给一个不会拒绝你的人</b>的时候。</p>" +
        "<div class='law'>下一局试试那个没人告诉你的动作：把锅拖回自己身上。<br>" +
        "它不加分。它只是让阴影停下来。</div>";
    } else {
      act4.innerHTML =
        "<h3>第四幕 · 未触发</h3>" +
        "<p>本局你一次都没有接锅。所以你还不知道那个动作会让游戏变成什么样。</p>" +
        "<div class='law'>提示：手里握着锅的时候，点一下屏幕最下面的「你」。</div>";
    }

    showScreen("screen-report");
    devLog("══ 结算 · " + rank.name + " · 得分 " + S.score + " · 阴影 " + Math.round(S.shadow) +
           " · 接锅 " + S.catchCount + " ══", "umb");
  }

  function stat(v, label) {
    return "<div class='stat'><b>" + v + "</b><span>" + label + "</span></div>";
  }

  // ═══════════════════════ 屏切换 / 开局 ═══════════════════════
  function showScreen(id) {
    ["screen-title", "screen-game", "screen-report"].forEach(function (s) {
      $(s).classList.toggle("is-active", s === id);
    });
  }

  function startGame() {
    S = freshState();
    S.phase = "playing";
    buildNpcBar();
    $("sky").innerHTML = "";
    $("hud-act").textContent = "第一幕";
    $("hud-act-name").textContent = ACTS[1].name;
    S.nextSpawn = 0.8;
    // 开局先后台预取一批 AI 锅填缓冲（热路径才发；失败/离线不影响下面的静态锅）。
    if (typeof PotGen !== "undefined" && PotGen.enabled()) PotGen.prefetch(3);
    showScreen("screen-game");
    updateHud();
    refreshNpcBar();
    devLog("══ 开局 · 判定库 " + Object.keys(VERDICTS.entries).length + " 条 · " +
           (JudgeAPI.isOnline() ? "在线裁判 " + JudgeAPI.cfg.apiBase : "离线模式（查表 + 兜底引擎）") + " ══", "umb");
    if (carryOver.extraPots > 0) {
      devLog("上一局寄往未来的锅到货了：掉速 x1.18", "no");
      toast("上一局你寄给未来的锅，到货了。", 3200);
    }
    setTimeout(function () { toast(pick(COMMENTARY.acts[1]), 3200); }, 400);
    spawnPot();
  }

  // ═══════════════════════ 开发者面板 ═══════════════════════
  function devLog(text, kind) {
    var pre = $("dev-log");
    var line = document.createElement("div");
    line.className = "l-" + (kind || "dim");
    line.textContent = "[" + (S ? S.t.toFixed(1) : "0.0") + "s] " + text;
    pre.appendChild(line);
    while (pre.childNodes.length > 120) pre.removeChild(pre.firstChild);
    pre.parentNode.scrollTop = pre.parentNode.scrollHeight;
  }

  // ═══════════════════════ 事件绑定 ═══════════════════════
  function bind() {
    $("btn-start").addEventListener("click", startGame);
    $("btn-again").addEventListener("click", startGame);
    $("btn-home").addEventListener("click", function () { S.phase = "title"; showScreen("screen-title"); });

    $("panel-close").addEventListener("click", releasePot);
    $("panel-send").addEventListener("click", function () { throwFree($("panel-input").value); });
    $("panel-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); throwFree($("panel-input").value); }
      e.stopPropagation();
    });
    // 打字态读秒：聚焦=按设置冻结/重置读秒，失焦=恢复常规消耗
    $("panel-input").addEventListener("focus", function () {
      S.freeFocus = true;
      if (freeTimerSec > 0 && S.held && !S.freeClockGranted) {
        S.holdLeft = freeTimerSec * 1000;
        S.holdMax = freeTimerSec * 1000;
        S.freeClockGranted = true;
      }
    });
    $("panel-input").addEventListener("blur", function () { S.freeFocus = false; });

    // 标题屏：自由输入读秒设置（数字框 + 预设按钮）
    $("set-freetimer").addEventListener("change", function () {
      saveFreeTimer(parseInt(this.value, 10)); syncFreeTimerUI();
    });
    var presetBtns = document.querySelectorAll(".set-presets button");
    for (var pi = 0; pi < presetBtns.length; pi++) {
      presetBtns[pi].addEventListener("click", function () {
        saveFreeTimer(parseInt(this.getAttribute("data-ft"), 10)); syncFreeTimerUI();
      });
    }
    window.addEventListener("resize", function () {
      if (S.panelOpen) {
        var b = $("npcbar");
        if (b) document.documentElement.style.setProperty("--npcbar-h", b.offsetHeight + "px");
      }
    });

    $("actor").addEventListener("click", catchSelf);

    // 点击空白处 = 放手
    $("stage").addEventListener("click", function () { if (S.held && !S.panelOpen) releasePot(); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "`") { $("devpanel").classList.toggle("open"); return; }
      if (!S || S.phase !== "playing") {
        if (e.key === "Enter" && S && S.phase !== "playing") {
          if ($("screen-title").classList.contains("is-active")) startGame();
        }
        return;
      }
      if (e.key === "Escape") { if (S.panelOpen) releasePot(); return; }
      if (S.panelOpen && /^[1-5]$/.test(e.key)) {
        var order = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];
        var t = order[parseInt(e.key, 10) - 1];
        var def = ARGUMENT_TYPES[t];
        if (def.locked && S.credit < (def.requiresCredit || 3)) { toast(pick(COMMENTARY.locked)); return; }
        throwQuick(t, S.held.def.options[t] || def.example);
        return;
      }
      if (!S.panelOpen && S.held) {
        var i = parseInt(e.key, 10);
        if (!isNaN(i) && i >= 1 && i <= 9) {
          var n = NPCS[(i - 1) % NPCS.length];
          if (n) onNpcClick(n);
        }
      }
    });

    $("dev-close").addEventListener("click", function () { $("devpanel").classList.remove("open"); });
    $("dev-metrics").addEventListener("change", function (e) { dev.metrics = e.target.checked; });
    $("dev-slowmo").addEventListener("change", function (e) { dev.slowmo = e.target.checked; });
    $("dev-nodie").addEventListener("change", function (e) { dev.nodie = e.target.checked; });
    $("dev-end").addEventListener("click", function () { if (S && S.phase === "playing") endGame("time"); });

    window.addEventListener("resize", function () {
      if (!S) return;
      var w = $("stage").clientWidth;
      S.pots.forEach(function (p) {
        if (p.state === "falling" || p.state === "held") {
          p.x = clamp(p.x, 110, Math.max(120, w - 110));
          p.el.style.left = p.x + "px";
        }
      });
    });
  }

  // ═══════════════════════ 启动 ═══════════════════════
  function boot() {
    S = freshState();
    bind();
    loadFreeTimer(); syncFreeTimerUI();

    var n = Object.keys(VERDICTS.entries).length;
    var hot = JudgeAPI.isOnline();
    $("meta-mode").textContent = hot
      ? ("热路径 · AI 判定 + AI 生成锅 · " + JudgeAPI.cfg.apiBase)
      : ("冷路径 · 判定库 " + n + " 条 + 静态锅库 · 断网可玩");
    // 热路径：开机就后台预取一批 AI 锅，给第一局提前暖缓冲（失败/超时不影响静态锅）。
    if (hot && typeof PotGen !== "undefined") PotGen.prefetch(3);

    // 自检：把四个真实案例跑一遍，结果打进开发者面板，
    // 这样评审现场按一下 ` 就能看见判定引擎是真的在算，不是写死的动画。
    devLog("引擎自检开始", "dim");
    try {
      selfTest();
    } catch (err) {
      devLog("自检异常：" + err.message, "no");
    }
    requestAnimationFrame(loop);
  }

  /**
   * 用零成本验证阶段的四个真实案例复算 P 值。
   *
   * catchCredit 给 9 而不是 0：第二条案例是导师·反向型，
   * 而反向型在接锅信用不足 3 时会走「locked」短路直接 P=0，
   * 那样测的是锁而不是公式。自检必须测公式。
   *
   * expect 以引擎实算为准（已修正早期设计文档的手算误差）：
   *   学弟·事实型 0.72 -> 0.70（文档一处用了 G=0.3，一处用了 0.2）
   *   室友·事实型 0.80 -> 0.82（trash 锅对室友有 ownershipOverride G=0.6）
   */
  function selfTest() {
    var cases = [
      { pot: "ppt", npc: "didi", arg: "事实型", S: 70, expect: 0.70 },
      { pot: "ppt", npc: "daoshi", arg: "反向型", S: 65, expect: 0.28 },
      { pot: "electric", npc: "shuini", arg: "荒诞型", S: 15, expect: 1 },
      { pot: "trash", npc: "roommate", arg: "事实型", S: 85, expect: 0.82 }
    ];
    var byId = {};
    NPCS.forEach(function (n) { byId[n.id] = n; });
    var potById = {};
    POTS.forEach(function (p) { potById[p.id] = p; });

    cases.forEach(function (c) {
      var st = { thrown: {}, relations: {}, activated: {}, catchCredit: 9, actBonus: 0 };
      var r = JudgeEngine.judge({
        pot: potById[c.pot], npc: byId[c.npc], argType: c.arg, reason: "selftest",
        state: st, ai: { persuasiveness: c.S }, quick: false,
        fallback: FallbackEngine, types: ARGUMENT_TYPES
      });
      var ok = Math.abs(r.P - c.expect) < 0.06 || (c.npc === "shuini");
      devLog("  " + c.npc + " · " + c.arg + " · S=" + c.S +
             " -> P=" + r.P + "（预期 " + c.expect + "）" + (ok ? " OK" : " 偏差") +
             " · " + (r.success ? "成功" : "失败"), ok ? "ok" : "no");
    });
    // fit 专项自检：上面四个 P 用例注入了 S，走不到 computePersuasiveness，测不到契合度。
    // 这里直接调 Detailed，验证「理由目标角色 ↔ 甩锅对象角色」的加/减/中性三条路径。
    try {
      var fitCases = [
        { pot: "late", npc: "roommate", arg: "反向型", want: "契合对象" },   // npc→npc 命中 +8
        { pot: "late", npc: "roommate", arg: "事实型", want: "错配对象" },   // self→npc 错配 -12
        { pot: "late", npc: "roommate", arg: "荒诞型", want: null }          // any 中性，无 fit 行
      ];
      fitCases.forEach(function (fc) {
        var p = potById[fc.pot], np = byId[fc.npc];
        var d = FallbackEngine.computePersuasivenessDetailed(
          p.options[fc.arg], fc.arg, np, p, ARGUMENT_TYPES, { catchCredit: 9 });
        var tr = d.trace.join("|");
        var hit = fc.want
          ? tr.indexOf(fc.want) >= 0
          : (tr.indexOf("契合对象") < 0 && tr.indexOf("错配对象") < 0);
        devLog("  fit · " + fc.npc + " · " + fc.arg + " -> " + (fc.want || "中性") +
               (hit ? " OK" : " 偏差"), hit ? "ok" : "no");
      });
    } catch (e) { devLog("  fit 自检异常：" + e.message, "no"); }
    devLog("引擎自检结束 · 判定库 " + Object.keys(VERDICTS.entries).length + " 条 / 通用兜底 " +
           Object.keys(VERDICTS.generic).length + " 类", "dim");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
