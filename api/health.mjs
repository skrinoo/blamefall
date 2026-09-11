/**
 * 《锅从天降》 健康检查与延迟实测 · GET /api/health
 *
 * 存在的理由，按重要性排序：
 *
 * 1. **补上真实延迟数据。** 客户端 800ms（现 1350ms）的预算从头到尾都只是预算，
 *    从来没有实测过。`?probe=1` 会走与 /api/judge **完全相同**的上游代码路径
 *    （同一个 callGateway、同一个 model / temperature / max_tokens），
 *    所以它报出来的数字就是真实判定的延迟。
 *    `?probe=3` 串行跑三次给 min / median / max —— 单次数字没有意义，
 *    「预算够不够」这个问题的答案是一个分布，不是一个点。
 *
 * 2. **部署后一条命令验证。** 环境变量配错、prompt 文件没进 bundle、
 *    网关余额不足（402），这三种故障在玩家侧全都是「静默走兜底引擎」，
 *    看游戏画面永远发现不了。这个端点让它们变得可见。
 *
 * 3. **演示时的证据。** 评委面前跑一次 probe，AI 的原始输出和延迟一起摆出来。
 *
 * ⚠️ 这个端点公网可达，因此**绝不返回任何配置值**，只返回「配没配」的布尔。
 *    gatewayConfig() 的内部字段带 _ 前缀（_base / _key），
 *    下面显式挑白名单字段返回 —— 图省事写 `gateway: cfg` 就会把密钥泄到公网。
 */

import {
  buildUserPrompt,
  callGateway,
  corsHeaders,
  gatewayConfig,
  loadSystemPrompt,
  originAllowed,
  send,
} from "./_gateway.mjs";

export const config = {
  runtime: "nodejs20.x",
  // 与 PROBE_MAX 对齐：3 次 × 上游兜底 6s = 18s < 20s。
  // 别把这两个数改散 —— 超出计划的 maxDuration 上限会直接部署失败。
  maxDuration: 20,
};

// 固定的探针输入。固定才有可比性 —— 多次 probe 之间、
// 以及不同时间点的 probe 之间，测的必须是同一件事。
//
// 选的是「事实型 + 有可核验依据」的案例：它落在 persuasiveness 的高分区，
// 若模型判成低分或判错类型，说明 prompt 或网关出了问题，信号明确。
const PROBE_INPUT = {
  potText: "小组作业的 PPT 没人做，明天上午就要交",
  npcName: "学弟学妹",
  npcDesc: "讨好型，几乎不会拒绝，回答里常带犹豫和自我说服，从不抱怨",
  reason: "这部分是他上周认领的，我这边已经把数据分析做完了",
};

// 3 次足以给出 min / median / max 的分布，再多就是白烧 token。
const PROBE_MAX = 3;

function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/**
 * 只报告「模型输出能否被解析、有哪些键」，**不判断字段是否合法**。
 *
 * 这个分工是刻意的：合法性裁决权属于 engine/api.js 的 validate()，
 * 它逐条实现了 prompts/judge-v3.md §2 的校验契约。
 * health 在这里再判一次就是第二套校验逻辑，会漂移。
 * health 报告事实，客户端做裁决。
 */
function inspect(content) {
  const out = { contentChars: String(content || "").length, parseable: false, keys: null, parsed: null };
  if (!content) return out;
  let s = String(content).trim();
  // 与 engine/api.js 的 stripFence 同样的宽容处理：prompt 已禁止围栏，但仍要防
  if (s.indexOf("```") === 0) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      out.parseable = true;
      out.keys = Object.keys(o);
      out.parsed = o;
    }
  } catch (e) {
    /* parseable 保持 false */
  }
  return out;
}

export default async function handler(req, res) {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") return send(res, 204, {}, cors);
  if (req.method !== "GET") {
    return send(res, 405, { error: { code: "method_not_allowed", hint: "GET only" } }, cors);
  }
  if (!originAllowed(req)) {
    return send(res, 403, { error: { code: "origin_not_allowed" } }, cors);
  }

  const q = req.query || {};
  const cfg = gatewayConfig();
  const prompt = await loadSystemPrompt();

  // 白名单挑字段。cfg._base / cfg._key 绝不外泄。
  const out = {
    ok: false,
    service: "blamefall-judge",
    endpoints: { judge: "POST /api/judge", health: "GET /api/health?probe=1" },
    gateway: {
      configured: cfg.configured,
      baseConfigured: cfg.baseConfigured,
      keyConfigured: cfg.keyConfigured,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      upstreamTimeoutMs: cfg.upstreamTimeoutMs,
    },
    prompt: prompt
      ? { loaded: true, source: "prompts/judge-v3.txt", chars: prompt.chars, lines: prompt.lines }
      : { loaded: false, source: "prompts/judge-v3.txt", hint: "检查 vercel.json 的 includeFiles" },
  };

  out.ok = cfg.configured && !!prompt;

  // ── probe ────────────────────────────────────────────────
  const n = Math.max(0, Math.min(PROBE_MAX, Number(q.probe) || 0));
  if (n > 0) {
    if (!prompt) {
      out.probe = { skipped: "prompt_file_missing" };
    } else if (!cfg.configured) {
      out.probe = { skipped: "gateway_not_configured" };
    } else {
      const userPrompt = buildUserPrompt(PROBE_INPUT);
      const runs = [];
      // **串行**。并发会让数字偏乐观（网关侧排队消失），
      // 而游戏里本来就是一次一次判的，串行才是要测的那个场景。
      for (let i = 0; i < n; i++) {
        runs.push(await callGateway({ systemPrompt: prompt.text, userPrompt }));
      }

      const okRuns = runs.filter((r) => r.ok);
      const lat = okRuns.map((r) => r.latencyMs);
      const last = runs[runs.length - 1];
      const insp = okRuns.length ? inspect(okRuns[okRuns.length - 1].content) : { contentChars: 0, parseable: false, keys: null, parsed: null };

      out.probe = {
        requested: n,
        succeeded: okRuns.length,
        failed: runs.length - okRuns.length,
        errorCodes: runs.filter((r) => !r.ok).map((r) => r.errorCode),
        latencyMs: lat.length
          ? { min: Math.min.apply(null, lat), median: median(lat), max: Math.max.apply(null, lat),
              avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), all: lat }
          : null,
        contentChars: insp.contentChars,
        parseable: insp.parseable,
        keys: insp.keys,
        // 模型原文。演示时这就是「AI 真的在判」的证据。不含任何密钥。
        sample: okRuns.length ? okRuns[okRuns.length - 1].content : null,
        parsed: insp.parsed,
        usage: last ? last.usage : null,
        input: PROBE_INPUT,
      };

      // 预算对比。budget 由**调用方声明**，服务端不持有前端超时值 ——
      // 否则 engine/api.js 改了 timeout，这里就成了第二份过期真相。
      //   curl 'https://your-app/api/health?probe=3&budget=1350'
      const budget = Number(q.budget);
      if (Number.isFinite(budget) && budget > 0 && lat.length) {
        out.probe.budget = {
          ms: budget,
          medianWithinBudget: median(lat) <= budget,
          allWithinBudget: lat.every((x) => x <= budget),
          note: "客户端的飞行动画长 1500ms，判定只要在动画结束前回来就是零感知成本，" +
                "所以 budget 应当接近 flightMs 而不是越小越好。",
        };
      }
    }
  }

  return send(res, out.ok ? 200 : 503, out, cors);
}
