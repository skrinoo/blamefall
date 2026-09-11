/**
 * 《锅从天降》 AI 裁判端点 · POST /api/judge
 *
 * ─────────────────────────────────────────────────────────────
 * 这个文件的设计原则：**薄**。
 * ─────────────────────────────────────────────────────────────
 * 网络、prompt 读取、配置、错误分类全在 api/_gateway.mjs 里。
 * 本文件只做三件事：校验输入、拼 user prompt、把结果映射成 HTTP 响应。
 *
 * 刻意**不做**的事，每一件都有原因：
 *
 * 1. 不做 JSON 字段校验。
 *    返回体是 { raw: "<模型原文>" }，engine/api.js 的 validate() 已经逐条实现了
 *    prompts/judge-v3.md §2 的校验契约并经过实测。服务端再写一套，
 *    两套逻辑迟早漂移 —— 这个项目已经吃过「两处真相」的亏（judge-v3.md §2 的
 *    NPC 清单漏了「前任」，与 npcs.js 对不上）。**校验只在一个地方发生。**
 *
 * 2. 不硬编码 system prompt。
 *    从 prompts/judge-v3.txt 读，那份文件是 prompt 的唯一权威副本，
 *    judge-v3.md §2 只是它的可读展示。硬编码会立刻造出第二份真相。
 *    读不到就 500 吵闹失败，绝不静默降级成一段内置的简化 prompt。
 *
 * 3. 不预判成败、不算 P 值、不出任何数值。
 *    这是本项目被撞了四次才学会的铁律：凡可查表或可规则算出的确定性游戏数据，
 *    一律不让 LLM 输出。服务端自然也不能替引擎做决定。
 *
 * 客户端契约（engine/api.js）：任何非 2xx、超时、空响应都会让它 resolve(null)，
 * 上层立刻切本地兜底引擎，玩家侧完全无感。所以**这里可以放心地失败** ——
 * 宁可吵闹地 500，也不要静默地返回一段凑合的文案。
 *
 * 环境变量见 api/_gateway.mjs 顶部。全部只从 process.env 读，仓库里无明文。
 */

import {
  buildUserPrompt,
  callGateway,
  clip,
  corsHeaders,
  gatewayConfig,
  loadSystemPrompt,
  originAllowed,
  readBody,
  send,
} from "./_gateway.mjs";

export const config = {
  // 不要写 runtime: "nodejs20.x" —— Vercel 已不接受 config 里的 nodejs
  // 运行时值（只认 "edge"），写了直接部署失败；Node 版本由项目设置的
  // Node.js Version 控制。2026-09-11 首次部署就栽在这行上。
  // 客户端 1350ms 就会放弃（engine/api.js 的 CFG.timeout），
  // 这里给 10s 只是防止函数在上游卡死时无限挂着。
  maxDuration: 10,
};

// 输入长度上限。超出**截断**而不是拒绝 —— 玩家体验优先于洁癖，
// 而且 400 字的甩锅理由本身已经够荒谬了，截断不影响判定质量。
const LIMIT_REASON = 400;
const LIMIT_FIELD = 200;

// 错误码 → HTTP 状态。集中在一处，避免同一种上游故障在不同分支里给出不同状态码。
const STATUS_BY_CODE = {
  not_configured: 503,
  timeout: 504,
  unreachable: 504,
  bad_json: 502,
  empty_content: 502,
};

export default async function handler(req, res) {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") return send(res, 204, {}, cors);
  if (req.method !== "POST") {
    return send(res, 405, { error: { code: "method_not_allowed", hint: "POST only" } }, cors);
  }
  if (!originAllowed(req)) {
    return send(res, 403, { error: { code: "origin_not_allowed" } }, cors);
  }

  // 缺配置给 503 而不是 500：这是「服务未开通」，不是「服务出错」。
  // 返回体只说「没配」，不说「配了什么」。
  if (!gatewayConfig().configured) {
    return send(res, 503, {
      error: {
        code: "gateway_not_configured",
        hint: "在部署平台设置 BLAMEFALL_API_BASE 与 BLAMEFALL_API_KEY。" +
              "未配置时游戏会自动切本地兜底引擎，玩家侧无感。",
      },
    }, cors);
  }

  const prompt = await loadSystemPrompt();
  if (!prompt) {
    return send(res, 500, {
      error: {
        code: "prompt_file_missing",
        hint: "读不到 prompts/judge-v3.txt。检查 vercel.json 的 includeFiles 是否把 prompts/ 打进了 bundle。",
      },
    }, cors);
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: { code: "bad_json" } }, cors);

  // reason 是唯一真正由玩家产出的字段，必须有；
  // potText / npcName 缺失时用占位符 —— 少这点上下文模型照样能判论证质量，
  // 为一个占位符把玩家的锅判失败不值得。
  const reason = clip(body.reason, LIMIT_REASON);
  if (!reason) return send(res, 400, { error: { code: "reason_required" } }, cors);

  const r = await callGateway({
    systemPrompt: prompt.text,
    userPrompt: buildUserPrompt({
      potText: clip(body.potText, LIMIT_FIELD) || "（未提供）",
      npcName: clip(body.npcName, LIMIT_FIELD) || "（未提供）",
      npcDesc: clip(body.npcDesc, LIMIT_FIELD),
      reason: reason,
    }),
  });

  if (!r.ok) {
    const status = STATUS_BY_CODE[r.errorCode]
      || (/^http_/.test(r.errorCode || "") ? 502 : 500);
    return send(res, status, {
      error: {
        code: r.errorCode,
        latencyMs: r.latencyMs,
        // usage 只在 empty_content 时有意义（思考型模型烧 token 却不吐正文），
        // 它是排查这类问题的唯一线索，且不含任何密钥。
        usage: r.errorCode === "empty_content" ? r.usage : undefined,
      },
    }, cors);
  }

  // 成功。raw 是客户端唯一会读的字段（engine/api.js 先看 json.raw，
  // 拿到就交给 validate()）；latencyMs / model / usage 是诊断信息，会被客户端忽略。
  //
  // latencyMs 是白送的实测数据：真实延迟一直是本项目没有的那块拼图
  // （800ms 从头到尾都只是预算）。前端开发者面板会把它打出来。
  return send(res, 200, {
    raw: r.content,
    latencyMs: r.latencyMs,
    model: gatewayConfig().model,
    usage: r.usage,
  }, cors);
}
