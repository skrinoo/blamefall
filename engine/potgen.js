/**
 * engine/potgen.js —— AI 锅预生成缓冲（热路径取用 / 冷路径兜底）
 *
 * 一句话：让 AI 在「需要之前」把锅生成好，甩锅那一刻从缓冲里 0ms 取用。
 * 这样「AI 实时生成理由/锅」就不违反「AI 不在热路径」的铁律 —— 生成在后台，
 * 玩家在锅落地的瞬间从不等待网络。
 *
 * 热 / 冷切换 = 是否接入了可用的 AI 通路（复用 JudgeAPI.isOnline()）。两条通路：
 *   通道 A 浏览器直连 —— 玩家认领到了自己的上游 base（directBase）。请求从玩家
 *                       自己的机器发出，**静态宿主（GitHub Pages）与纯前端部署同样可用**。
 *   通道 B 同源代理   —— 本部署有 /api/genpot（服务端 env 决定上游）。
 *   都没有（file:// 直开且没填 key / 没认领）→ 冷路径：enabled()=false，全用静态锅池。
 * 端点不可用 / 返回坏批 / 超时 → 缓冲不增，next() 返回 null，
 * 调用方（game.js choosePotDef）自动落回静态锅池。玩家侧永远无感。
 *
 * 校验与 api/genpot.mjs 同源：五类型缺一不可、targetRole 归一到四类、
 * ownershipOverride 逐键夹 [0,1]、绝不接受任何数值型说服度字段（模型给了也没有
 * 入口写进来 —— sanitize 只挑白名单字段）。
 * 注：通道 A 拿到的原始数组也**走同一个 sanitize** —— 校验只在一个地方发生，
 * 不因为换了通道就多修一份逻辑（那正是「两处真相」的开始）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PotGen = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TYPES = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];
  var ROLES = { self: 1, npc: 1, institution: 1, any: 1 };
  // cast 白名单，与 api/genpot.mjs 的 CAST_IDS、data/npcs.js 的 15 个 id 同源。
  var CAST_IDS = { didi: 1, roommate: 1, moyu: 1, xuezhang: 1, daoshi: 1, jiaowu: 1, fudaoyuan: 1, shitang: 1, suguan: 1, ex: 1, tianqi: 1, shuini: 1, xingzuo: 1, future_self: 1, past_self: 1 };

  var HIGH = 6;        // 缓冲高水位：达到就不再预取（省 token）
  var LOW = 3;         // 低水位：next() 后低于它就后台补。补得早，慢生成才追得上快甩
  // 小批快跑：单次生成量↓ → 延迟↓成功率↑（n=5 一次上千 token、5~15s，又慢又易超时/超额度）。
  // 单口锅质量由 prompt/模型决定，与批量无关 —— 拆小批不降质。
  var FETCH_N = 2;     // 每次请求几口锅（服务端 clamp 1..5）
  var MAX_BUF = 8;     // 缓冲硬上限，防止长时间挂着无限堆积
  var MAX_CONCURRENT = 3;  // 并发预取上限：小批+多流水线，暖缓冲更快且追得上快甩
  var FETCH_TIMEOUT = 9000;  // 慢请求 9s 即失败释放槽位→快速小批重试；对 n=2 足够，避免一条慢请求占槽 20s

  var buffer = [];
  var inflight = 0;    // 在途预取请求数（并发计数，不再是布尔）
  var lastErr = null;

  function online() {
    return typeof JudgeAPI !== "undefined" && JudgeAPI.isOnline && JudgeAPI.isOnline();
  }

  /**
   * 走浏览器直连通道吗？（玩家认领到了自己的上游 base）
   *
   * 直连时锅也必须在**浏览器里**生成 —— 否则「AI 判定在直连、AI 生成锅还在
   * 打本站 /api」会出现两种坏结果：纯静态宿主上生成必然失败（没有 /api），
   * 而标题屏 badge 仍写着「AI 生成锅」→ 又是一次谎报（§37 修的就是这类 bug）。
   */
  function viaDirect() {
    var c = (typeof JudgeAPI !== "undefined" && JudgeAPI.cfg) || {};
    return !!(c.directBase && typeof JudgeAPI.genpotDirect === "function");
  }

  function endpoint() {
    var base = (typeof JudgeAPI !== "undefined" && JudgeAPI.cfg && JudgeAPI.cfg.apiBase) || "";
    return base + "/api/genpot";
  }

  function clip(s, n) { s = String(s == null ? "" : s).trim(); return s.length > n ? s.slice(0, n) : s; }

  /** 洗一口锅。任何硬约束不满足就丢，返回 null。id 缺失则补。 */
  function sanitize(raw, idx) {
    if (!raw || typeof raw !== "object") return null;
    var scene = clip(raw.scene, 12);
    var text = clip(raw.text, 60);
    if (!scene || !text) return null;
    if (!raw.options || typeof raw.options !== "object") return null;

    var options = {}, targetRole = {};
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      var s = clip(raw.options[t], 40);
      if (!s) return null;                     // 五类型缺一不可
      options[t] = s;
      var tr = String((raw.targetRole && raw.targetRole[t]) || "any");
      targetRole[t] = ROLES[tr] ? tr : "any";
    }

    var id = clip(raw.id, 40) || ("gen-" + Date.now().toString(36) + "-" + idx);
    var pot = { id: id, scene: scene, text: text, weight: 1, options: options, targetRole: targetRole, generated: true };
    if (typeof raw.selfish === "boolean") pot.selfish = raw.selfish;

    if (raw.ownershipOverride && typeof raw.ownershipOverride === "object") {
      var oo = {}, k;
      for (k in raw.ownershipOverride) {
        if (!Object.prototype.hasOwnProperty.call(raw.ownershipOverride, k)) continue;
        var v = Number(raw.ownershipOverride[k]);
        if (isFinite(v)) oo[k] = Math.min(1, Math.max(0, v));
      }
      var has = false; for (k in oo) { has = true; break; }
      if (has) pot.ownershipOverride = oo;
    }

    // cast：这口锅「牵扯到谁」，与服务端同源白名单过滤。
    // 目标高亮（game.js）和 ex 判据（judge.js）都读它；缺失则回落到「不过滤」。
    if (Object.prototype.toString.call(raw.cast) === "[object Array]") {
      var cast = [], seen = {}, ci, cid;
      for (ci = 0; ci < raw.cast.length && cast.length < 6; ci++) {
        cid = clip(raw.cast[ci], 40);
        if (CAST_IDS[cid] && !seen[cid]) { seen[cid] = 1; cast.push(cid); }
      }
      if (cast.length) pot.cast = cast;
    }
    return pot;
  }

  /**
   * 后台预取一批锅填入缓冲。永不 throw，永不阻塞游戏。
   * 两条通道：认领到上游 base 走浏览器直连（通道 A），否则走本站 /api/genpot（通道 B）。
   * 两条通道的落地逻辑共用 —— 都是「拿到一批原始锅 → sanitize → 入缓冲」。
   * @param {number} n
   * @returns {Promise<number>} 本次成功入缓冲的锅数
   */
  function prefetch(n) {
    n = n || FETCH_N;
    if (!online() || inflight >= MAX_CONCURRENT || buffer.length >= HIGH) return Promise.resolve(0);
    inflight++;

    /** 把一批原始锅洗净入缓冲，返回新增条数。 */
    function absorb(rawPots) {
      var added = 0;
      if (Array.isArray(rawPots)) {
        for (var i = 0; i < rawPots.length && buffer.length < MAX_BUF; i++) {
          var p = sanitize(rawPots[i], i);
          if (p) { buffer.push(p); added++; }
        }
        if (!added) lastErr = "no_valid_pots";
      } else {
        lastErr = "bad_shape";
      }
      return added;
    }
    function release(added) { inflight--; return added; }

    // ── 通道 A：浏览器直连（玩家自己的 key、自己的网络）──
    if (viaDirect()) {
      return JudgeAPI.genpotDirect(n, FETCH_TIMEOUT)
        .then(function (res) {
          if (!res || !res.ok) { lastErr = (res && res.code) || "bad_shape"; return 0; }
          return absorb(res.pots);
        })
        .catch(function (e) { lastErr = "unreachable:" + (e && e.name ? e.name : e); return 0; })
        .then(release);
    }

    // ── 通道 B：经本站 /api/genpot 转发 ──
    var ctrl = null;
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ctrl = { signal: AbortSignal.timeout(FETCH_TIMEOUT) }; } catch (e) {}

    // 带上玩家凭据（若有），让生成锅的 token 也记在玩家自己账上。
    var opt = ctrl || {};
    var headers = {};
    var jcfg = (typeof JudgeAPI !== "undefined" && JudgeAPI.cfg) || {};
    if (jcfg.apiKey) headers["x-bf-key"] = jcfg.apiKey;
    if (jcfg.model) headers["x-bf-model"] = jcfg.model;
    opt.headers = headers;

    return fetch(endpoint() + "?n=" + n, opt)
      .then(function (resp) {
        if (!resp.ok) { lastErr = "http_" + resp.status; return null; }
        return resp.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.pots)) {
          if (data) lastErr = (data.error && data.error.code) || "bad_shape";
          return 0;
        }
        return absorb(data.pots);
      })
      .catch(function (e) { lastErr = "unreachable:" + (e && e.name ? e.name : e); return 0; })
      .then(release);
  }

  /**
   * 取一口生成锅；缓冲空则返回 null（调用方落回静态锅池）。
   * 取出后若低于低水位，顺手触发一次后台补货。
   */
  function next() {
    if (!buffer.length) { topUp(); return null; }   // 空缓冲也要触发补货，否则开局预取一失败就整局无法自愈
    var pot = buffer.shift();
    topUp();   // 不 await，后台跑
    return pot;
  }

  /**
   * 甩得快时单条预取流水线追不上消耗（旧 LOW=2 + 单 inflight 会让缓冲见底、
   * 后面的锅全落静态语料）。低于低水位就尽量把并发补货开满，让慢生成提前起跑。
   * 空缓冲时由 next() 调用，兼作「开局预取失败后的自愈重试」。
   * 注：online() 必须在循环条件里——离线时 prefetch 会直接 bail、不增 inflight，少了这道门会死循环。
   */
  function topUp() {
    while (online() && buffer.length < LOW && inflight < MAX_CONCURRENT && buffer.length < HIGH) prefetch(FETCH_N);
  }

  return {
    enabled: online,
    prefetch: prefetch,
    next: next,
    sanitize: sanitize,          // 暴露给 smoke / 控制台自测
    size: function () { return buffer.length; },
    clear: function () { buffer.length = 0; },
    lastError: function () { return lastErr; }
  };
});
