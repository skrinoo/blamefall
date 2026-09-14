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
 *
 * ─────────────────────────────────────────────────────────────
 * 双通道（2026-09-14）：让「任意平台的 Key」也能用 AI
 * ─────────────────────────────────────────────────────────────
 * 通道 B（同源代理，现有）：请求发到本站 /api/judge，由服务端转发上游。
 *   base 由服务端 env 固定 —— 所以**玩家填别家的 key 永远无效**（被送到
 *   作者的网关去）。这是「我的 key 明明有效却用不了 AI」的根因。
 *
 * 通道 A（浏览器直连，新增）：请求从**玩家自己的机器**直接打上游。
 *   为什么这样才安全：api/_gateway.mjs:67 拒绝「玩家自定义 base」的理由是
 *   **服务端转发**场景（让服务端接受玩家 base = 开放 SSRF）。浏览器直连时
 *   发请求的是玩家自己的机器、用玩家自己的 key，本项目的服务器完全不参与，
 *   **SSRF 面根本不存在**；而且零函数成本、零配额风险。
 *   顺带解决一个老问题：纯静态宿主（GitHub Pages）没有 /api 后端，
 *   现在也能用 AI 了。
 *
 *   ⚠️ 安全铁律（改动本文件前必读）：CFG.directBase **只允许存在于浏览器**。
 *   绝不要把它作为请求头发给本项目自己的 /api/* —— 服务端一旦接受玩家提供的
 *   base，SSRF 这个面就又搬回来了（api/_gateway.mjs:67 的注释就是为这条而写）。
 *
 * base 不是玩家填的，是 identifyKey() 认出来的 —— 因为实测证明玩家不可能知道
 * base（控制台只写 key / 首页抓不到 / 首页写的还可能是错的 / 同平台可能有多套
 * base 取决于套餐）。详见 data/gateways.js 头注释与
 * docs/任意平台APIKey支持AI-改进方案.md §3.5。
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

    // ── 通道 A（浏览器直连）───────────────────────────────
    // 玩家 key 所属上游的 base。**由 identifyKey() 认领得出**，不是玩家填的
    // （手填只作为开发者后门，见 data/gateways.js）。
    // 非空即启用直连：judgeFree() 会绕过本站 /api/judge，直接打这个 base。
    // ⚠️ 绝不把它发给本站 /api/*（见文件头安全铁律）。
    directBase: "",
    // 直连时发给上游的采样温度，与服务端 TEMPERATURE 保持一致（裁判要稳，
    // 批量生成判定库用的 0.92 不在此列）。
    directTemp: 0.85,
    // system prompt 的取用位置。刻意**不硬编**进 JS —— prompt 的唯一权威副本是
    // prompts/*.txt（api/judge.mjs 与 api/genpot.mjs 也是这么做的，硬编会造出
    // 第二份真相）。相对路径，兼容 GitHub Pages 的子目录部署（/blamefall/prompts/…）。
    promptPath: "prompts/judge-v3.txt",       // 判定用
    genpotPath: "prompts/genpot-v2.txt",      // 生成锅用（与 api/genpot.mjs 同源）
    // 生成锅比判定重（一次出多口），直连时给更长的预算；对齐 PotGen 的 FETCH_TIMEOUT。
    genTimeout: 9000,
    // 认领探测的整体预算。10 个候选并发 + 各自一次 CORS 预检，实测约 0.4–2s。
    // 与 CFG.timeout（1850ms，管单次判定）无关，这是另一件事。
    identifyTimeout: 8000,

    // ── 模型可用性侦测（认领之后：这家平台的哪个模型真能跑判定）──
    // 每个候选模型都要**用玩家的 key 真跑一次判定**（见 probeModelOnce 注释：
    // 不能用 ping 测延迟，那样测出来严重偏低，据此下结论就是新的谎报）。
    // 所以候选数必须封顶 —— 实测 TokenDance 一家就列出 93 个模型。
    probeMax: 6,            // 一批最多实测几个模型
    probeTimeout: 12000,    // 单个模型的实测上限（要能容下 3s+ 的慢网关才测得准）
    probeAllTimeout: 26000, // 一批并发的整体预算；超时拿已回来的结论继续
    probeMaxTokens: 320,    // 实测时给模型的输出上限，避免烧玩家太多 token


    // 是否启用 AI 功能（AI 判定 + AI 生成锅）。标题屏开关、localStorage(bf.aiEnabled) 持久化。
    // 关闭时 isOnline() 恒 false：judgeFree 直接 null、PotGen 不预取、不发任何 AI 请求，
    // 即「无 AI 判定 + 无 AI 生成锅」的纯本地版本（此时留空 = 无 AI 版）。
    aiEnabled: true,

    // 后端能力探测结果（checkBackend() 异步填充）：{ present, authorKey }；null = 未探测。
    // 让标题屏 badge 说真话：静态宿主（GitHub Pages）没有 /api/*，「http 同源」的意图
    // ≠ 真有后端；不探测就会把无 AI 版谎报成「作者兜底 Key」（本次修复的 bug）。
    // 注意：**只代表「有没有同源后端」，与通道 A 无关** —— 直连不需要后端。
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

  // 出厂判定预算快照。玩家用「放宽判定预算」改过之后，清除时要能一键还原。
  var DEFAULT_TIMEOUT = CFG.timeout;
  var DEFAULT_FLIGHT = CFG.flightMs;

  /** 允许页面覆盖配置：window.BLAMEFALL_CONFIG = { apiBase: "https://..." } */
  function applyConfig(over) {
    if (!over) return;
    if (typeof over.apiBase === "string") CFG.apiBase = over.apiBase.replace(/\/+$/, "");
    if (typeof over.apiKey === "string") CFG.apiKey = over.apiKey.trim();
    if (typeof over.model === "string") CFG.model = over.model.trim();
    if (typeof over.directBase === "string") CFG.directBase = over.directBase.replace(/\/+$/, "");
    if (typeof over.promptPath === "string") CFG.promptPath = over.promptPath;
    if (typeof over.aiEnabled === "boolean") CFG.aiEnabled = over.aiEnabled;
    if (typeof over.timeout === "number") CFG.timeout = over.timeout;
    if (typeof over.flightMs === "number") CFG.flightMs = over.flightMs;
    if (typeof over.identifyTimeout === "number") CFG.identifyTimeout = over.identifyTimeout;
    if (typeof over.probeMax === "number") CFG.probeMax = over.probeMax;
    if (typeof over.probeTimeout === "number") CFG.probeTimeout = over.probeTimeout;
    if (typeof over.probeAllTimeout === "number") CFG.probeAllTimeout = over.probeAllTimeout;
    if (typeof over.probeMaxTokens === "number") CFG.probeMaxTokens = over.probeMaxTokens;
  }

  /**
   * 开关 ON + 有可用通路。通路有两条，任一条成立即为 true：
   *   · apiBase   —— 同源后端（通道 B，服务端代理）
   *   · directBase —— 玩家 key 认领出的上游（通道 A，浏览器直连）
   *
   * 把 directBase 也算进来是有意的：静态宿主与 file:// 场景下 apiBase 为空，
   * 但直连**照样能用** —— 这正是「部署到 GitHub Pages 也有 AI」的由来。
   * （更早的版本只认 apiBase，于是「没有 /api 后端」被等同于「没有 AI」。）
   */
  function isEnabled() { return !!CFG.aiEnabled && (!!CFG.apiBase || !!CFG.directBase); }

  /**
   * 真的会走 AI 吗 = 开关 ON + 有通路 + 该通路未被证伪。
   *
   * 两条通路要分开判，因为它们的「证伪」条件不同：
   *   · 直连：CFG.directBase 非空就是确定可用（它是认领/手填的结果，
   *     已经过一次真请求验证）。**不看 CFG.backend** —— 后端存不存在与直连无关。
   *   · 代理：backend=null（开机未探测）时乐观 true；checkBackend 一旦报
   *     present=false（静态宿主 /api/health 404）就翻 false，此后不再发请求。
   */
  function isOnline() {
    if (!isEnabled()) return false;
    if (CFG.directBase) return true;
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

  // ═══════════════ 通道 A：浏览器直连 ═══════════════
  //
  // 这一段是「别人的 Key 也能用」的全部实现。三个函数：
  //   ensurePrompt()  取 system prompt（唯一权威副本是 prompts/judge-v3.txt，不硬编）
  //   identifyKey()   认领：这把 key 属于哪家平台 → 得出 base
  //   judgeDirect()   直连判定
  // 调用关系：judgeFree() 在 CFG.directBase 非空时走 judgeDirect()，否则走 judgeServer()。

  // system prompt 缓存（按路径分键）。整个会话每个 prompt 只取一次
  // （对应服务端 _gateway.mjs 里 _promptCache 那个 Map）。
  var _promptCache = {};
  var _promptInflight = {};

  /**
   * 取 system prompt。**刻意从文件取而不是硬编进 JS** ——
   * prompt 的唯一权威副本是 prompts/*.txt，api/judge.mjs 与 api/genpot.mjs
   * 也是从文件读的。硬编会立刻造出第二份真相，而这个项目已经吃过
   * 「两处真相」的亏（judge-v3.md 的 NPC 清单曾漏掉「前任」，与 npcs.js 对不上）。
   *
   * 相对路径（不是 /prompts/...），这样 GitHub Pages 的子目录部署
   * （/blamefall/prompts/…）也能取到。实测该目录带 Access-Control-Allow-Origin:*。
   *
   * ⚠️ file:// 双击态取不到（Chrome 默认禁止 file:// 的 fetch）——
   * 那时直连会报 prompt_unreachable 并落兜底。这是诚实的边界，
   * 不要用「内联一份 prompt」来绕过，那会把上面那条铁律破掉。
   *
   * @param {String} [path] 默认用 CFG.promptPath（判定用）
   */
  function ensurePrompt(path) {
    path = path || CFG.promptPath;
    if (_promptCache[path]) return Promise.resolve(_promptCache[path]);
    if (_promptInflight[path]) return _promptInflight[path];
    var chain = fetch(path)
      .then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.text();
      })
      .then(function (t) {
        var text = String(t || "").replace(/^\uFEFF/, "").trim();   // 防御性剥 BOM
        if (!text) throw new Error("empty");
        _promptCache[path] = text;
        delete _promptInflight[path];
        return text;
      })
      .catch(function (e) {
        delete _promptInflight[path];   // 失败不缓存，下次还能重试
        throw e;
      });
    _promptInflight[path] = chain;
    return chain;
  }

  /** 与服务端 _gateway.mjs 的 buildUserPrompt 保持一致（同模板，同空括号处理）。 */
  function buildUserPromptDirect(p) {
    var npcName = clipStr(p.npcName, 200) || "（未提供）";
    var npcDesc = clipStr(p.npcDesc, 200);
    var target = npcDesc ? (npcName + "（" + npcDesc + "）") : npcName;
    return [
      "判定这一次甩锅。",
      "",
      "锅（背锅事件）：" + (clipStr(p.potText, 200) || "（未提供）"),
      "甩锅对象：" + target,
      "玩家给出的理由：" + clipStr(p.reason, 400),
    ].join("\n");
  }

  function clipStr(s, n) {
    s = String(s == null ? "" : s).trim();
    return s.length > n ? s.slice(0, n) : s;
  }

  /** 给并发的探测加一个整体预算；超时不再等，拿已回来的结论继续。 */
  function withDeadline(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      promise.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function () { if (!done) { done = true; clearTimeout(t); resolve(null); } }
      );
    });
  }

  /**
   * 单条候选的认领探测。
   *
   * 判据（实测 5/5 成立，零 token）：
   *   POST {base}/chat/completions  {"model":"__bf_probe_nonexistent_model__"}
   *     400 且响应里出现这个假模型名 → **就是这家**（鉴权中间件已通过，
   *        命中的这次调用在「模型不存在」处就被拒 → 零 token 消耗）
   *     401 / 403                  → 不是这家
   *     其它（429/5xx/跨域失败）    → 问不出来，既不算命中也不算排除
   */
  function probeOne(g, key, probeModel, index) {
    var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
    var opt = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ping" }] }),
    };
    if (ctrl) opt.signal = ctrl.signal;

    return fetch(g.base + "/chat/completions", opt)
      .then(function (r) {
        return r.text().catch(function () { return ""; }).then(function (t) {
          return classifyProbe(g, index, r.status, t, probeModel);
        });
      })
      .catch(function (e) {
        // 跨域被挡 / 网络不可达：**不等于「不是这家」**，只等于「问不到」。
        // 区分这两件事很重要 —— 否则一个网络问题会被误报成
        // 「这把 key 认不出来」，把玩家引到错误的排查方向。
        return {
          plat: g.plat, nameZh: g.nameZh, base: g.base, label: g.label || "",
          model: (g.models && g.models[0]) || "",
          index: index, status: null, verdict: "unreachable",
          error: (e && e.name) || "Error", snippet: "",
        };
      });
  }

  function classifyProbe(g, index, status, text, probeModel) {
    var lower = String(text || "").toLowerCase();
    var verdict;
    if (status === 400) {
      // 主判据：响应里回显了我们发的那个不存在的模型名 —— 说明它读到了 model
      // 字段，即**鉴权已经通过**，只是模型名不存在。
      // 辅助判据：「模型 / model」字样（有些平台的报错不回显 model 值）。
      var echoed = lower.indexOf(String(probeModel).toLowerCase()) >= 0;
      verdict = (echoed || /模型|model/.test(lower)) ? "hit" : "unknown";
    } else if (status === 401 || status === 403) {
      verdict = "miss";
    } else {
      verdict = "unknown";   // 429 限流、5xx、其它：说不出是哪家
    }
    return {
      plat: g.plat, nameZh: g.nameZh, base: g.base, label: g.label || "",
      model: (g.models && g.models[0]) || "",
      index: index, status: status, verdict: verdict,
      snippet: String(text || "").slice(0, 120),
    };
  }

  /**
   * 认领一把 Key：它属于哪家平台？→ 得出 base。
   *
   * 这是「玩家不用知道 base」的全部依据。**base 是探测结果，不是玩家输入。**
   * 为什么必须这么做（实测四条反证，详见 data/gateways.js 头注释）：
   *   控制台只写 key 不写 base / 首页 HTML 抓不到 / 首页写的还可能是错的 /
   *   同一平台可能有多套 base 取决于套餐。
   *
   * 候选池条目粒度是「平台 × base 变体」，所以这里**按 plat 聚合**：
   * 某平台只要有一个变体命中就算该平台命中，并记住**命中的那个 base**
   * （而非该平台的第一个 base）。StepFun 就是靠这条区分的
   * （/v1 按量付费 vs /step_plan/v1 订阅，两套都活着）。
   *
   * @param {String} key  玩家输入的 API Key（只用于这一次探测，不落任何地方）
   * @returns {Promise<{ok:Boolean, code:String|null, hits:Array, tried:Array}>}
   *   永不 reject。code ∈ null | no_key | no_pool | unrecognized | all_unreachable
   */
  function identifyKey(key) {
    var GW = G.GATEWAYS;
    var pool = (GW && typeof GW.probeable === "function") ? GW.probeable() : [];
    var probeModel = (GW && GW.PROBE_MODEL) || "__bf_probe_nonexistent_model__";
    key = String(key || "").trim();

    if (!key) return Promise.resolve({ ok: false, code: "no_key", hits: [], tried: [] });
    if (!pool.length) return Promise.resolve({ ok: false, code: "no_pool", hits: [], tried: [] });

    var tried = [];
    var tasks = pool.map(function (g, i) {
      return probeOne(g, key, probeModel, i).then(function (r) { tried.push(r); return r; });
    });

    return withDeadline(Promise.all(tasks), CFG.identifyTimeout).then(function () {
      var hits = [], seenPlat = {};
      tried.sort(function (a, b) { return a.index - b.index; });   // 稳定成候选池顺序
      for (var i = 0; i < tried.length; i++) {
        var t = tried[i];
        if (t.verdict !== "hit" || seenPlat[t.plat]) continue;
        seenPlat[t.plat] = true;
        hits.push(t);
      }
      var reached = tried.filter(function (t) { return t.status !== null; }).length;
      var code = hits.length ? null
        : (reached === 0 ? "all_unreachable" : "unrecognized");
      return { ok: hits.length > 0, code: code, hits: hits, tried: tried };
    });
  }

  /**
   * 通道 A 的判定：直接打上游 {directBase}/chat/completions。
   * 超时与错误码语义对齐 judgeServer()，让上层与「检测」按钮不必区分通道。
   */
  function judgeDirect(p) {
    if (!CFG.model) { fail("no_model"); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        fail("client_timeout", CFG.timeout + "ms");
        resolve(null);
      }, CFG.timeout);

      ensurePrompt().then(function (sys) {
        if (done) return null;
        var opt = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 上游鉴权：玩家自己的 key，走玩家自己的网络，本项目服务器不参与
            "Authorization": "Bearer " + CFG.apiKey,
          },
          body: JSON.stringify({
            model: CFG.model,
            temperature: CFG.directTemp,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: buildUserPromptDirect(p) },
            ],
          }),
        };
        if (ctrl) opt.signal = ctrl.signal;
        return fetch(CFG.directBase + "/chat/completions", opt);
      }).then(function (r) {
        if (done || !r) return;
        if (!r.ok) {
          return r.text().catch(function () { return ""; }).then(function (t) {
            if (done) return;
            done = true; clearTimeout(timer);
            fail("http_" + r.status, t.slice(0, 200));
            resolve(null);
          });
        }
        return r.json().catch(function () {
          if (done) return;
          done = true; clearTimeout(timer);
          fail("bad_json");
          resolve(null);
        }).then(function (j) {
          if (done) return;
          done = true; clearTimeout(timer);
          var raw = (j && j.choices && j.choices[0] && j.choices[0].message)
            ? j.choices[0].message.content : null;
          // 思考型模型只吐思维链、正文为空 —— 这个检查与服务端 callGateway 一致，
          // 是本项目禁用一切思考型模型的原因，不能省。
          if (!raw || !String(raw).trim()) { fail("empty_content"); resolve(null); return; }
          var v = validate(raw);
          if (v) lastError = null;
          else fail("validate_rejected", String(raw).slice(0, 140));
          resolve(v);
        });
      }).catch(function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        var msg = (e && e.message) ? e.message : String(e);
        // prompt 取不到（file:// 双击态、或 prompt 文件缺失）是独立的一种失败：
        // 它跟「上游连不上」完全不同，混在一起会让玩家查错方向。
        fail(/^http_|^empty$/.test(msg) ? "prompt_unreachable" : "unreachable", msg);
        resolve(null);
      });
    });
  }

  /**
   * 直连探针：验证「这个 base + 这把 key + 这个模型」真的能出话。
   * 是服务端 /api/probe 在通道 A 上的对应物，语义刻意对齐（上游失败也算
   * 「探到了结论」，永不 reject），这样「检测」按钮不必区分通道。
   *
   * 用**极简 prompt**而不是 prompts/judge-v3.txt 全文：探的是连通性、鉴权与
   * 「模型会不会只吐思维链」，不是判定质量；1864 字符的 prompt 白烧 token。
   *
   * 超时给到 8s，不占 CFG.timeout（1850ms）—— 探针不阻塞游戏，玩家点在
   * 「检测」上本来就在等，宽一点才有诊断价值（3s+ 的网关才测得出真实延迟）。
   *
   * @returns {Promise<{ok:Boolean, code:String|null, latencyMs:Number,
   *                    model:String, base:String, content:String, snippet:String}>}
   */
  function probeDirect(opts) {
    opts = opts || {};
    var base = String(opts.base || CFG.directBase || "").replace(/\/+$/, "");
    var key = String(opts.key || CFG.apiKey || "").trim();
    var model = String(opts.model || CFG.model || "").trim();
    var mk = function (code, ms, extra) {
      var o = { ok: false, code: code, model: model, base: base,
                latencyMs: ms || 0, content: "", snippet: "" };
      if (extra) for (var k in extra) o[k] = extra[k];
      return o;
    };
    if (!base)  return Promise.resolve(mk("no_base"));
    if (!key)   return Promise.resolve(mk("no_key"));
    if (!model) return Promise.resolve(mk("no_model"));

    var t0 = Date.now();
    var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
    var opt = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: "你是连通性探针，只回复两个大写字母：OK" },
          { role: "user", content: "ping" },
        ],
      }),
    };
    if (ctrl) opt.signal = ctrl.signal;
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }, Math.max(CFG.timeout, 8000));

    return fetch(base + "/chat/completions", opt)
      .then(function (r) {
        return r.text().catch(function () { return ""; }).then(function (t) {
          clearTimeout(timer);
          var ms = Date.now() - t0;
          if (!r.ok) return mk("http_" + r.status, ms, { snippet: String(t || "").slice(0, 160) });
          var j;
          try { j = JSON.parse(t); } catch (e) { return mk("bad_json", ms); }
          var content = (j && j.choices && j.choices[0] && j.choices[0].message)
            ? j.choices[0].message.content : "";
          // 空正文 = 思考型模型只吐思维链（本项目已被它撞过，见文件头 Bug#1）。
          // 必须单独报出来，否则玩家会以为「连上了但游戏还是没 AI」，无从下手。
          if (!content || !String(content).trim()) return mk("empty_content", ms);
          return { ok: true, code: null, model: model, base: base,
                   latencyMs: ms, content: String(content).slice(0, 40), snippet: "" };
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        var code = (e && e.name === "AbortError") ? "timeout" : "unreachable";
        return mk(code, Date.now() - t0, { snippet: (e && e.message) ? String(e.message).slice(0, 160) : "" });
      });
  }

  // ═══════════ 模型可用性侦测：这家平台里哪个模型真能跑判定 ═══════════
  //
  // identifyKey() 只回答「这把 key 属于哪家」。玩家真正要问的是第二问：
  // 「这家平台里，**哪个模型真的能跑本游戏的 AI 判定**」。两个问题不一样，
  // 而且第二问的答案经常是「一个都不行」：
  //
  //   · 平台列出的模型里绝大多数不是对话模型（实测 TokenDance 93 个里有
  //     TTS / 图像 / 视频 / 向量 / 检索 / OCR 一大半），直接调就是 400。
  //   · 思考型模型正文为空（本项目已被撞过，见文件头 Bug#1）。
  //   · 有些模型只支持流式（实测 glm-4.5-air），非流式调用直接失败。
  //   · **延迟**：本游戏 timeout 1850ms < flightMs 2000ms 是硬约束。实测
  //     TokenDance 的 qwen3-max 要 ~3.0s → 判定还没回来就被超时丢弃，
  //     玩家侧看到的仍然是兜底文案，等于「没有 AI」。**这条最隐蔽**：
  //     不实测延迟的话，界面上会显示「已连接、已检测可用」，而游戏里永远
  //     走兜底 —— 正是 §37 修掉的那类谎报。
  //
  // 所以侦测**必须发一次真实判定请求**，不能用 ping：
  //   ping 只让模型生成两个 token，实测延迟会严重偏低（几百 ms），
  //   据此判定「可用」而实际 3s → 又造出一个谎报。
  // 真跑一次 judge-v3.txt 还能顺带回答「出不出合法 JSON」（validate 全过）。
  //
  // token 成本：每个候选一次调用、输出封顶 probeMaxTokens → 一批 ~2k token，
  // 一次性开销，可接受。

  /** 实测用的固定样例输入。**不吃游戏状态** —— 所有模型跑同一道题，耗时可横向比。 */
  var PROBE_JUDGE_SAMPLE = {
    potText: "你把宿舍公共洗衣机弄坏了",
    npcName: "室友",
    npcDesc: "斤斤计较，记性极好",
    reason: "洗衣机本来就是坏的，我只是第一个用它的人",
  };

  /** 肯定不是对话模型的（向量 / 语音 / 图像 / 视频 / 检索 / OCR），先剔除再去排序。 */
  var MODEL_NOT_CHAT = /(embed|rerank|tts|speech|voice|asr|whisper|ocr|seedream|seedance|kling|wan3|happyhorse|i2v|t2v|r2v|video|image|bocha|unifuncs|web-reader|web-search|moderation|dall|flux|stable-diffusion|sora|voicedesign|voiceclone|music|audiogen)/i;

  /** 思考型：只吐思维链、正文为空 → 本项目一律不可用（文件头 Bug#1）。 */
  var MODEL_THINKING = /(thinking|reasoning|reasoner|qwq|deep-research|marco-o|(^|[^a-z])o[1-4]([^0-9]|$)|-r1)/i;

  /**
   * 「名字看起来是快模型」的特征，**只用于排序，不是硬门槛**。
   * -flash / -turbo / -mini / 小参数量 这些是业界通行的快模型命名法，
   * 用它把候选压到 probeMax 个；判不出来还有候选池的推荐模型兜着。
   */
  var MODEL_FAST_HINT = /(flash|turbo|mini|lite|small|air|haiku|speed|fast|instant|tiny|([1-9]|[12][0-9]|3[0-2])b)/i;
  /** 「名字看起来是大/新模型」的减分项：大模型通常更慢。 */
  var MODEL_SLOW_HINT = /(max|plus|pro|ultra|preview|evolving|70b|72b|235b|123b|480b)/i;

  function isChatModel(id) {
    id = String(id || "");
    return !!id && !MODEL_NOT_CHAT.test(id) && !MODEL_THINKING.test(id);
  }

  function modelScore(id) {
    var s = 0;
    if (MODEL_FAST_HINT.test(id)) s += 2;
    if (MODEL_SLOW_HINT.test(id)) s -= 1;
    return s;
  }

  /** 家族键：把 -0731 / -0902 / -preview 这类同代变体折叠成一个，避免占满候选位。 */
  function modelFamily(id) {
    return String(id || "").toLowerCase()
      .replace(/[-_]\d{4}$/, "")
      .replace(/[-_](preview|exp|latest|beta|stable)$/, "");
  }

  /**
   * 候选模型清单：作者挑的（候选池 models）+ 平台自己列的（GET /models）。
   *
   * 为什么要两者合并：`/models` 是本账号可见的**真实**清单（TokenDance 93 个、
   * OpenRouter 445 个），但太大且鱼龙混杂；候选池的 models 是作者实测挑过的
   * 非思考型快模型，量少但准。**作者挑的恒定占前排**，其余按快模型命名法排序。
   *
   * 实测的平台差异（`bf/models_probe.py` → `_models.txt`）：
   *   TokenDance 200 + `ACAO:*`（匿名开放，不带 key 也列得出来）
   *   DeepSeek / SiliconFlow / Moonshot / 智谱 / DashScope / MiniMax / StepFun
   *     无 key 均 401 且带 CORS → **玩家带自己的 key 就能列出他账号的模型**
   *   火山方舟 `/models` 无任何 `Access-Control-*` 头 → 浏览器读不到，
   *     只能回落到候选池的 models（graceful，不报错）
   *   ⚠️ 大平台的 /models 可能很大（OpenRouter 735KB）→ 必须整体读，
   *     截断读取会得到坏 JSON（第一版按 200KB 读 → 误判成「不是 JSON」）
   *
   * @returns {Promise<{ok:Boolean, code:String|null, source:String|null,
   *                    models:Array<String>, total:Number}>} 永不 reject
   *          models 是**排好序**的对话模型清单（调用方直接按批切片）
   */
  function listModels(opts) {
    opts = opts || {};
    var base = String(opts.base || CFG.directBase || "").replace(/\/+$/, "");
    var key = String(opts.key || CFG.apiKey || "").trim();

    var curated = [];
    if (G.GATEWAYS && typeof G.GATEWAYS.byPlat === "function" && opts.plat) {
      var vs = G.GATEWAYS.byPlat(opts.plat), hit = null;
      for (var q = 0; q < vs.length; q++) if (vs[q].base === base) { hit = vs[q]; break; }
      if (!hit && vs.length) hit = vs[0];
      if (hit && hit.models) curated = hit.models.slice();
    }
    if (!base) return Promise.resolve({ ok: false, code: "no_base", source: null, models: curated, total: 0 });

    var headers = { "Accept": "application/json" };
    if (key) headers["Authorization"] = "Bearer " + key;   // 玩家自己的 key，只发给玩家自己的上游
    var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
    var opt = { method: "GET", headers: headers };
    if (ctrl) opt.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, 9000);

    return fetch(base + "/models", opt)
      .then(function (r) {
        return r.text().catch(function () { return ""; }).then(function (t) { return { s: r.status, t: t }; });
      })
      .catch(function () { return { s: null, t: "" }; })
      .then(function (res) {
        clearTimeout(timer);
        var live = [];
        if (res.s === 200) {
          try {
            var j = JSON.parse(res.t);
            var arr = (j && j.data) || (j && j.models)
              || (Object.prototype.toString.call(j) === "[object Array]" ? j : []);
            for (var k = 0; k < arr.length; k++) {
              var it = arr[k];
              var id = (typeof it === "string") ? it
                : (it && (it.id || it.name || it.model));
              if (id) live.push(String(id));
            }
          } catch (e2) { live = []; }
        }
        // 合并去重（作者挑的在前）
        var seen = {}, merged = [];
        var push = function (v) {
          v = String(v == null ? "" : v).trim();
          if (!v || seen[v]) return;
          seen[v] = 1; merged.push(v);
        };
        for (var a = 0; a < curated.length; a++) push(curated[a]);
        for (var b = 0; b < live.length; b++) push(live[b]);

        var chat = merged.filter(isChatModel);
        var ranked = rankModels(curated, chat);
        var source = live.length ? (curated.length ? "both" : "api")
                   : (curated.length ? "pool" : null);
        return {
          ok: ranked.length > 0,
          code: ranked.length ? null : "no_models",
          source: source, models: ranked, total: live.length,
        };
      });
  }

  /** 排序：作者挑的恒定占前排并参与家族去重，其余按「快模型命名法」分数降序。 */
  function rankModels(curated, chat) {
    var inCurated = {}, i;
    for (i = 0; i < curated.length; i++) inCurated[curated[i]] = 1;

    var head = chat.filter(function (m) { return inCurated[m]; });
    var usedFam = {};
    for (i = 0; i < head.length; i++) usedFam[modelFamily(head[i])] = 1;

    var rest = [];
    for (i = 0; i < chat.length; i++) {
      var m = chat[i];
      if (inCurated[m]) continue;
      var fam = modelFamily(m);
      if (usedFam[fam]) continue;      // 同代变体（-0731 / -0902）只留一个，别占满候选位
      usedFam[fam] = 1;
      rest.push({ id: m, s: modelScore(m), i: i });
    }
    rest.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
    return head.concat(rest.map(function (x) { return x.id; }));
  }

  /**
   * 单个模型的可用性实测：**用玩家的 key 真跑一次判定**（真 prompt、真输出）。
   *
   * 不用 ping 的原因见本节头注释 —— ping 只生成两个 token，延迟严重偏低。
   * 这里发的是与 judgeDirect 同一条请求（同 system prompt、同样例输入），
   * 唯一差别是加了 probeMaxTokens 上限（给玩家省钱）。
   *
   * 于是这一次调用同时回答四件事：
   *   ① 这个模型存在且这把 key 能用（401/402/403 会在这里暴露）
   *   ② 它出不出正文（思考型 → empty_content）
   *   ③ 它出不出**合法**判定 JSON（validate 全过 → bad_output 反向定义）
   *   ④ 真实耗时 —— 这是能不能进 1850ms 判定预算的唯一依据
   *
   * @returns {Promise<{model:String, ok:Boolean, code:String|null,
   *                    latencyMs:Number, type:String, snippet:String}>} 永不 reject
   */
  function probeModelOnce(o) {
    var base = String(o.base || "").replace(/\/+$/, "");
    var key = String(o.key || "").trim();
    var model = String(o.model || "");
    var t0 = Date.now();
    var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }, Number(o.timeout) || CFG.probeTimeout);

    var mk = function (code, extra) {
      var r = { model: model, ok: false, code: code, latencyMs: Date.now() - t0, type: "", snippet: "" };
      if (extra) for (var k in extra) r[k] = extra[k];
      return r;
    };

    return ensurePrompt()
      .then(function (sys) {
        var opt = {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
          body: JSON.stringify({
            model: model,
            temperature: CFG.directTemp,
            max_tokens: CFG.probeMaxTokens,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: buildUserPromptDirect(PROBE_JUDGE_SAMPLE) },
            ],
          }),
        };
        if (ctrl) opt.signal = ctrl.signal;
        return fetch(base + "/chat/completions", opt);
      })
      .then(function (r) {
        clearTimeout(timer);
        if (!r) return mk("unreachable");
        if (!r.ok) {
          return r.text().catch(function () { return ""; }).then(function (t) {
            return mk("http_" + r.status, { snippet: String(t || "").slice(0, 160) });
          });
        }
        return r.json().catch(function () { return null; }).then(function (j) {
          var ms = Date.now() - t0;
          if (!j) return mk("bad_json", { latencyMs: ms });
          var raw = (j.choices && j.choices[0] && j.choices[0].message)
            ? j.choices[0].message.content : "";
          if (!raw || !String(raw).trim()) return mk("empty_content", { latencyMs: ms });
          var v = validate(raw);
          if (!v) return mk("bad_output", { latencyMs: ms, snippet: String(raw).slice(0, 160) });
          return { model: model, ok: true, code: null, latencyMs: ms, type: v.argumentType, snippet: "" };
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        return mk((e && e.name === "AbortError") ? "timeout" : "unreachable",
                  { snippet: (e && e.message) ? String(e.message).slice(0, 120) : "" });
      });
  }

  /**
   * 延迟预算判定。本游戏的硬约束是 timeout **必须小于** flightMs
   * （锅飞行时长）—— 反了的话锅已经在 NPC 头上还要干等，肉眼可见地卡。
   * 公式对齐 DEPLOY.md §4：flightMs ≥ p50+200、timeout ≈ flightMs-150。
   */
  function budgetOf(best) {
    var need = best ? (best.latencyMs + 150) : 0;
    return {
      timeout: CFG.timeout,
      flightMs: CFG.flightMs,
      model: best ? best.model : null,
      latencyMs: best ? best.latencyMs : 0,
      enough: !!best && best.latencyMs <= CFG.timeout,
      needMs: need,                 // 该档的 timeout
      needFlightMs: need + 150,     // 配套的 flightMs
    };
  }

  /**
   * 从一组实测结论里挑最优（= 最快的可用模型）并算出预算判定与精确失败码。
   *
   * 单独暴露出来是为了让「再测下一批」能**跨批次取最优**：
   * 玩家点第二批、而第二批恰好全是不可用的模型时，如果只按最新一批算，
   * 上一批已经测出来的可用结论就会被冲掉 —— 玩家视角就是「越测越差、
   * 明明测出过能用的现在又说不行了」。
   *
   * 失败码的精确化也在这里统一：一个都不能用时不要一律说「试过的模型都用不了」
   * ——一把失效的 key 会让每个模型都回 401，这时正确的提示是「Key 无效（401）」。
   * 只有各模型的失败原因互不相同时（说明是模型各自的问题，不是 key 的问题）
   * 才回落笼统的 all_models_failed。
   */
  function bestOf(rows) {
    rows = rows || [];
    var best = null, i;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.ok) continue;
      if (!best || r.latencyMs < best.latencyMs) best = r;
    }
    var code = null;
    if (!best) {
      var kinds = {}, nk = 0;
      for (i = 0; i < rows.length; i++) {
        if (!rows[i] || rows[i].ok) continue;
        var c = rows[i].code || "unknown";
        if (!kinds[c]) { kinds[c] = 0; nk++; }
        kinds[c]++;
      }
      code = (nk === 1 && rows.length) ? Object.keys(kinds)[0] : "all_models_failed";
    }
    return { best: best, budget: budgetOf(best), code: code };
  }

  /**
   * 批量侦测：裁一批候选（默认 probeMax 个）并发实测，给出可用结论。
   *
   * 只裁一批是有意的 —— 实测 TokenDance 一家 93 个模型，全测要烧 3 万 token
   * 且要等一两分钟。分批 + `nextOffset` 让玩家「先测最像快模型的 5 个，
   * 都不行再点下一批」，把成本花在他真正会看的地方。
   *
   * @param {Object} opts  base / key / plat / offset / limit / timeout / allTimeout
   * @returns {Promise<{ok, code, rows, best, budget, source, total, candidates,
   *                    offset, nextOffset}>} 永不 reject
   *          code ∈ null | no_base | no_key | no_models | all_models_failed
   */
  function probeModels(opts) {
    opts = opts || {};
    var base = String(opts.base || CFG.directBase || "").replace(/\/+$/, "");
    var key = String(opts.key || CFG.apiKey || "").trim();
    var empty = function (code) {
      return { ok: false, code: code, rows: [], best: null, budget: budgetOf(null),
               source: null, total: 0, candidates: 0, offset: 0, nextOffset: null };
    };
    if (!base) return Promise.resolve(empty("no_base"));
    if (!key) return Promise.resolve(empty("no_key"));

    var offset = Math.max(0, Math.round(Number(opts.offset) || 0));
    var limit = Math.max(1, Math.round(Number(opts.limit) || CFG.probeMax));

    return listModels({ base: base, key: key, plat: opts.plat }).then(function (lm) {
      if (!lm.models.length) {
        var e = empty("no_models");
        e.source = lm.source; e.total = lm.total;
        return e;
      }
      var batch = lm.models.slice(offset, offset + limit);
      var tasks = batch.map(function (m) {
        return probeModelOnce({ base: base, key: key, model: m, timeout: opts.timeout });
      });
      return withDeadline(Promise.all(tasks), Number(opts.allTimeout) || CFG.probeAllTimeout)
        .then(function (arr) {
          var rows = [];
          for (var i = 0; i < batch.length; i++) {
            rows.push((arr && arr[i]) || { model: batch[i], ok: false, code: "timeout",
                                           latencyMs: 0, type: "", snippet: "" });
          }
          // 可用的排前面，其内按耗时升序 —— 玩家的目光落点就是「最快能用的那个」
          rows.sort(function (a, b) {
            if (a.ok !== b.ok) return a.ok ? -1 : 1;
            return a.latencyMs - b.latencyMs;
          });
          var ob = bestOf(rows);            // 最优 + 预算判定 + 精确失败码（单一真相源）
          var next = (offset + limit < lm.models.length) ? (offset + limit) : null;
          return {
            ok: !!ob.best, code: ob.code,
            rows: rows, best: ob.best, budget: ob.budget,
            source: lm.source, total: lm.total, candidates: lm.models.length,
            offset: offset, nextOffset: next,
          };
        });
    });
  }

  /**
   * 调整判定延迟预算。**只在玩家显式点了「放宽」时才调** ——
   * 代价是锅飞得更久（玩家多等），这是游戏手感上的取舍，不该由程序悄悄替他做。
   * 仍然守住 timeout < flightMs 这条硬约束。
   */
  function setBudget(timeout, flightMs) {
    var t = Math.round(Number(timeout) || 0), f = Math.round(Number(flightMs) || 0);
    if (!(t > 0) || !(f > 0)) return null;
    if (t >= f) f = t + 150;
    CFG.timeout = t; CFG.flightMs = f;
    try {
      var ls = G.localStorage;
      if (ls) { ls.setItem("bf.timeout", String(t)); ls.setItem("bf.flightMs", String(f)); }
    } catch (e) { /* ignore */ }
    return { timeout: t, flightMs: f };
  }

  /** 恢复出厂判定预算（清除里的「同时也重置延迟」用）。 */
  function resetBudget() {
    CFG.timeout = DEFAULT_TIMEOUT; CFG.flightMs = DEFAULT_FLIGHT;
    try {
      var ls = G.localStorage;
      if (ls) { ls.removeItem("bf.timeout"); ls.removeItem("bf.flightMs"); }
    } catch (e) { /* ignore */ }
    return { timeout: CFG.timeout, flightMs: CFG.flightMs };
  }

  /** 剥掉模型可能多包的 ```json 围栏，并截出最外层的 [...]。数组版（judge 用 {} 版）。 */
  function stripFenceArr(raw) {
    var s = String(raw || "").trim();
    var m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) s = m[1].trim();
    var a = s.indexOf("["), b = s.lastIndexOf("]");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return s.trim();
  }

  /**
   * 通道 A 的锅生成：与 api/genpot.mjs 同一条上游调用，只是不经服务端。
   *
   * 为什么这一步必须一起做（第 1 步就做）：标题屏 badge 在有 directBase 时会说
   * 「AI 判定 + AI 生成锅」。若只做判定不做生成，那句话就是**新的谎报** ——
   * 与 §37 修掉的「检测到不可用却仍显示热路径」是同一类 bug。
   * 宁可这一步多写 60 行，也不要让 badge 说假话。
   *
   * **返回原始数组，不在这里 sanitize** —— 校验只在一个地方发生
   * （engine/potgen.js 的 sanitize，与服务端 api/genpot.mjs 的 sanitizePot 同源）。
   * 这里再洗一遍会造出第二份校验逻辑，迟早漂移。
   *
   * @param {Number} n  要几口锅（1..5）
   * @param {Number} [timeoutMs]
   * @returns {Promise<{ok:Boolean, code:String|null, pots:Array, latencyMs:Number}>} 永不 reject
   */
  function genpotDirect(n, timeoutMs) {
    if (!CFG.directBase) return Promise.resolve({ ok: false, code: "no_base", pots: [], latencyMs: 0 });
    if (!CFG.model) return Promise.resolve({ ok: false, code: "no_model", pots: [], latencyMs: 0 });
    n = Math.round(Number(n));
    if (!isFinite(n) || n < 1) n = 2;
    if (n > 5) n = 5;

    var limit = Number(timeoutMs) || CFG.genTimeout;
    var t0 = Date.now();
    var ctrl = ("AbortController" in G) ? new G.AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, limit);
    var stop = function () { if (timer) { clearTimeout(timer); timer = null; } };

    return ensurePrompt(CFG.genpotPath)
      .then(function (sys) {
        var opt = {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.apiKey },
          body: JSON.stringify({
            model: CFG.model,
            temperature: CFG.directTemp,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: "生成 " + n + " 口锅。只输出 JSON 数组，不要任何解释。" },
            ],
          }),
        };
        if (ctrl) opt.signal = ctrl.signal;
        return fetch(CFG.directBase + "/chat/completions", opt);
      })
      .then(function (r) {
        stop();
        var ms = Date.now() - t0;
        if (!r) return { ok: false, code: "unreachable", pots: [], latencyMs: ms };
        if (!r.ok) return { ok: false, code: "http_" + r.status, pots: [], latencyMs: ms };
        return r.json().catch(function () {
          return { ok: false, code: "bad_json", pots: [], latencyMs: ms };
        }).then(function (j) {
          if (j && j.ok === false) return j;   // 提前返回的错误对象
          var raw = (j && j.choices && j.choices[0] && j.choices[0].message)
            ? j.choices[0].message.content : "";
          if (!raw || !String(raw).trim()) return { ok: false, code: "empty_content", pots: [], latencyMs: ms };
          var arr;
          try { arr = JSON.parse(stripFenceArr(raw)); } catch (e) {
            return { ok: false, code: "bad_json", pots: [], latencyMs: ms };
          }
          if (Object.prototype.toString.call(arr) !== "[object Array]") {
            return { ok: false, code: "not_array", pots: [], latencyMs: ms };
          }
          return { ok: true, code: null, pots: arr, latencyMs: ms };
        });
      })
      .catch(function (e) {
        stop();
        return { ok: false, code: (e && e.name === "AbortError") ? "timeout" : "unreachable",
                 pots: [], latencyMs: Date.now() - t0 };
      });
  }

  /**
   * 实时裁判一次自由输入。
   *
   * 通道选择：认领到上游 base 就走浏览器直连（通道 A），否则走同源后端
   * （通道 B，服务端代理）。两条通道的**对外契约完全一致**：resolve 一定是
   * null 或已校验对象，绝不 reject。
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
    if (CFG.directBase) return judgeDirect(p);
    return judgeServer(p);
  }

  /** 通道 B：经本站 /api/judge 转发（服务端 env 决定 base —— 玩家 key 到不了对的地方，见文件头）。 */
  function judgeServer(p) {
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
      var b = ls.getItem("bf.base"); if (b) CFG.directBase = b;
      var ae = ls.getItem("bf.aiEnabled"); if (ae !== null) CFG.aiEnabled = ae !== "0";
      // 玩家放宽过的判定预算要跨会话留住 —— 否则下次打开又变回 1850ms，
      // 而他选的那个模型仍然需要 3s，表现就是「昨天好好的，今天又没 AI 了」。
      var to = parseInt(ls.getItem("bf.timeout"), 10);
      var fl = parseInt(ls.getItem("bf.flightMs"), 10);
      if (to > 0 && fl > 0 && to < fl) { CFG.timeout = to; CFG.flightMs = fl; }
    } catch (e) { /* ignore */ }
  })();

  /**
   * 标题屏保存凭据：写 CFG + localStorage。传空串 = 清除（回落服务端 env key）。
   * 只存玩家自己浏览器，不上报任何地方。
   *
   * @param {String} key
   * @param {String} model
   * @param {String} [base]  通道 A 的上游 base（认领得出的，或开发者后门手填的）。
   *                         传空串即关闭直连、回落同源代理通道。
   */
  function setCredentials(key, model, base) {
    CFG.apiKey = String(key || "").trim();
    CFG.model = String(model || "").trim();
    // base 用 undefined 表示「不改动」：保存 key/model 时不该顺手清掉已认领的 base。
    // 传 "" 才表示「明确关闭直连」。
    if (base !== undefined) CFG.directBase = String(base || "").trim().replace(/\/+$/, "");
    try {
      var ls = G.localStorage;
      if (!ls) return;
      if (CFG.apiKey) ls.setItem("bf.apiKey", CFG.apiKey); else ls.removeItem("bf.apiKey");
      if (CFG.model) ls.setItem("bf.model", CFG.model); else ls.removeItem("bf.model");
      if (base !== undefined) {
        if (CFG.directBase) ls.setItem("bf.base", CFG.directBase); else ls.removeItem("bf.base");
      }
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
    // 通道 A（浏览器直连）
    identifyKey: identifyKey,     // 认领：key → { plat, base, model }
    judgeDirect: judgeDirect,     // 直连判定（judgeFree 内部按 directBase 自动选）
    genpotDirect: genpotDirect,   // 直连生成锅（PotGen 内部按 directBase 自动选）
    probeDirect: probeDirect,     // 直连探针（「检测」按钮在通道 A 上用）
    ensurePrompt: ensurePrompt,   // 预热 prompt（可选，省掉首次判定的一个 RTT）
    // ── 模型可用性侦测（认领之后：哪个模型真能跑判定）──
    listModels: listModels,       // 候选模型清单（池子 + GET /models，已筛选排序）
    probeModels: probeModels,     // 批量实测：一次回答「哪些能用 + 各自多快」
    probeModelOnce: probeModelOnce, // 单个模型的实测（UI 点某一行重测时用）
    bestOf: bestOf,               // 从一组结论里挑最优 + 预算判定（跨批次累加时用）
    setBudget: setBudget,         // 放宽/调整判定预算（timeout / flightMs）
    resetBudget: resetBudget,     // 还原出厂预算
    VALID_TYPES: VALID_TYPES,
    get cfg() { return CFG; }
  };
});
