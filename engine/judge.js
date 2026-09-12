/**
 * 《锅从天降》 判定引擎
 *
 * 核心公式（设计文档 §2.4）：
 *   P = S x 0.4 + A x 0.4 + G x 0.2      P >= 0.6 判定甩锅成功
 *   S 说服力（0-100）：理由本身的论证质量  <- AI 或兜底引擎
 *   A 接受度（0-100）：这个 NPC 此刻愿不愿意接 <- 引擎查表 + 状态计算
 *   G 锅归属（0.0-1.0）：这口锅本来就该由谁负责 <- 引擎静态查表
 *
 * ─────────────────────────────────────────────────────────────
 * 实现期发现的设计缺陷与修复（2026-09-11）
 * ─────────────────────────────────────────────────────────────
 * 缺陷：按原公式，导师（baseAcceptance=5，potOwnership=0.1）
 *       的 P 上限约为 0.4 x 1.0 + 0.4 x 0.05 + 0.2 x 0.1 = 0.44，
 *       永远达不到 0.6 —— 意味着「甩给导师」是数学上不可能的，
 *       而设计意图是「成功率 5%，成功了爽感爆表」。
 *
 * 修复：引入【完美论证暴击】。
 *       当 S >= 88 且 G >= 0.2 且论证类型不是荒诞型时，
 *       无视抗甩性直接判定成功，得分翻倍，解说员破音。
 *
 *       这在主题上完全成立：
 *       只有拿出真正无可辩驳的论证，才能撼动权力上位者。
 *       同时它把「自由输入」这条高分路径的价值做实了 ——
 *       固定选项的说服力被 QUICK_CAP 封顶在 85，暴击只能靠玩家自己写出好理由。
 *
 * ─────────────────────────────────────────────────────────────
 * 第二个修复：reaction 必须在成败已知之后才挑选（2026-09-11）
 * ─────────────────────────────────────────────────────────────
 * 判定库里每个 (NPC, 论证类型) 存的是 reaction_success / reaction_fail 两条，
 * 而成功与否是引擎算出来的。若让调用方事先挑一条传进来，
 * 就会出现「文案说对方接了、数值判它失败」的自相矛盾。
 * 因此 ai 载荷改为携带两条原文，由引擎在 success 确定后调用 pickReaction()。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.JudgeEngine = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  var THRESHOLD = 0.6;        // P 成功阈值
  var CRIT_S = 88;            // 暴击所需说服力
  var CRIT_G = 0.2;           // 暴击所需最低锅归属
  var CRIT_MULTIPLIER = 2.0;  // 暴击得分倍率

  var PREF_BONUS = 15;        // 命中 NPC 偏好论证类型
  var DISLIKE_PENALTY = 20;   // 命中 NPC 反感论证类型
  var ACTIVATED_BONUS = 20;   // 第四幕被「接锅」激活的 NPC
  var QUICK_CAP = 85;         // 快速选项的说服力封顶（低于 CRIT_S，暴击只留给自由输入）
  var REVERSE_UNLOCK = 3;     // 接锅信用达到此值解锁「反向型」

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 「反向型」是否已解锁。
   *
   * 解锁后附带一个关键特权：**无视 NPC 的 dislikes 惩罚**。
   *
   * 为什么必须有这个特权（实测数据驱动的决定，2026-09-11）：
   * 全量扇展 1050 个（锅 x NPC x 论证类型）组合后发现，
   * 反向型对真实 NPC 的 210 次尝试里只赢了 2 次。
   * 原因是它同时吃两道惩罚：接受度 A -20（几乎所有人都反感被反推责任），
   * 说服力 S -14（兜底引擎的同一道惩罚）。双重折扣之下，
   * 这个「接满 3 口锅才能解锁的大招」比荒诞型还弱 —— 奖励变成了陷阱。
   *
   * 修法不是粗暴地加 basePower，而是给它一个主题上完全成立的例外：
   *
   *     只有先接过锅的人，说「是你让我这么做的」才有分量。
   *     一个从不承担责任的人说这句话是推诿；
   *     一个已经接过三口锅的人说这句话是陈述事实。
   *
   * 数值上表现为：解锁后对方无法再以「你凭什么这么说」驳回你。
   */
  function reverseUnlocked(st) {
    return !!st && (st.catchCredit || 0) >= REVERSE_UNLOCK;
  }

  /**
   * 在成败已知之后挑选 NPC 反应台词。
   * ai 载荷的三种形态都兼容：
   *   { reactionSuccess, reactionFail }  判定库 / v3 实时裁判
   *   { reaction }                       旧格式，单条
   *
   * 系统性根治「空回复」：判定库某类型缺台词时（如抽象 NPC 的 转移型/反向型
   * 回落到 generic，而 generic 只有 technique/verdict、没有 reaction），
   * 依次回落到 npc.fixedReaction → 一句中性台词，**绝不返回空字符串**。
   * 这样无论判定库将来漏了哪一条，气泡里都不会再出现空白。
   */
  function pickReaction(ai, success, npc) {
    var picked = "";
    if (ai) {
      picked = success ? ai.reactionSuccess : ai.reactionFail;
      // 缺一条时用另一条兜住，宁可台词略不贴，也不要出现空白气泡
      if (!picked) picked = ai.reactionFail || ai.reactionSuccess || ai.reaction || "";
    }
    if (picked) return picked;
    if (npc && npc.fixedReaction) return npc.fixedReaction;
    return "（对方没有接话，锅就这么留下了。）";
  }

  /** 取该 NPC 对该锅的归属度：优先用锅的 override，否则用 NPC 默认值 */
  function ownershipOf(pot, npc) {
    if (pot && pot.ownershipOverride &&
        Object.prototype.hasOwnProperty.call(pot.ownershipOverride, npc.id)) {
      return pot.ownershipOverride[npc.id];
    }
    return npc.potOwnership;
  }

  /**
   * 计算接受度 A
   * @param npc        NPC 定义
   * @param argType    论证类型中文名
   * @param st         局内状态 { thrown:{npcId:次数}, relations:{npcId:值},
   *                              activated:{npcId:true}, actBonus:数字 }
   *
   * actBonus 是三幕情感曲线的数值手柄：
   *   第一幕「爽」 +12 —— 让玩家先赢几次，否则后面的转折没有落差可用
   *   第二幕「紧」  0  —— 真实难度
   *   第三幕「停」 -6  —— 谁都开始不接了
   * 它不写在 NPC 表里，因为它是时间的函数，不是人的属性。
   */
  function acceptanceOf(npc, argType, st) {
    if (npc.kind === "abstract") return 100;  // 无主体不会拒绝

    var thrown = (st.thrown && st.thrown[npc.id]) || 0;
    var relation = (st.relations && st.relations[npc.id] != null)
      ? st.relations[npc.id] : npc.relationInit;

    var a = npc.baseAcceptance;
    a -= npc.fatigueStep * thrown;                     // 疲劳惩罚
    if (npc.prefers && npc.prefers.indexOf(argType) >= 0) a += PREF_BONUS;
    var disliked = npc.dislikes && npc.dislikes.indexOf(argType) >= 0;
    // 反向型解锁后免疫反感惩罚：你已经用接锅换来了说这句话的资格
    if (disliked && !(argType === "反向型" && reverseUnlocked(st))) a -= DISLIKE_PENALTY;
    a -= (100 - relation) * 0.2;                       // 关系恶化平滑惩罚
    if (st.activated && st.activated[npc.id]) a += ACTIVATED_BONUS;
    if (st.actBonus) a += st.actBonus;                 // 幕间修正

    return clamp(Math.round(a), 0, 100);
  }

  /** 关系值跌破 coldWarAt -> 冷战，本局剩余时间拒接 */
  function inColdWar(npc, st) {
    if (npc.coldWarAt == null || npc.coldWarAt < 0) return false;
    var relation = (st.relations && st.relations[npc.id] != null)
      ? st.relations[npc.id] : npc.relationInit;
    return relation <= npc.coldWarAt;
  }

  /**
   * 主判定入口
   *
   * @param {Object} o
   * @param {Object} o.pot        锅对象（来自 data/pots.js）
   * @param {Object} o.npc        NPC 对象（来自 data/npcs.js）
   * @param {String} o.argType    论证类型中文名
   * @param {String} o.reason     玩家实际提交的理由文本
   * @param {Object} o.state      局内可变状态
   * @param {Object} [o.ai]       AI 或预生成库给出的 { persuasiveness, technique, verdict, reaction }
   * @param {Object} [o.fallback] 兜底引擎，需提供 computePersuasiveness(reason, argType, npc, pot)
   * @param {Function} [o.rng]    随机数源，默认 Math.random，测试时可注入
   * @returns {Object} 判定结果
   */
  function judge(o) {
    var pot = o.pot, npc = o.npc, argType = o.argType;
    var state = o.state || {};
    var rng = o.rng || Math.random;
    var events = [];

    var result = {
      success: false,
      critical: false,
      reflected: false,
      suspended: false,
      deferred: false,
      caught: false,
      P: 0, S: 0, A: 0, G: 0,
      score: 0,
      shadowDelta: 0,
      relationDelta: 0,
      creditDelta: 0,
      technique: "",
      verdict: "",
      reaction: "",
      events: events,
      source: "engine"
    };

    // ── 0. 接锅分支（隐藏动词）──────────────────────────────
    // 接锅＝让锅在你这里停下，即「责任集中」，是责任扩散的反面。
    // 数值方向必须是：不得分（得分衡量的是甩锅段位，接锅不走这条路）、
    //             大幅降低心理阴影面积（你终止了转嫁链条）、
    //             累积接锅信用（用于解锁反向型论证）。
    // 早期版本写成 shadowDelta=+3、score=+50，方向是错的：
    // 那样接锅既痛又无收益，玩家永远不会去按这个隐藏按钮，第四幕也就永远不会发生。
    if (o.catchSelf) {
      result.caught = true;
      result.success = true;
      result.S = 0; result.A = 0; result.G = 1;
      result.P = 1;
      result.shadowDelta = -8;
      result.score = 0;
      result.creditDelta = 1;
      result.technique = "责任集中";
      result.verdict = "锅在你这里停下了。它没有消失，但也没有落到任何人头上。";
      result.reaction = "";
      events.push("catch");
      return result;
    }

    // ── 1. 反向型锁定校验 ─────────────────────────────────
    if (argType === "反向型" && !reverseUnlocked(state)) {
      result.success = false;
      result.verdict = "「反向型」论证尚未解锁。接住 " + REVERSE_UNLOCK +
        " 口锅之后，你才有资格说这句话。";
      result.reaction = "";
      result.shadowDelta = 1;
      events.push("locked");
      return result;
    }

    // ── 2. 场景不匹配（前任只接情感类锅）──────────────────
    if (npc.scene && pot.scene !== npc.scene) {
      result.reflected = true;
      result.shadowDelta = 3;
      result.verdict = "这口锅和" + npc.name + "没有任何关系，它被原样扔了回来。";
      result.reaction = "？";
      events.push("sceneMismatch");
      return result;
    }

    // ── 3. 冷战校验 ───────────────────────────────────────
    if (inColdWar(npc, state)) {
      result.success = false;
      result.reflected = true;
      result.shadowDelta = 3;
      result.verdict = npc.name + "已经进入冷战状态，本局不再接受任何责任转移。";
      result.reaction = "（转过身去）";
      events.push("coldWar");
      return result;
    }

    // ── 4. 过去的自己：固定台词，不参与判定 ───────────────
    if (npc.id === "past_self") {
      result.success = true;
      result.S = 100; result.A = 100; result.G = 0;
      result.P = 1;
      result.score = Math.round(100 * npc.difficulty);
      result.shadowDelta = 2;   // moralCost 高
      result.relationDelta = npc.relationStep;
      result.technique = "追诉时效";
      result.verdict = npc.fixedVerdict;
      result.reaction = npc.fixedReaction;
      result.source = "fixed";
      events.push("pastSelf");
      return result;
    }

    // ── 5. 未来的自己：拖延，本局不扣分，下一局锅变多 ─────
    if (npc.id === "future_self") {
      result.success = true;
      result.deferred = true;
      result.S = 100; result.A = 100; result.G = 0;
      result.P = 1;
      result.score = 0;          // difficulty = 0，本局不得分
      result.shadowDelta = 0;    // 本局不扣分
      result.creditDelta = 0;
      result.technique = "延期交付";
      result.verdict = "锅被寄往未来。运费到付。";
      result.reaction = "（还没有人签收）";
      result.deferPenalty = npc.deferToNextRound || 0.3;
      result.source = "fixed";
      events.push("defer");
      return result;
    }

    // ── 6. 抽象 NPC：无主体不可拒绝，跳过判定，得分折损 ───
    if (npc.kind === "abstract") {
      var aiAbs = o.ai || {};
      result.success = true;
      result.A = 100;
      result.G = ownershipOf(pot, npc);
      result.S = aiAbs.persuasiveness != null ? aiAbs.persuasiveness : 10;
      result.P = 1;
      result.score = Math.round(100 * npc.difficulty);  // difficulty=0.3
      result.shadowDelta = -1;
      result.technique = aiAbs.technique || "不可抗力滥用";
      result.verdict = aiAbs.verdict || "";
      // 抽象 NPC 永远成功，但反甩/冷战不适用，直接取成功台词
      result.reaction = pickReaction(aiAbs, true, npc);
      result.source = o.quick ? "library" : (o.ai ? "ai" : "fallback");
      events.push("abstract");
      return result;
    }

    // ── 7. 常规判定 ───────────────────────────────────────
    var G = ownershipOf(pot, npc);
    var A = acceptanceOf(npc, argType, state);
    var S;

    if (o.ai && typeof o.ai.persuasiveness === "number") {
      S = clamp(Math.round(o.ai.persuasiveness), 0, 100);
      result.source = o.quick ? "library" : "ai";
    } else if (o.fallback && typeof o.fallback.computePersuasiveness === "function") {
      S = clamp(Math.round(o.fallback.computePersuasiveness(o.reason, argType, npc, pot, o.types, state)), 0, 100);
      // 快速选项走的是「查表文案 + 引擎实算说服力」，这不是降级，
      // 而是主路径，因此单独标为 library，便于开发者面板分辨。
      result.source = o.quick ? "library" : "fallback";
    } else {
      S = 50;
      result.source = "default";
    }

    // 快速选项封顶：保证「完美论证暴击」只能由玩家亲手写出的自由输入触发。
    // 快速选项是 0ms、零成本的查表路径，若它也能暴击，自由输入就失去了意义。
    if (o.quick && S > QUICK_CAP) S = QUICK_CAP;

    var P = (S / 100) * 0.4 + (A / 100) * 0.4 + G * 0.2;
    P = Math.round(P * 1000) / 1000;

    // 完美论证暴击
    var critical = (S >= CRIT_S && G >= CRIT_G && argType !== "荒诞型");
    var success = critical ? true : (P >= THRESHOLD);

    result.S = S; result.A = A; result.G = G; result.P = P;
    result.critical = critical;
    result.success = success;
    result.technique = (o.ai && o.ai.technique) || "";
    result.verdict = (o.ai && o.ai.verdict) || "";
    result.reaction = pickReaction(o.ai, success, npc);

    if (critical) events.push("critical");

    // ── 8. 反甩判定（摸鱼组员 / 社团学长 / 前任）──────────
    if (success && npc.reflectChance > 0 && rng() < npc.reflectChance) {
      result.success = false;
      result.reflected = true;
      result.score = 0;
      result.shadowDelta = 3;
      // 反甩＝对方没接，台词必须换成拒绝的那一条
      result.reaction = pickReaction(o.ai, false, npc);
      events.push("reflect");
      return result;
    }

    // ── 9. 辅导员：锅悬空不落 ─────────────────────────────
    // 必须放在「结算数值」之前，作为一条独立结局返回。
    // 早期版本把它做成步骤 9 之后的后置覆盖，玩家看到的是
    // 「甩锅失败」四个大字，却既不掉血也不扣分 —— 一个自相矛盾的画面。
    // 现在它是第四种结局：不是成功，不是失败，是被按住了。
    if (npc.suspend) {
      result.success = false;
      result.suspended = true;
      result.score = 0;
      result.shadowDelta = 0;
      result.relationDelta = 0;
      result.freezeMs = 2000;
      result.verdict = "锅没有落地，也没有易主。它被一句话停在了半空。";
      result.reaction = pickReaction(o.ai, false, npc);
      events.push("suspend");
      return result;
    }

    // ── 10. 结算数值 ──────────────────────────────────────
    if (result.success) {
      var mult = critical ? CRIT_MULTIPLIER : 1;
      result.score = Math.round(100 * npc.difficulty * mult);
      result.shadowDelta = (npc.moralCost === "高") ? 2 : -1;
      result.relationDelta = npc.relationStep;
      events.push("success");
    } else {
      result.score = 0;
      result.shadowDelta = 3;
      result.relationDelta = Math.round(npc.relationStep / 2);  // 失败也伤关系，但减半
      events.push("fail");
    }

    return result;
  }

  return {
    judge: judge,
    acceptanceOf: acceptanceOf,
    ownershipOf: ownershipOf,
    inColdWar: inColdWar,
    pickReaction: pickReaction,
    reverseUnlocked: reverseUnlocked,
    THRESHOLD: THRESHOLD,
    CRIT_S: CRIT_S,
    CRIT_G: CRIT_G,
    QUICK_CAP: QUICK_CAP,
    REVERSE_UNLOCK: REVERSE_UNLOCK
  };
});
