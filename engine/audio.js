// ═══════════════════════════════════════════════════════════════
// engine/audio.js — 《锅从天降》音频引擎
//
// 职责：
//   1. BGM：四幕音乐（act1_fun/act2_tight/act3_peak/act4_outro）
//      随游戏切幕自动切换，段间交叉淡化(crossfade)消除硬切。
//   2. 音量：可编程调节（bgm 与 sfx 分离），支持淡入淡出。
//   3. SFX：短音效即时触发（甩锅/接锅/手滑/高潮/结尾/背锅/点击）。
//
// 设计要点：
//   - 全部走 Web Audio API（GainNode 控制音量，不用 <audio> 的 volume）。
//   - 懒加载：首次进入游戏才初始化 AudioContext（规避浏览器自动播放策略，
//     也避免在用户点击开始前就加载 800KB 音频）。
//   - 降级安全：任何异常都不应中断游戏主循环。
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  var AUDIO_DIR = "assets/audio/";

  // 四幕 BGM 映射（act: 1~4）
  var BGM = {
    1: "act1_fun_m.ogg",
    2: "act2_tight_m.ogg",
    3: "act3_peak_m.ogg",
    4: "act4_outro_m.ogg"
  };

  // 标题面待机 BGM（主菜单）
  var TITLE_BGM = "title_menu_m.ogg";

  // SFX 映射（动作名 -> 文件）
  var SFX = {
    whoosh: "whoosh.wav",   // 甩锅出手
    catch:  "catch.wav",    // 接锅
    slip:   "slip.wav",     // 手滑
    ending: "ending.wav",   // 结尾锅
    blame:  "blame.wav",    // 背锅结算
    click:  "click.wav"     // UI 点击
  };

  var ctx = null;            // AudioContext
  var masterGain = null;     // 总音量
  var bgmGain = null;        // BGM 音量（整体）
  var sfxGain = null;        // SFX 音量（整体）

  var bgmNodes = {};         // act -> {buffer, source, gain}
  var sfxBuffers = {};       // name -> AudioBuffer
  var loaded = false;        // 是否已加载完所有音频

  var curAct = 0;            // 当前播放的幕
  var pendingAct = 0;        // 待播放的幕（音频未就绪时缓存）
  var fadeTime = 1.2;        // BGM 切换 crossfade 秒数
  var titleBuffer = null;    // 标题面 BGM 的 AudioBuffer
  var titleSource = null;    // 标题面 BGM 的 source
  var titleGain = null;      // 标题面 BGM 的 gain
  var playingTitle = false;  // 当前是否在播标题 BGM
  var pendingTitle = false;  // 待播放标题 BGM（未就绪时缓存）

  // ── 音量参数（0~1，可编程 + 可持久化）──
  // 用户可调：整体 BGM / 整体 SFX / 静音
  var bgmVolume = 0.55;      // 用户设置的 BGM 音量
  var sfxVolume = 0.8;       // 用户设置的 SFX 音量
  var muted = false;         // 是否静音（masterGain=0）
  // 内部相对增益：各段/音效的"相对响度"，乘在用户音量之上
  var relTitle = 0.72;       // 标题待机相对音量（偏低）
  var relAct1 = 0.80;        // 第一幕相对音量（偏低）
  var relActOther = 1.0;     // 其他幕相对音量
  var relClick = 1.6;        // click 音效相对音量（调大，原声太小）
  var pausedDuck = 0.4;      // 暂停时 BGM 压到 40%
  var ducked = false;        // 当前是否处于暂停压音状态

  // ── 工具 ──────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function loadBuffer(url, cb) {
    return fetch(AUDIO_DIR + url)
      .then(function (r) { if (!r.ok) throw new Error(url + " " + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) { cb(buf); })
      .catch(function (e) { /* 静默降级：单个音频加载失败不影响游戏 */ });
  }

  // ── 初始化（必须在用户手势后调用，首次游戏开始时触发）────────
  function init() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // 浏览器不支持，静默降级

    ctx = new AC();

    // 节点链：source -> bgmGain -> masterGain -> destination
    //         source -> sfxGain -> masterGain -> destination
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1.0;
    masterGain.connect(ctx.destination);

    bgmGain = ctx.createGain();
    bgmGain.gain.value = bgmVolume * (ducked ? pausedDuck : 1.0);
    bgmGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = sfxVolume;
    sfxGain.connect(masterGain);

    // 预加载音频：标题 BGM 优先（立即能播），其余并行后台加载
    var pending = 0;
    function markLoaded() {
      if (--pending === 0) {
        loaded = true;
        // 其余音频全部就绪后，补播 pendingAct（首次 playBgm 因未加载而跳过的场景）
        if (pendingAct && bgmNodes[pendingAct] && bgmNodes[pendingAct].buffer) {
          playBgm(pendingAct);
        }
      }
    }
    // 标题面 BGM：单独优先加载，一就绪就补播（不等其他文件，消除"待机等音乐"延迟）
    loadBuffer(TITLE_BGM, function (buf) {
      titleBuffer = buf;
      if (pendingTitle) playTitle();
    });
    [1, 2, 3, 4].forEach(function (act) {
      pending++;
      loadBuffer(BGM[act], function (buf) { bgmNodes[act] = { buffer: buf }; markLoaded(); });
    });
    Object.keys(SFX).forEach(function (name) {
      pending++;
      loadBuffer(SFX[name], function (buf) { sfxBuffers[name] = buf; markLoaded(); });
    });

    // 若 ctx 被暂停（浏览器策略），resume
    if (ctx.state === "suspended") ctx.resume();
  }

  // ── BGM 播放 / 切换 ────────────────────────────────────
  function playBgm(act) {
    if (!ctx) { pendingAct = act; return; }                    // ctx 未就绪 → 缓存
    if (!bgmNodes[act] || !bgmNodes[act].buffer) { pendingAct = act; return; } // 音频未加载 → 缓存
    if (act === curAct) return; // 已在播这一幕

    var now = ctx.currentTime;

    // 若标题 BGM 在播，先淡出停掉
    stopTitle(now);

    // 停止当前幕（带淡出）
    if (bgmNodes[curAct] && bgmNodes[curAct].source) {
      var old = bgmNodes[curAct];
      try {
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setValueAtTime(old.gain.gain.value, now);
        old.gain.gain.linearRampToValueAtTime(0, now + fadeTime);
        old.source.stop(now + fadeTime + 0.05);
      } catch (e) { /* 已停止则忽略 */ }
    }

    // 启动新幕（带淡入，淡入目标 = 该幕相对音量）
    var rel = (act === 1) ? relAct1 : relActOther;
    var src = ctx.createBufferSource();
    src.buffer = bgmNodes[act].buffer;
    src.loop = true; // 每幕内循环，直到切幕

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(rel, now + fadeTime);
    src.connect(g);
    g.connect(bgmGain);
    src.start(now);

    bgmNodes[act].source = src;
    bgmNodes[act].gain = g;
    curAct = act;
  }

  // ── 标题面 BGM ────────────────────────────────────────
  function stopTitle(now) {
    if (!titleSource) return;
    try {
      titleGain.gain.cancelScheduledValues(now);
      titleGain.gain.setValueAtTime(titleGain.gain.value, now);
      titleGain.gain.linearRampToValueAtTime(0, now + fadeTime);
      titleSource.stop(now + fadeTime + 0.05);
    } catch (e) { /* 已停止则忽略 */ }
    titleSource = null;
    titleGain = null;
    playingTitle = false;
  }

  function playTitle() {
    if (!ctx) { pendingTitle = true; return; }
    if (!titleBuffer) { pendingTitle = true; return; }
    if (playingTitle) return;

    var now = ctx.currentTime;

    // 停掉当前游戏 BGM（带淡出）
    if (bgmNodes[curAct] && bgmNodes[curAct].source) {
      var old = bgmNodes[curAct];
      try {
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setValueAtTime(old.gain.gain.value, now);
        old.gain.gain.linearRampToValueAtTime(0, now + fadeTime);
        old.source.stop(now + fadeTime + 0.05);
      } catch (e) { /* 已停止则忽略 */ }
    }
    curAct = 0;

    // 启动标题 BGM（淡入 + 循环，淡入目标 = 标题相对音量）
    var src = ctx.createBufferSource();
    src.buffer = titleBuffer;
    src.loop = true;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(relTitle, now + fadeTime);
    src.connect(g);
    g.connect(bgmGain);
    src.start(now);

    titleSource = src;
    titleGain = g;
    playingTitle = true;
    pendingTitle = false;
  }

  // ── SFX 触发 ──────────────────────────────────────────
  function playSfx(name) {
    if (!ctx || !sfxBuffers[name]) return;
    var src = ctx.createBufferSource();
    src.buffer = sfxBuffers[name];
    // click 单独调大（原声太小），其他音效走 1.0
    var g = ctx.createGain();
    g.gain.value = (name === "click") ? relClick : 1.0;
    src.connect(g);
    g.connect(sfxGain);
    src.start(ctx.currentTime);
  }

  // ── 音量控制（可编程 + 可持久化）──────────────────────
  function applyBgmGain() {
    // 实际 BGM 增益 = 用户音量 × 暂停压音系数
    if (bgmGain) bgmGain.gain.value = bgmVolume * (ducked ? pausedDuck : 1.0);
  }
  function setBgmVolume(v) {
    bgmVolume = v;
    applyBgmGain();
  }
  function setSfxVolume(v) {
    sfxVolume = v;
    if (sfxGain) sfxGain.gain.value = v;
  }
  function setMasterVolume(v) {
    if (masterGain) masterGain.gain.value = v;
  }

  // 静音切换（静音不影响各音量参数，仅 masterGain 归零）
  function setMuted(m) {
    muted = !!m;
    if (masterGain) masterGain.gain.value = muted ? 0 : 1;
    try { localStorage.setItem("bf.muted", muted ? "1" : "0"); } catch (e) { /* 隐私模式无 localStorage 时静默降级 */ }
  }
  function isMuted() { return muted; }
  function toggleMuted() {
    setMuted(!muted);
    return muted;
  }
  // 启动时从 localStorage 读取静音偏好
  try {
    var savedMuted = localStorage.getItem("bf.muted");
    if (savedMuted === "1") muted = true;
  } catch (e) { /* 隐私模式 / 异常时静默降级 —— 默认非静音 */ }

  // 暂停压音：暂停时 BGM 音量压到 pausedDuck，恢复时还原
  function setPaused(on) {
    ducked = !!on;
    applyBgmGain();
  }

  // ── 对外接口 ──────────────────────────────────────────
  window.BFAudio = {
    init: init,
    playBgm: playBgm,      // 切幕时调用，传 act(1~4)
    playTitle: playTitle,  // 标题面待机 BGM（主菜单）
    playSfx: playSfx,      // 触发音效，传动作名
    setBgmVolume: setBgmVolume,
    setSfxVolume: setSfxVolume,
    setMasterVolume: setMasterVolume,
    setMuted: setMuted,    // 静音开关
    toggleMuted: toggleMuted, // 切换静音（并持久化），返回新状态
    setPaused: setPaused,  // 暂停压音（暂停时 BGM 减弱）
    isMuted: isMuted,
    get ready() { return loaded; },
    get bgmVolume() { return bgmVolume; },
    get sfxVolume() { return sfxVolume; },
    // 诊断接口（只读）：供验证/排查用，不影响游戏逻辑
    _diag: function () {
      return {
        hasCtx: !!ctx,
        ctxState: ctx ? ctx.state : "NONE",
        titleLoaded: !!titleBuffer,
        playingTitle: playingTitle,
        bgmLoaded: Object.keys(bgmNodes).filter(function (a) { return bgmNodes[a].buffer; }).map(Number),
        sfxLoaded: Object.keys(sfxBuffers),
        curAct: curAct,
        pendingAct: pendingAct,
        loaded: loaded,
        bgmVolume: bgmVolume,
        sfxVolume: sfxVolume,
        muted: muted,
        ducked: ducked
      };
    }
  };
})();
