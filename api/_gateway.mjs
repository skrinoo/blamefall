/**
 * 网关共享层。
 *
 * 为什么要有这个文件：/api/judge 与 /api/health?probe=1 必须走**同一条**
 * 上游调用路径。如果各写一份，health 报出来的延迟就不是 judge 的真实延迟
 * （timeout 不同、payload 结构不同、max_tokens 不同，测出来的数字全是假的）。
 * 那这个「实测延迟」就没有任何价值 —— 而它恰好是本项目最需要补的数据：
 * 800ms 的延迟预算从头到尾都只是预算，没有实测过。
 *
 * 文件名以 _ 开头：Vercel 不会把 api/_*.mjs 当成端点。
 *
 * ⚠️ 本文件不出现任何密钥明文，全部只从 process.env 读。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── 配置 ────────────────────────────────────────────────────

export const MODEL = process.env.BLAMEFALL_MODEL || "gemini-2.5-flash";

// 裁判用 0.85。批量生成判定库用 0.92（scripts/generate-verdicts.ps1）。
// 两个数字不一样是有意的：裁判要稳，文案要野。别混。
export const TEMPERATURE = num(process.env.BLAMEFALL_TEMPERATURE, 0.85);

// max_tokens = 0 在实测网关上表示「不限制」。
// 若换成严格的 OpenAI 兼容实现，0 会被当成「不许输出任何 token」，届时改成 600。
export const MAX_TOKENS = num(process.env.BLAMEFALL_MAX_TOKENS, 0);

// 上游超时兜底。客户端 1350ms 就会 abort（engine/api.js），
// 但 fetch 断开到函数被回收之间有延迟，6s 用于防止函数在上游卡死时无限挂着。
export const UPSTREAM_TIMEOUT_MS = num(process.env.BLAMEFALL_UPSTREAM_TIMEOUT, 6000);

export const PROMPT_REL = "../prompts/judge-v3.txt";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 只报告「配没配」，绝不报告「配了什么」。这两个端点都是公网可达的。 */
export function gatewayConfig() {
  const base = (process.env.BLAMEFALL_API_BASE || "").replace(/\/+$/, "");
  const key = process.env.BLAMEFALL_API_KEY || "";
  return {
    configured: !!(base && key),
    baseConfigured: !!base,
    keyConfigured: !!key,
    model: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    // 内部用，不出现在任何返回体里
    _base: base,
    _key: key,
  };
}

// ── system prompt ───────────────────────────────────────────

// 模块级缓存：serverless 实例存活期间只读一次文件。
// 部署会换实例，所以不存在「改了 prompt 但缓存不刷新」的问题。
let _promptCache = null;

/**
 * 读 system prompt。两条候选路径：
 *   1. 相对本文件（ESM 下用 import.meta.url 解析，部署态最可靠）
 *   2. 相对 process.cwd()（本地 `vercel dev` 或裸 node 跑时的形态）
 *
 * vercel.json 的 includeFiles 负责把 prompts/ 打进 lambda bundle
 * （fs.readFile 的路径是运行时拼的，Vercel 的静态文件追踪抓不到，必须显式声明）。
 *
 * 两条路径都失败就返回 null，由调用方决定怎么吵闹 —— 绝不静默降级成
 * 一段内置的简化 prompt。那会造出 prompt 的第二份真相。
 */
export async function loadSystemPrompt() {
  if (_promptCache) return _promptCache;

  const candidates = [];
  try {
    candidates.push(fileURLToPath(new URL(PROMPT_REL, import.meta.url)));
  } catch (e) {
    /* import.meta.url 不可用时跳过 */
  }
  candidates.push(path.resolve(process.cwd(), "prompts/judge-v3.txt"));

  for (const p of candidates) {
    try {
      let text = await readFile(p, "utf8");
      // 防御性剥 BOM：提交时本文件是无 BOM 的（Node 需要），
      // 但若有人用 Windows 记事本改过就会带上 BOM，
      // 那时 \uFEFF 会成为 prompt 的第一个字符，模型行为不可预期。
      text = text.replace(/^\uFEFF/, "").trim();
      if (!text) continue;
      _promptCache = { text: text, chars: text.length, lines: text.split("\n").length };
      return _promptCache;
    } catch (e) {
      /* 试下一条候选路径 */
    }
  }
  return null;
}

/**
 * User Prompt，严格按 prompts/judge-v3.md §2 的模板拼。
 * npcDesc 可能为空（抽象 NPC 或调用方没带），那时不能拼出
 * 「甩锅对象：水逆（）」这种空括号。
 */
export function buildUserPrompt({ potText, npcName, npcDesc, reason }) {
  const target = npcDesc ? `${npcName}（${npcDesc}）` : npcName;
  return [
    "判定这一次甩锅。",
    "",
    `锅（背锅事件）：${potText}`,
    `甩锅对象：${target}`,
    `玩家给出的理由：${reason}`,
  ].join("\n");
}

// ── 上游调用 ────────────────────────────────────────────────

/**
 * 调一次网关。judge 与 health 都走这里，因此 health 报出的延迟
 * 就是 judge 的真实延迟。
 *
 * @returns {Promise<Object>} 永不 throw，统一返回结果对象：
 *   { ok, content, latencyMs, usage, errorCode, httpStatus }
 *   errorCode ∈ null | 'not_configured' | 'timeout' | 'unreachable'
 *                    | 'http_<n>' | 'bad_json' | 'empty_content'
 */
export async function callGateway({ systemPrompt, userPrompt, timeoutMs }) {
  const cfg = gatewayConfig();
  const limit = timeoutMs || UPSTREAM_TIMEOUT_MS;

  if (!cfg.configured) {
    return { ok: false, content: null, latencyMs: 0, usage: null, errorCode: "not_configured", httpStatus: null };
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${cfg._base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg._key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(limit),
    });
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const code = e && e.name === "TimeoutError" ? "timeout" : "unreachable";
    // 上游细节只进服务端日志（Vercel 只有部署者能看），不回传公网。
    console.error("[gateway] 请求失败", latencyMs + "ms", e && e.name, e && e.message);
    return { ok: false, content: null, latencyMs, usage: null, errorCode: code, httpStatus: null };
  }

  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 402（余额不足）/ 401（鉴权）必须在日志里看得见原文才能排查。
    console.error("[gateway] HTTP", res.status, text.slice(0, 500));
    return { ok: false, content: null, latencyMs, usage: null, errorCode: "http_" + res.status, httpStatus: res.status };
  }

  let obj;
  try {
    obj = await res.json();
  } catch (e) {
    console.error("[gateway] 响应不是合法 JSON");
    return { ok: false, content: null, latencyMs, usage: null, errorCode: "bad_json", httpStatus: res.status };
  }

  const content = obj && obj.choices && obj.choices[0] && obj.choices[0].message
    ? obj.choices[0].message.content : null;
  const usage = (obj && obj.usage) || null;

  // 这个检查是本项目禁用一切思考型模型的原因：
  // step-3.7-flash 在 max_tokens=2500 下烧掉 4409 completion_tokens，
  // 正式回答却是空的，只回吐思维链。不做这层检查，客户端会拿到空字符串。
  if (!content || !String(content).trim()) {
    console.error("[gateway] 响应里没有 message.content。usage=", JSON.stringify(usage || {}));
    return { ok: false, content: null, latencyMs, usage, errorCode: "empty_content", httpStatus: res.status };
  }

  return { ok: true, content: String(content), latencyMs, usage, errorCode: null, httpStatus: res.status };
}

// ── HTTP 小工具 ─────────────────────────────────────────────

export function clip(s, n) {
  s = String(s == null ? "" : s).trim();
  return s.length > n ? s.slice(0, n) : s;
}

/** Vercel 通常已自动解析 JSON body，但 Content-Type 不对时会给出字符串或 Buffer。 */
export function readBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { return null; }
  } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(b)) {
    try { b = JSON.parse(b.toString("utf8")); } catch (e) { return null; }
  }
  return b && typeof b === "object" && !Array.isArray(b) ? b : null;
}

export function corsHeaders(req) {
  const h = req && req.headers ? req.headers : {};
  return {
    "Access-Control-Allow-Origin": h.origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * 轻量滥用防护。
 *
 * ⚠️ 这**不是安全边界**。Origin / Referer 都能被非浏览器客户端伪造，
 * 它挡住的只是互联网上无脑扫公开端点的那批脚本 —— 而这类脚本
 * 恰好是「演示链接挂三天就被刷爆 token 余额」的主要来源。
 *
 * 未配置 BLAMEFALL_ALLOW_ORIGIN 时不校验，
 * 这样 curl 掐表、本地开发、评委手动试都不会被挡住。
 */
export function originAllowed(req) {
  const allow = process.env.BLAMEFALL_ALLOW_ORIGIN;
  if (!allow) return true;
  const h = (req && req.headers) || {};
  const o = h.origin || h.referer || "";
  if (!o) return true; // 非浏览器请求：不设防，交给上游配额兜底
  try {
    const host = /^https?:/.test(o) ? new URL(o).host : "";
    return allow.split(",").some((a) => {
      a = a.trim();
      return !!a && (host === a || o.indexOf(a) >= 0);
    });
  } catch (e) {
    return false;
  }
}

export function send(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 这两个端点都是实时诊断用的，任何一层缓存都会让「刚改完环境变量再刷一次」失效。
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) res.setHeader(k, extraHeaders[k]);
  res.end(JSON.stringify(obj));
}
