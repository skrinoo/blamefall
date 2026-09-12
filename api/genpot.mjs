/**
 * 《锅从天降》 锅生成端点 · GET/POST /api/genpot
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么有它：旧锅池的 5 条快速理由是「锅×类型」写死的，且常常与甩锅对象
 * 错位（甩给室友的理由其实在怪自己）。本端点让 AI 现场生成带 targetRole 标注的
 * 新锅，客户端在「需要之前」预取填缓冲，甩锅那一刻仍从缓冲里 0ms 取用 ——
 * AI 在冷路径生成，热路径照旧查缓冲，铁律不破。
 * ─────────────────────────────────────────────────────────────
 * 与 judge.mjs 一样刻意保持「薄」：网络/配置/prompt 读取全在 _gateway.mjs。
 *
 * 与 judge.mjs 不同的一点：**这里服务端做校验**。原因是客户端 PotGen 也会校验，
 * 但生成端点吐的是一整批结构化数据，服务端先把明显非法的锅筛掉，能让坏批
 * 不浪费客户端往返；两端校验同源（同一套 ROLES / 五类型），漂移风险可控。
 *
 * 失败一律吵闹（502/503/500），客户端 PotGen 收到非 2xx 就 resolve 空批，
 * 缓冲不增，游戏自动用静态锅池 —— 玩家侧完全无感。
 *
 * 环境变量见 api/_gateway.mjs 顶部。全部只从 process.env 读，仓库里无明文。
 */

import {
  callGateway,
  clip,
  corsHeaders,
  gatewayConfig,
  loadPrompt,
  originAllowed,
  send,
} from "./_gateway.mjs";

export const config = {
  // 生成比判定重（一次出多口锅，token 多），给到 30s；这是后台预取，
  // 不卡游戏。同样不要写 runtime（Vercel 只认 "edge"，写 nodejs 直接部署失败）。
  maxDuration: 30,
};

const PROMPT_REL = "../prompts/genpot-v1.txt";
const TYPES = ["事实型", "情感型", "转移型", "反向型", "荒诞型"];
const ROLES = new Set(["self", "npc", "institution", "any"]);

// 生成上游比判定慢，给它比 judge 更长的兜底超时（客户端不阻塞，无所谓等）。
const GEN_TIMEOUT_MS = Number(process.env.BLAMEFALL_GEN_TIMEOUT) || 22000;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** 剥掉模型可能多包的 ```json 围栏，返回纯 JSON 文本。 */
function stripFence(s) {
  s = String(s || "").trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1].trim();
  return s;
}

/**
 * 把模型吐的一口锅洗成引擎能直接用的 def。任何一条硬约束不满足就整口丢弃。
 * @returns {Object|null}
 */
function sanitizePot(raw, idx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const scene = clip(raw.scene, 12);
  const text = clip(raw.text, 60);
  if (!scene || !text) return null;

  const opts = (raw.options && typeof raw.options === "object") ? raw.options : null;
  if (!opts) return null;

  const options = {};
  const targetRole = {};
  for (const t of TYPES) {
    const s = clip(opts[t], 40);
    if (!s) return null;                 // 五类型缺一不可
    options[t] = s;
    const tr = String((raw.targetRole && raw.targetRole[t]) || "any");
    targetRole[t] = ROLES.has(tr) ? tr : "any";
  }

  const pot = { id: "gen-" + Date.now().toString(36) + "-" + idx, scene: scene, text: text, weight: 1, options: options, targetRole: targetRole };
  if (typeof raw.selfish === "boolean") pot.selfish = raw.selfish;

  // ownershipOverride：唯一允许的数值字段，逐键夹到 [0,1]，非数值键丢弃。
  if (raw.ownershipOverride && typeof raw.ownershipOverride === "object" && !Array.isArray(raw.ownershipOverride)) {
    const oo = {};
    for (const k of Object.keys(raw.ownershipOverride)) {
      const v = num(raw.ownershipOverride[k], NaN);
      if (Number.isFinite(v)) oo[k] = Math.min(1, Math.max(0, v));
    }
    if (Object.keys(oo).length) pot.ownershipOverride = oo;
  }

  return pot;
}

export default async function handler(req, res) {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") return send(res, 204, {}, cors);
  if (req.method !== "GET" && req.method !== "POST") {
    return send(res, 405, { error: { code: "method_not_allowed", hint: "GET or POST" } }, cors);
  }
  if (!originAllowed(req)) {
    return send(res, 403, { error: { code: "origin_not_allowed" } }, cors);
  }

  // 缺配置给 503（服务未开通，不是出错）。客户端据此判定「冷路径」。
  if (!gatewayConfig(req).configured) {
    return send(res, 503, {
      error: { code: "gateway_not_configured", hint: "未配 BLAMEFALL_API_BASE/KEY，游戏自动用静态锅池。" },
    }, cors);
  }

  const prompt = await loadPrompt(PROMPT_REL);
  if (!prompt) {
    return send(res, 500, {
      error: { code: "prompt_file_missing", hint: "读不到 prompts/genpot-v1.txt。检查 vercel.json 的 includeFiles。" },
    }, cors);
  }

  // n 从 query 或 body 取，夹到 1..5。GET ?n=3 最省事（客户端预取用）。
  let n = 3;
  try {
    const u = new URL(req.url, "http://x");
    n = clampInt(u.searchParams.get("n"), 1, 5);
  } catch (e) { /* URL 解析失败就用默认 */ }
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    n = clampInt(req.body.n, 1, 5);
  }

  const r = await callGateway({
    systemPrompt: prompt.text,
    userPrompt: "生成 " + n + " 口锅。只输出 JSON 数组，不要任何解释。",
    timeoutMs: GEN_TIMEOUT_MS,
    req,
  });

  if (!r.ok) {
    const status = ({ not_configured: 503, timeout: 504, unreachable: 504, bad_json: 502, empty_content: 502 })[r.errorCode]
      || (/^http_/.test(r.errorCode || "") ? 502 : 500);
    return send(res, status, { error: { code: r.errorCode, latencyMs: r.latencyMs, usage: r.usage || undefined } }, cors);
  }

  // 解析 + 逐口校验。整批解析失败给 502；解析成功但没一口合格给 no_valid_pots。
  let arr;
  try {
    arr = JSON.parse(stripFence(r.content));
  } catch (e) {
    return send(res, 502, { error: { code: "bad_json", latencyMs: r.latencyMs, snippet: clip(r.content, 200) } }, cors);
  }
  if (!Array.isArray(arr)) {
    return send(res, 502, { error: { code: "not_array", latencyMs: r.latencyMs } }, cors);
  }

  const pots = [];
  for (let i = 0; i < arr.length; i++) {
    const p = sanitizePot(arr[i], i);
    if (p) pots.push(p);
  }
  if (!pots.length) {
    return send(res, 502, { error: { code: "no_valid_pots", latencyMs: r.latencyMs, got: arr.length } }, cors);
  }

  return send(res, 200, {
    pots: pots,
    requested: n,
    returned: pots.length,
    latencyMs: r.latencyMs,
    model: gatewayConfig(req).model,
  }, cors);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}
