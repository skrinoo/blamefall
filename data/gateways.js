/**
 * 《锅从天降》 候选平台池 —— 「不知道 key 是哪家的」也能用 AI
 *
 * ─────────────────────────────────────────────────────────────
 * 这个文件解决的是什么问题（以及为什么不是「让玩家填 base」）
 * ─────────────────────────────────────────────────────────────
 * 玩家粘一把 key，程序**自己认领**它属于哪家平台，然后浏览器直连那家上游。
 * 玩家全程不需要知道 base URL 是什么 —— 因为实测证明他不可能知道：
 *
 *   ① 控制台只写 key，不写 base。StepFun 的 Base URL 在「用户中心 → Step Plan
 *      接入信息」，不在「接口密钥」页。玩家在拿 key 的地方找 base，永远找不到。
 *   ② 首页 HTML 里也抓不到。实测抓 5 家首页（TokenDance 1874 字节 / DeepSeek
 *      2803 字节是 SPA 壳），base 形状的串 0 命中 → 「让玩家粘个网址、程序去抓」
 *      这条路也不通。
 *   ③ 首页偶尔给出**错的** base。TokenDance 首页装饰文案写着
 *      `baseURL: "tokendance.space"`，实测 POST 它会返回 405 Not Allowed。
 *      真地址 `/gateway/v1` 只出现在 curl 示例里（等于要求玩家会读 curl）。
 *   ④ 同一平台可能有多套 base，选哪套取决于套餐 —— StepFun 的 `/v1`（按量付费）
 *      与 `/step_plan/v1`（Step Plan 订阅）**两套都活着**（无 key 探测都是 401）。
 *
 * 本质：base 是「开发者文档级信息」，不是「控制台用户级信息」。
 * 平台把 key 放控制台显眼处（因为要复制），把 base 放文档/代码示例里
 * （因为它假设读到这里的人会调 API）。**所以 base 不会出现在玩家会看的地方。**
 *
 * 结论：**别问玩家，让程序认领。** 本文件就是认领用的候选池。
 *
 * ─────────────────────────────────────────────────────────────
 * 条目粒度 = 「平台 × base 变体」，不是「平台」
 * ─────────────────────────────────────────────────────────────
 * 由上面第 ④ 条推出：一个平台可能对应多条 base。同平台的多个变体都进池，
 * 认领时**按 plat 字段聚合** —— 任一变体命中即该平台命中，并记住**命中的那个
 * base**（而不是该平台的第一个 base）。玩家依旧什么都不用填。
 *
 * ─────────────────────────────────────────────────────────────
 * 认领判据（实测 5/5 成立，零 token 消耗，76–350ms）
 * ─────────────────────────────────────────────────────────────
 *   POST {base}/chat/completions  {"model": "__bf_probe_nonexistent_model__"}
 *     401 / 403          → 不是这家（鉴权没过）
 *     400「模型不存在」   → 就是这家（鉴权已通过，只是模型名不存在）
 * 零 token 的原因：鉴权中间件先于模型校验，命中的那次调用在「模型不存在」处就被拒。
 *
 * ⚠️ 不能用 GET {base}/models 当判别器：实测 TokenDance 与 OpenRouter 的
 *    /models **不带 key 也返回 200**（匿名开放）→ 所有候选假阳性。
 *    这是第一版设想的硬错误，已推翻。
 *
 * ─────────────────────────────────────────────────────────────
 * 候选池的硬边界：CORS
 * ─────────────────────────────────────────────────────────────
 * 认领探测**本身就是一次浏览器跨域请求**，所以「能被认领的平台」= 「允许 CORS
 * 的平台」。实测（Origin 伪造成 https://skrinoo.github.io 发预检）：
 *   可进池 11/15 —— 本文件收录的这些
 *   不可进池 4/15 —— Groq / Together / OpenAI 官方 / Anthropic
 *     （均 403 且无任何 Access-Control-* 头）
 * 那四家**刻意不在池内**：加进来也认领不到，只会白白多一轮超时等待。
 * 想覆盖它们只能走服务端代理通道（设计文档《任意平台 APIKey 支持 AI · 改进方案》
 * §5 选项 B —— 该文档在仓库外，不在 docs/ 内）。
 *
 * ─────────────────────────────────────────────────────────────
 * base 正确性已验证（bf/base_verify.py → _base_verify.txt）
 * ─────────────────────────────────────────────────────────────
 * 对池内 10 家**无 key** POST {base}/chat/completions：
 *   **10/10 全部返回 401**（= 端点存在 + 鉴权中间件在 ⇒ base 正确），
 *   **全部直连可达**，延迟 84–3148ms、多数 < 700ms
 *   （TokenDance 84ms / StepFun 125ms / 智谱 119ms / MiniMax 172ms 最快）
 * 所以「认领」这条路是通的，而且很快。
 *
 * ─────────────────────────────────────────────────────────────
 * 维护须知
 * ─────────────────────────────────────────────────────────────
 * · models[0] 是认领命中后自动填入的默认模型。**必须选非思考型**：
 *   本项目已被思考型模型撞过（step-3.7-flash 在 max_tokens=2500 下烧掉 4409
 *   completion_tokens，正文却是空的，只回吐思维链 → 客户端拿到空字符串）。
 *   见 engine/api.js 顶部与本文件 tests 的 empty_content 备注。
 * · 平台改版会改 base 与模型名，所以模型名只作**建议值**，UI 必须允许玩家改。
 * · 想加平台：照着上面的判据实测一次（无 key 打 /chat/completions 要收到 401，
 *   预检要有 Access-Control-Allow-Origin），确认 cors:true 再进来。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.GATEWAYS = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /**
   * @typedef {Object} Gateway
   * @property {String}  plat    归组键。同 plat 的多个条目 = 同一平台的多套 base
   * @property {String}  nameZh  中文品牌名（玩家认得出的那个名字，UI 下拉直接用它）
   * @property {String}  base    API base（已实测 401 = 端点存在）
   * @property {String}  label   变体标签（空 = 该平台唯一端点）。用于区分同平台多套餐
   * @property {Array}   models  可用模型，[0] = 认领命中后自动填入的默认值（非思考型）
   * @property {Boolean} cors    实测允许浏览器直连。false 的条目保留在文件里备查，
   *                             但 identifyKey 会跳过（认领探测跨域必失败，只会浪费一轮超时）
   * @property {String}  home    平台官网/控制台。**唯一的合法用途是「还没有 Key？
   *                             去这家注册」** —— 绝不用来引导玩家去找 base（见文件头）
   */

  /** @type {Gateway[]} */
  var LIST = [
    // ── 聚合网关 ──────────────────────────────────────────
    {
      plat: "tokendance",
      nameZh: "TokenDance 词元跳动",
      base: "https://tokendance.space/gateway/v1",
      label: "",
      models: ["qwen3-max", "deepseek-v3.2", "glm-4.5-air"],
      cors: true,
      home: "https://tokendance.space/"
    },

    {
      plat: "openrouter",
      nameZh: "OpenRouter",
      base: "https://openrouter.ai/api/v1",
      label: "",
      models: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-3.5-haiku"],
      cors: true,
      home: "https://openrouter.ai/"
    },

    // ── 国内模型厂商 ──────────────────────────────────────
    {
      plat: "deepseek",
      nameZh: "DeepSeek 深度求索",
      base: "https://api.deepseek.com/v1",
      label: "",
      models: ["deepseek-chat", "deepseek-reasoner"],
      cors: true,
      home: "https://platform.deepseek.com/"
    },

    {
      plat: "siliconflow",
      nameZh: "SiliconFlow 硅基流动",
      base: "https://api.siliconflow.cn/v1",
      label: "",
      // 硅基流动的模型 ID 带组织名前缀，写成 provider/Name 才是完整 ID
      models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3", "THUDM/glm-4-9b-chat"],
      cors: true,
      home: "https://cloud.siliconflow.cn/"
    },

    {
      plat: "moonshot",
      nameZh: "Moonshot 月之暗面 Kimi",
      base: "https://api.moonshot.cn/v1",
      label: "",
      models: ["moonshot-v1-8k", "moonshot-v1-32k"],
      cors: true,
      home: "https://platform.moonshot.cn/"
    },

    {
      plat: "zhipu",
      nameZh: "智谱 GLM",
      base: "https://open.bigmodel.cn/api/paas/v4",
      label: "",
      models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
      cors: true,
      home: "https://open.bigmodel.cn/"
    },

    {
      // 阿里云百炼与通义千问共用同一个兼容端点，所以合成一条，
      // 名字里两个都写上 —— 玩家可能只认其中一个叫法。
      plat: "dashscope",
      nameZh: "阿里云百炼 / 通义千问",
      base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      label: "",
      models: ["qwen-turbo", "qwen-plus", "qwen-max"],
      cors: true,
      home: "https://bailian.console.aliyun.com/"
    },

    {
      plat: "volcengine",
      nameZh: "火山方舟 · 豆包",
      base: "https://ark.cn-beijing.volces.com/api/v3",
      label: "",
      // ⚠️ 火山方舟的模型 ID 通常是控制台里创建的「推理接入点」ID（ep-xxxxxxxx），
      // 不是模型名。下面的名字在部分账号下直接可用，但若报「模型不存在」，
      // 需要玩家去方舟控制台创建接入点后把 ep-xxxx 填进来。这一家的模型 ID
      // 是所有候选里最不通用的一家，注释留档。
      models: ["doubao-1-5-lite-32k-250115", "doubao-pro-32k"],
      cors: true,
      home: "https://console.volcengine.com/ark"
    },

    {
      plat: "minimax",
      nameZh: "MiniMax",
      base: "https://api.minimax.chat/v1",
      label: "",
      models: ["MiniMax-Text-01", "abab6.5s-chat"],
      cors: true,
      home: "https://platform.minimaxi.com/"
    },

    // ── StepFun：一个平台两套 base 的实例 ─────────────────
    // 这两条是本文件「条目粒度 = 平台 × base 变体」的直接理由。
    // 两套**都活着**（无 key 探测均 401），玩家买的是哪套决定该用哪个 base，
    // 而玩家自己不可能知道 —— 所以两条都进池，谁命中算谁。
    {
      plat: "stepfun",
      nameZh: "阶跃星辰 StepFun",
      base: "https://api.stepfun.com/step_plan/v1",
      label: "Step Plan 订阅",
      models: ["step-3.7-flash", "step-3.5-flash"],
      cors: true,
      home: "https://platform.stepfun.com/"
    },
    {
      plat: "stepfun",
      nameZh: "阶跃星辰 StepFun",
      base: "https://api.stepfun.com/v1",
      label: "按量付费",
      models: ["step-2-16k", "step-1-8k"],
      cors: true,
      home: "https://platform.stepfun.com/"
    }

    // ── 刻意不在池内（想加需要先解决 CORS，加进来也认领不到）────
    // Groq            https://api.groq.com/openai/v1     预检 403，无 CORS 头
    // Together        https://api.together.xyz/v1        预检 403，无 CORS 头
    // OpenAI 官方     https://api.openai.com/v1          无任何 Access-Control-* 头
    // Anthropic       https://api.anthropic.com/v1       无任何 Access-Control-* 头
    // 这四家要覆盖只能走服务端代理通道（方案 §5 选项 B）。
  ];

  /** 所有条目（含 cors:false 的备查条目，如有）。UI 与探测按需自己过滤。 */
  function all() { return LIST.slice(); }

  /** 能真正参与认领探测的条目：必须允许 CORS，且要有 base。 */
  function probeable() {
    return LIST.filter(function (g) { return g.cors !== false && !!g.base; });
  }

  /**
   * 平台去重列表，供 UI 下拉使用 —— **给的是中文品牌名，不是 URL**。
   * 玩家认得「硅基流动」，认不得「https://api.siliconflow.cn/v1」。
   * @returns {Array<{plat:String, nameZh:String, variants:Number, home:String}>}
   */
  function platforms() {
    var seen = {}, out = [];
    for (var i = 0; i < LIST.length; i++) {
      var g = LIST[i];
      if (seen[g.plat]) { seen[g.plat].variants++; continue; }
      var item = { plat: g.plat, nameZh: g.nameZh, variants: 1, home: g.home || "" };
      seen[g.plat] = item;
      out.push(item);
    }
    return out;
  }

  /** 某个平台下的全部条目（含多套 base 变体）。 */
  function byPlat(plat) {
    return LIST.filter(function (g) { return g.plat === plat; });
  }

  /** 按 plat 找中文名（认领结果里回显「已识别为《硅基流动》」要用）。 */
  function nameOf(plat) {
    var v = byPlat(plat);
    return v.length ? v[0].nameZh : String(plat || "");
  }

  /** 认领探测用的、本次要发的假模型名。刻意写成不可能存在的形状。 */
  var PROBE_MODEL = "__bf_probe_nonexistent_model__";

  return {
    list: all,
    probeable: probeable,
    platforms: platforms,
    byPlat: byPlat,
    nameOf: nameOf,
    PROBE_MODEL: PROBE_MODEL
  };
});
