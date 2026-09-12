/**
 * 《锅从天降》 AI 裁判客户端
 *
 * 只在玩家使用「自由输入」时被调用。快速选项一律走 data/verdicts.js 查表（0ms）。
 *
 * ─────────────────────────────────────────────────────────────
 * 这个文件的唯一职责：把「不靠谱的远端」翻译成「靠谱的本地对象或 null」
 * ─────────────────────────────────────────────────────────────
 * 它对外只暴露 judgeFree()，返回值只有两种：
 *   - 一个通过全部字段校验的对象
 *   - null（超时 / 网络错 / 空响应 / JSON 坏 / 字段越界，一律 null）
 *
 * 上层拿到 null 就切 FallbackEngine，玩家侧完全无感。
 * 「有返回」不等于「可用」—— 这是零成本验证阶段用真实网关换来的教训：
 *   思考型模型 step-3.7-flash 在 max_tokens=2500 下正式回答为空，只回吐思维链。
 *   如果这里不做 !raw.trim() 检查，游戏会拿到空字符串直接崩在气泡上。
 *
 * 配置（部署时改这里，或在页面里先设 window.BLAMEFALL_CONFIG）：
 *   apiBase  形如 "https://your-app.vercel.app"，留空 = 离线模式。
 *            部署态下会被下方的 autoSameOrigin() 自动填成页面自己的 origin，
 *            所以推到 Vercel 就是活的，不需要任何人改配置。
 *   timeout  默认 1850ms。2026-09-11 生产实测（health?probe=3）网关
 *            min/median/max = 1560/1711/2207ms，原 1350ms 预算连 median
 *            都盖不住，按 DEPLOY.md §4 公式重算：flightMs ≥ p50+200 → 2000，
 *            timeout ≈ flightMs-150 → 1850。动画在播，玩家在听解说，
 *            判定在动画期间悄悄回来 → 感知零延迟。
 *            （更早的版本是 800ms/1350ms，把免费窗口白白扔掉了，见 CFG 处注释。）
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.JudgeAPI = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // 工厂函数里拿不到外层 UMD 包装器的 root 形参，必须自己再取一次。
  // （这个错误在浏览器里直接抛 ReferenceError，连带 game.js 整个没启动。）
  var G = (typeof globalThis !== "undefined") ? globalThis
        : (typeof window !== "undefined") ? window : {};

  var VALID_TYPES = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];

  var CFG = {
    apiBase: "",        // 留空 = 离线模式（file:// 双击即玩）；部署态由 autoSameOrigin() 填上

    // 玩家自带的网关凭据（标题屏输入、localStorage 持久化）。
    // 带上后请求头附 x-bf-key / x-bf-model，token 记在玩家自己账上；
    // 留空则回落服务端 env key（作者兜底）。model 留空 = 服务端默认模型。
    apiKey: "",
    model: "",

    // 是否启用 AI 功能（AI 判定 + AI 生成锅）。标题屏开关、localStorage(bf.aiEnabled) 持久化。
    // 关闭时 isOnline() 恒 false：judgeFree 直接 null、PotGen 不预取、不发任何 AI 请求，
    // 即「无 AI 判定 + 无 AI 生成锅」的纯本地版本（此时留空 = 无 AI 版）。
    aiEnabled: true,

    // 后端能力探测结果（checkBackend() 异步填充）：{ present, authorKey }；null = 未探测。
    // 让标题屏 badge 说真话：静态宿主（GitHub Pages）没有 /api/*，「http 同源」的意图
    // ≠ 真有后端；不探测就会把无 AI 版谎报成「作者兜底 Key」（本次修复的 bug）。
    backend: null,

    // 1850 / 2000，不是更早的 1350 / 1500，更不是最初的 800。
    //
    // 2026-09-11 生产实测（gemini-2.5-flash 经 openai-next 网关，
    // health?probe=3&budget=1350）：min 1560 / median 1711 / max 2207。
    // 1350 的预算连 median 都盖不住 —— AI 判定大半被丢弃、退化成兜底文案，
    // 而玩家根本感觉不到动画里多出来的那 0.5 秒。
    //
    // 公式（DEPLOY.md §4）：flightMs ≥ p50+200 = 1911 → 取 2000；
    // timeout ≈ flightMs-150 = 1850。game.js 的自由输入是
    // Promise.all([判定, delay(flightMs)])，总时长 = max(判定耗时, 2000ms)，
    // 判定在这之前的**任何**时刻回来都是零感知成本的。
    //
    // 上限是硬约束：timeout **必须小于** flightMs。反了的话，
    // 锅飞到 NPC 头上之后还要干等几百毫秒才出气泡，那是肉眼可见的卡顿。
    timeout: 1850,      // ms
    flightMs: 2000      // AI 路径的锅飞行时长，用于覆盖延迟
  };

  /** 允许页面覆盖配置：window.BLAMEFALL_CONFIG = { apiBase: "https://..." } */
  function applyConfig(over) {
    if (!over) return;
    if (typeof over.apiBase === "string") CFG.apiBase = over.apiBase.replace(/\/+$/, "");
    if (typeof over.apiKey === "string") CFG.apiKey = over.apiKey.trim();
    if (typeof over.model === "string") CFG.model = over.model.trim();
    if (typeof over.aiEnabled === "boolean") CFG.aiEnabled = over.aiEnabled;
    if (typeof over.timeout === "number") CFG.timeout = over.timeout;
    if (typeof over.flightMs === "number") CFG.flightMs = over.flightMs;
  }

  /** 开关 ON + 有 http origin（部署态）。file:// 或开关关闭都为 false。 */
  function isEnabled() { return !!CFG.aiEnabled && !!CFG.apiBase; }

  /**
   * 真的会走 AI 吗 = 开关 ON + http origin + 后端未被证伪。
   * backend=null（开机未探测）时乐观 true；checkBackend 一旦报 present=false
   * （静态宿主 /api/health 404）就翻 false，此后不再发任何 AI 请求。
   */
  function isOnline() {
    if (!isEnabled()) return false;
    return !CFG.backend || !!CFG.backend.present;
  }

  // ── 可观测性：绝不静默失败 ──────────────────────────
  // 这个项目被「无 AI」bug 反复撞了太多次，根因是每一道闸门失败都静默
  // 降级成同一个「本地兜底」，外面完全看不出是哪一道挂了。lastError 把精确
  // 原因留住：网关错误码（empty_content / http_402 / …）、客户端超时、校验被拒
  // （含原文片段）、网络不可达。开发者面板与「检测」按钮读它，下次「无 AI」
  // 一眼定位，不再猜。fail() 只记录、不影响控制流（仍然 resolve(null) 落兜底）。
  var lastError = null;
  function fail(code, detail) {
    lastError = { code: String(code || "unknown"), detail: detail ? String(detail).slice(0, 200) : null, at: Date.now() };
    try { if (G.console && G.console.warn) G.console.warn("[JudgeAPI] AI 调用失败 →", lastError.code, lastError.detail || ""); } catch (e) {}
  }
  function getLastError() { return lastError; }
  function clearLastError() { lastError = null; }

  /** 剥掉模型可能违规加上的 markdown 围栏（prompt 已禁止，但仍要防） */
  function stripFence(raw) {
    var s = String(raw).trim();
    if (s.indexOf("```") === 0) {
      s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
    }
    // 有些模型会在 JSON 前后加一句废话，截取第一个 { 到最后一个 }
    var a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return s.trim();
  }

  /**
   * 字段级校验。任一不通过即返回 null。
   * 逐条对应 prompts/judge-v3.md §2「前端校验契约」。
   */
  function validate(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;   // Bug#1：思考型模型返回空
    var o;
    try { o = JSON.parse(stripFence(raw)); } catch (e) { return null; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;

    if (VALID_TYPES.indexOf(o.argument_type) < 0) return null;
    // persuasiveness 容错：有些模型（含 gemini 经某些网关）会输出数字字符串 "78"，
    // 旧版一律拒掉 → 静默兜底 → 又一种「有调用记录却无 AI」。宽松强转一次，转不出有限数才拒。
    var pers = o.persuasiveness;
    if (typeof pers === "string" && pers.trim() !== "" && isFinite(Number(pers))) pers = Number(pers);
    if (typeof pers !== "number" || !isFinite(pers)) return null;
    if (pers < 0 || pers > 100) return null;
    if (typeof o.technique_name !== "string" || !o.technique_name.trim()) return null;
    if (typeof o.verdict !== "string" || o.verdict.trim().length < 8) return null;
    if (!o.reaction_success && !o.reaction_fail) return null;

    return {
      argumentType: o.argument_type,
      persuasiveness: Math.round(pers),
      technique: o.technique_name.trim(),
      verdict: o.verdict.trim(),
      reactionSuccess: String(o.reaction_success || "").trim(),
      reactionFail: String(o.reaction_fail || "").trim()
    };
  }

  /**
   * 实时裁判一次自由输入。
   *
   * @param {Object} p
   * @param {String} p.potText    锅的文本
   * @param {String} p.npcName    目标 NPC 名
   * @param {String} p.npcDesc    目标 NPC 性格（拼进 prompt，来自 npcs.js 的 desc）
   * @param {String} p.reason     玩家写的理由
   * @returns {Promise<Object|null>}  resolve 一定是 null 或已校验对象，绝不 reject
   */
  function judgeFree(p) {
    if (!isOnline()) { fail("offline_gate"); return Promise.resolve(null); }   // 离线/无后端：立刻交给兜底引擎

    return new Promise(function (resolve) {
      var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
      var done = false;

      // 超时即弃。后到的响应必须被丢弃，否则会出现「气泡已经显示兜底文案，
      // 半秒后又被 AI 文案覆盖」的闪烁 —— 那是最廉价的一种 bug。
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        fail("client_timeout", CFG.timeout + "ms");
        resolve(null);
      }, CFG.timeout);

      var body = {
        potText: p.potText,
        npcName: p.npcName,
        npcDesc: p.npcDesc || "",
        reason: p.reason
      };

      var headers = { "Content-Type": "application/json" };
      if (CFG.apiKey) headers["x-bf-key"] = CFG.apiKey;
      if (CFG.model) headers["x-bf-model"] = CFG.model;

      var opt = {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      };
      if (ctrl) opt.signal = ctrl.signal;

      fetch(CFG.apiBase + "/api/judge", opt)
        .then(function (r) {
          if (!r.ok) {
            // 关键修复：旧版 `throw → catch → resolve(null)` 把服务端的精确错误码
            // （empty_content / http_402 / …）整个扔掉，于是「无 AI」永远查不到原因。
            // 现在读出 error.code 记进 lastError，再落兜底。
            return r.json().catch(function () { return null; }).then(function (ej) {
              if (done) return;
              done = true; clearTimeout(timer);
              var err = ej && ej.error;
              var code = err ? (typeof err === "object" ? err.code : err) : ("http_" + r.status);
              fail(code || ("http_" + r.status), (err && err.usage) ? ("usage=" + JSON.stringify(err.usage)) : ("HTTP " + r.status));
              resolve(null);
            });
          }
          return r.json().then(function (json) {
            if (done) return;
            done = true; clearTimeout(timer);
            // 后端可以返回已解析对象，也可以返回网关原始字符串，两种都吃
            var raw = (json && typeof json.raw === "string") ? json.raw : JSON.stringify(json && json.data ? json.data : json);
            var v = validate(raw);
            if (v) lastError = null;                                     // 成功：清掉旧错误
            else fail("validate_rejected", String(raw).slice(0, 140));   // 字段不合格：留住原文片段供排查
            resolve(v);
          });
        })
        .catch(function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fail("unreachable", (e && e.message) ? e.message : String(e));
          resolve(null);
        });
    });
  }

  applyConfig(G.BLAMEFALL_CONFIG);

  /** 从 localStorage 读玩家凭据（标题屏保存过就有）。隐私模式等读不到就忽略。 */
  (function loadLocalCreds() {
    try {
      var ls = G.localStorage;
      if (!ls) return;
      var k = ls.getItem("bf.apiKey"); if (k) CFG.apiKey = k;
      var m = ls.getItem("bf.model"); if (m) CFG.model = m;
      var ae = ls.getItem("bf.aiEnabled"); if (ae !== null) CFG.aiEnabled = ae !== "0";
    } catch (e) { /* ignore */ }
  })();

  /**
   * 标题屏保存凭据：写 CFG + localStorage。传空串 = 清除（回落服务端 env key）。
   * 只存玩家自己浏览器，不上报任何地方。
   */
  function setCredentials(key, model) {
    CFG.apiKey = String(key || "").trim();
    CFG.model = String(model || "").trim();
    try {
      var ls = G.localStorage;
      if (!ls) return;
      if (CFG.apiKey) ls.setItem("bf.apiKey", CFG.apiKey); else ls.removeItem("bf.apiKey");
      if (CFG.model) ls.setItem("bf.model", CFG.model); else ls.removeItem("bf.model");
    } catch (e) { /* ignore */ }
  }

  /** 标题屏 AI 开关：写 CFG + localStorage。关闭即纯本地版（不发任何 AI 网络请求）。 */
  function setAiEnabled(on) {
    CFG.aiEnabled = !!on;
    try {
      var ls = G.localStorage;
      if (ls) ls.setItem("bf.aiEnabled", CFG.aiEnabled ? "1" : "0");
    } catch (e) { /* ignore */ }
    return CFG.aiEnabled;
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * 探测后端是否真的存在（以及作者有没有配兜底 key）。
   * 刻意**不带任何凭据头**——这只是能力探测，不能把玩家 key 发给健康检查。
   *
   * 判定原则（修复「冷启动误杀整会话 AI」的关键）：
   *   · 只有 **404** 才是「确定无后端」——GitHub Pages 静态宿主秒回 404。
   *   · 收到任何非 404 响应（200/503/5xx）= 后端确实存在（静态宿主不会给这些）。
   *   · 超时 / 网络错 = 「暂时够不着」，**不是**「无后端」。Vercel 冷启动常要好几秒，
   *     旧版 3.5s 超时→present=false→isOnline 整会话 false→开局就无 AI，就是这个坑。
   *     所以放宽到 8s + 失败重试一次；仍够不着就乐观 present=true（AI 照发，
   *     真不可用时 judgeFree/genpot 各自 catch 落兜底，玩家无感），并标 uncertain 让 badge 说人话。
   */
  function checkBackend() {
    if (!CFG.apiBase) { CFG.backend = { present: false, authorKey: false }; return Promise.resolve(CFG.backend); }
    return probeHealth(0);
  }

  function probeHealth(attempt) {
    var ctrl = null;
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ctrl = { signal: AbortSignal.timeout(8000) }; } catch (e) {}
    return fetch(CFG.apiBase + "/api/health", ctrl || {})
      .then(function (r) {
        if (r.status === 404) return { present: false, authorKey: false, definitive: true };   // 静态宿主，定论
        // 收到非 404 响应即证明后端存在；authorKey 从 health.gateway.keyConfigured 读（503=在但没配 key）
        return r.json().then(function (j) {
          return { present: true, authorKey: !!(j && j.gateway && j.gateway.keyConfigured), definitive: true };
        }).catch(function () { return { present: true, authorKey: false, definitive: true }; });
      })
      .catch(function () { return { present: false, authorKey: false, definitive: false }; })  // 超时/网络错=不确定
      .then(function (b) {
        if (!b.definitive && attempt < 1) return delay(700).then(function () { return probeHealth(attempt + 1); });
        var fin = b.definitive
          ? { present: b.present, authorKey: b.authorKey }
          : { present: true, authorKey: false, uncertain: true };   // 够不着也不杀 AI，乐观在线
        CFG.backend = fin;
        return fin;
      });
  }

  /**
   * 部署态自动同源。
   *
   * 页面若通过 http(s) 提供（部署态），就把 apiBase 指向自己的 origin，
   * 于是推到 Vercel 之后**零配置即启用在线裁判** —— 演示链接是活的，
   * 不需要任何人去改源码或在控制台里设 window.BLAMEFALL_CONFIG。
   *
   * file:// 双击态下 protocol 是 "file:"，不设 apiBase，保持离线模式，
   * 「下载下来双击就能玩、断网也能玩」这条承诺不受影响。
   *
   * 显式配置优先：上面 applyConfig() 已经跑过，apiBase 非空就直接返回。
   *
   * 副作用（可接受）：若把静态站点部署到**没有** /api/judge 的地方
   * （如 GitHub Pages），会发出一次注定 404 的请求。代价为零 ——
   * catch 后 resolve(null) 切兜底引擎，而 Promise.all 里的飞行动画
   * 本来就要播满 1500ms，玩家侧看不出任何区别。
   */
  (function autoSameOrigin() {
    if (CFG.apiBase) return;
    var loc = G.location;
    if (!loc || !loc.protocol) return;
    if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
    CFG.apiBase = loc.origin || (loc.protocol + "//" + loc.host);
  })();

  return {
    judgeFree: judgeFree,
    validate: validate,
    stripFence: stripFence,
    applyConfig: applyConfig,
    setCredentials: setCredentials,
    setAiEnabled: setAiEnabled,
    checkBackend: checkBackend,
    isEnabled: isEnabled,
    isOnline: isOnline,
    getLastError: getLastError,
    clearLastError: clearLastError,
    VALID_TYPES: VALID_TYPES,
    get cfg() { return CFG; }
  };
});
