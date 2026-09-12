/**
 * 《锅从天降》 连通性 / 模型可用性探针 · GET/POST /api/probe
 *
 * ─────────────────────────────────────────────────────────────
 * 给标题屏「检测模型」按钮用：拿玩家自带的 x-bf-key / x-bf-model
 * （没带则回落服务端 env）真调一次极简 prompt，回答
 * 「这个 key + 模型现在能不能用」。
 *
 * 与 judge / genpot 的关键不同：**上游失败也返回 200**（ok:false + error）。
 * 因为「模型不可用 / key 无效 / 余额不足」是一个需要**展示给用户的正常结论**，
 * 不是服务错误；前端据此提醒用户换 key 或换模型。
 * 只有「连 base+key 都没配」才 503（服务未开通）。
 *
 * 探针 prompt 刻意极简（system 一句话 + user "ping"），把 token 消耗压到最低 ——
 * 它只验证「通不通」，不验证「判得好不好」。
 */

import {
  callGateway,
  clip,
  corsHeaders,
  gatewayConfig,
  originAllowed,
  send,
} from "./_gateway.mjs";

export const config = {
  // 探针是用户点「检测」才触发的一次性请求，给足 30s 不让它半路被 Vercel 掐掉。
  maxDuration: 30,
};

const PROBE_TIMEOUT_MS = Number(process.env.BLAMEFALL_PROBE_TIMEOUT) || 15000;

export default async function handler(req, res) {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") return send(res, 204, {}, cors);
  if (req.method !== "GET" && req.method !== "POST") {
    return send(res, 405, { error: { code: "method_not_allowed", hint: "GET or POST" } }, cors);
  }
  if (!originAllowed(req)) {
    return send(res, 403, { error: { code: "origin_not_allowed" } }, cors);
  }

  const cfg = gatewayConfig(req);
  if (!cfg.configured) {
    return send(res, 503, {
      error: {
        code: "gateway_not_configured",
        keySource: cfg.keySource,
        hint: "服务端未配 BLAMEFALL_API_BASE，且请求未带 x-bf-key。",
      },
    }, cors);
  }

  const r = await callGateway({
    systemPrompt: "你是连通性探针。无论用户说什么，只回复两个大写字母：OK",
    userPrompt: "ping",
    timeoutMs: PROBE_TIMEOUT_MS,
    req,
  });

  if (!r.ok) {
    // 200 + ok:false：把上游错误码原样带给前端去翻译成提醒文案。
    return send(res, 200, {
      ok: false,
      model: cfg.model,
      keySource: cfg.keySource,
      latencyMs: r.latencyMs,
      error: r.errorCode,
    }, cors);
  }

  return send(res, 200, {
    ok: true,
    model: cfg.model,
    keySource: cfg.keySource,
    latencyMs: r.latencyMs,
    reply: clip(r.content, 40),
  }, cors);
}
