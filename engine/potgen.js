/**
 * engine/potgen.js —— AI 锅预生成缓冲（热路径取用 / 冷路径兜底）
 *
 * 一句话：让 AI 在「需要之前」把锅生成好，甩锅那一刻从缓冲里 0ms 取用。
 * 这样「AI 实时生成理由/锅」就不违反「AI 不在热路径」的铁律 —— 生成在后台，
 * 玩家在锅落地的瞬间从不等待网络。
 *
 * 热 / 冷切换 = 是否接入 key（复用 JudgeAPI.isOnline()）：
 *   在线（http(s) 同源，部署态有网关）→ 热路径：spawnPot 优先取 AI 生成的锅
 *   离线（file:// 直开，无 apiBase）  → 冷路径：enabled()=false，全用静态锅池
 * 端点不可用 / 返回坏批 / 超时 → 缓冲不增，next() 返回 null，
 * 调用方（game.js choosePotDef）自动落回静态锅池。玩家侧永远无感。
 *
 * 校验与 api/genpot.mjs 同源：五类型缺一不可、targetRole 归一到四类、
 * ownershipOverride 逐键夹 [0,1]、绝不接受任何数值型说服度字段（模型给了也没有
 * 入口写进来 —— sanitize 只挑白名单字段）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PotGen = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TYPES = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];
  var ROLES = { self: 1, npc: 1, institution: 1, any: 1 };

  var HIGH = 8;        // 缓冲高水位：达到就不再预取（省 token）
  var LOW = 4;         // 低水位：next() 后低于它就后台补。补得早，慢生成才追得上快甩
  var FETCH_N = 5;     // 每次请求几口锅（服务端 clamp 1..5，取满以提高单次回填量）
  var MAX_BUF = 12;    // 缓冲硬上限，防止长时间挂着无限堆积
  var MAX_CONCURRENT = 2;  // 并发预取上限：快甩时单条流水线追不上消耗，开第二条
  var FETCH_TIMEOUT = 20000;

  var buffer = [];
  var inflight = 0;    // 在途预取请求数（并发计数，不再是布尔）
  var lastErr = null;

  function online() {
    return typeof JudgeAPI !== "undefined" && JudgeAPI.isOnline && JudgeAPI.isOnline();
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
    return pot;
  }

  /**
   * 后台预取一批锅填入缓冲。永不 throw，永不阻塞游戏。
   * @param {number} n
   * @returns {Promise<number>} 本次成功入缓冲的锅数
   */
  function prefetch(n) {
    n = n || FETCH_N;
    if (!online() || inflight >= MAX_CONCURRENT || buffer.length >= HIGH) return Promise.resolve(0);
    inflight++;
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
        var added = 0;
        if (data && Array.isArray(data.pots)) {
          for (var i = 0; i < data.pots.length && buffer.length < MAX_BUF; i++) {
            var p = sanitize(data.pots[i], i);
            if (p) { buffer.push(p); added++; }
          }
          if (!added) lastErr = "no_valid_pots";
        } else if (data) {
          lastErr = (data.error && data.error.code) || "bad_shape";
        }
        return added;
      })
      .catch(function (e) { lastErr = "unreachable:" + (e && e.name ? e.name : e); return 0; })
      .then(function (added) { inflight--; return added; });
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
