/**
 * 《锅从天降》 本地兜底引擎
 *
 * 存在意义：AI 超时、网关挂掉、余额不足、评审现场断网 —— 游戏必须照常运行。
 * 这是「完成度与可演示 25 分」的保险结构。
 *
 * 三个职责：
 *   1. classifyArgumentType()      给自由输入文本判定论证类型
 *   2. computePersuasiveness()     给自由输入文本打说服力分
 *   3. lookup()                    从预生成判定库取手法学名 / 点评 / NPC 反应
 *
 * 说服力刻意比 AI 路径略严（上限约 +28），
 * 这样「自由输入 + AI 在线」始终是更优路径，兜底只是保底不是替代。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.FallbackEngine = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // 明显推卸词：出现即扣分。这类表述在游戏中应当被惩罚，
  // 因为它把责任否认为「与我无关」，而不是给出论证。
  var SHIRK_WORDS = [
    "又不是我", "跟我没关系", "关我什么事", "凭什么是我",
    "我不管", "爱谁谁", "不是我的事", "我哪知道"
  ];

  // 公文腔 / 书面语词表。
  // 存在原因：npcs.js 里教务处的 desc 写了「理由含书面语时说服力额外加成」，
  // 但引擎里从未实现过——数据表许下了一个引擎没有兑现的承诺。
  // 它模拟的不是「论证更有力」，而是「说话方式对上了频道」，
  // 所以它必须是 NPC 侧开关（npc.formalBonus），而不是全局加成。
  var FORMAL_WORDS = [
    "制度", "流程", "条例", "规定", "规则", "公示", "审批", "章程",
    "条款", "职责", "边界", "机制", "系统", "日志", "记录", "票据",
    "报销", "方案", "细则", "办法", "流程表", "排班表", "公章", "备案"
  ];

  var LEN_MIN = 10;
  var LEN_MAX = 32;
  var LEN_TOO_SHORT = 6;

  // 与 engine/judge.js 的 REVERSE_UNLOCK 必须保持一致。
  // 两边各自定义而不共享常量，是因为兜底引擎不能反向依赖判定引擎
  // （判定引擎调用它时它必须已经可用）。
  var REVERSE_UNLOCK = 3;

  // ── 契合度 fit：理由的「目标角色」是否对上甩锅对象 ──────────────
  // 每个快速理由都隐含一个「它在怪谁」：怪自己(self)、怪某个具体的人(npc)、
  // 怪制度/无主体外部力(institution)、或谁都能圆的泛化(any)。
  // 把它甩给角色不符的对象，就是玩家吐槽的「甩给室友的理由其实在怪自己」。
  // 命中给 FIT_MATCH，错配给 FIT_MISMATCH，any 永远中性（不挑对象）。
  var FIT_MATCH = 8;
  var FIT_MISMATCH = -12;

  // 论证类型 → 默认目标角色。绝大多数锅符合这个先验；
  // 个别偏离的在 pots.js 里用 pot.targetRole[type] 覆盖（生成锅则整体由 AI 标注）。
  var TYPE_DEFAULT_ROLE = {
    "事实型": "npc",          // 摆事实通常在指认「对方」
    "情感型": "self",         // 诉诸情感通常在陈述「我」的处境
    "转移型": "institution",  // 转移矛盾通常推给制度/流程/无主体
    "反向型": "npc",          // 反将一军通常点名「是你/他」
    "荒诞型": "any"           // 荒诞甩锅是解压阀，不挑对象
  };

  // normal 类 NPC 里唯一的「机构」是教务处；辅导员/食堂阿姨/导师/学长/前任/室友/学弟/摸鱼组员都是「人」。
  // abstract（天气/水逆/星座）= 无主体外部力 = institution；self（过去/未来的自己）= self。
  var NPC_INSTITUTION = { jiaowu: 1 };

  function roleOfNpc(npc) {
    if (!npc) return null;
    if (npc.kind === "self") return "self";
    if (npc.kind === "abstract") return "institution";
    return NPC_INSTITUTION[npc.id] ? "institution" : "npc";
  }

  // 理由的目标角色：生成锅/已标注锅用 pot.targetRole[type]，否则用类型默认。
  function reasonRoleOf(pot, argType) {
    if (pot && pot.targetRole && pot.targetRole[argType]) return pot.targetRole[argType];
    return TYPE_DEFAULT_ROLE[argType] || "any";
  }

  function fitOf(reasonRole, npcRole) {
    if (!reasonRole || reasonRole === "any" || !npcRole) return 0;
    return reasonRole === npcRole ? FIT_MATCH : FIT_MISMATCH;
  }

  /**
   * 给自由输入判定论证类型。
   * 按关键词命中数取最高，全部为 0 时退化为「事实型」（最中性的默认值）。
   */
  function classifyArgumentType(text, types) {
    if (!text) return "事实型";
    var t = String(text);
    var best = null, bestHits = 0;

    Object.keys(types).forEach(function (name) {
      var kws = types[name].keywords || [];
      var hits = 0;
      for (var i = 0; i < kws.length; i++) {
        if (t.indexOf(kws[i]) >= 0) hits++;
      }
      if (hits > bestHits) { bestHits = hits; best = name; }
    });

    return best || "事实型";
  }

  /**
   * 计算说服力 S（0-100）的明细版，附带逐项加减分轨迹。
   * 调参时用它看每一步的得失，生产路径用 computePersuasiveness()。
   */
  function computePersuasivenessDetailed(reason, argType, npc, pot, types, state) {
    var def = (types && types[argType]) || { basePower: 45, keywords: [] };
    var text = String(reason || "");
    var s = def.basePower;
    var trace = ["基础 " + def.basePower];

    // 长度
    if (text.length === 0) {
      return { score: 0, trace: ["空理由"] };
    } else if (text.length < LEN_TOO_SHORT) {
      s -= 20; trace.push("理由过短 -20");
    } else if (text.length >= LEN_MIN && text.length <= LEN_MAX) {
      s += 6; trace.push("长度合理 +6");
    }

    // 提及具体事实：理由里出现了 NPC 名或锅文本里的实词
    var specific = false;
    if (npc && text.indexOf(npc.name) >= 0) specific = true;
    if (!specific && pot) {
      var potWords = extractKeywords(pot.text);
      for (var i = 0; i < potWords.length; i++) {
        if (text.indexOf(potWords[i]) >= 0) { specific = true; break; }
      }
    }
    if (specific) { s += 10; trace.push("援引具体事实 +10"); }

    // 契合度 fit：仅对「快速选项」生效——此时理由文本 === pot.options[argType]，
    // 它的目标角色是确定的（pot.targetRole 标注或类型默认）。自由输入的文本角色
    // 无法可靠判定，fit 保持中性，交给 AI 裁判（热路径）或不管（冷路径兜底）。
    var isQuickThrow = pot && pot.options &&
      Object.prototype.hasOwnProperty.call(pot.options, argType) &&
      pot.options[argType] === text;
    if (isQuickThrow && npc) {
      var rRole = reasonRoleOf(pot, argType);
      var nRole = roleOfNpc(npc);
      var fit = fitOf(rRole, nRole);
      // 不为「偏好」开口子：prefers 给的是 A 侧 +15（P +6），足以抵消 fit 的 S 侧 −12（P −4.8），
      // 吃软乎的对象（前任/学弟学妹）照样接得住情感型；但错配的 −12 保留，
      // 才能让「对上的理由」得分高于「错位的理由」——这正是 fit 要给的相对信号。
      if (fit > 0) { s += fit; trace.push("契合对象(" + rRole + "→" + nRole + ") +" + fit); }
      else if (fit < 0) { s += fit; trace.push("错配对象(" + rRole + "→" + nRole + ") " + fit); }
    }

    // NPC 偏好 / 反感
    if (npc) {
      if (npc.prefers && npc.prefers.indexOf(argType) >= 0) { s += 6; trace.push("命中偏好 +6"); }
      var disliked = npc.dislikes && npc.dislikes.indexOf(argType) >= 0;
      // 反向型解锁后免疫反感惩罚，与判定引擎的接受度侧保持同一套逻辑：
      // 否则它会同时吃 A -20 和 S -14 两道折扣，接锅换来的奖励反而成了陷阱。
      var immune = argType === "反向型" && state && (state.catchCredit || 0) >= REVERSE_UNLOCK;
      if (disliked && !immune) { s -= 14; trace.push("触到反感 -14"); }
      else if (disliked && immune) { trace.push("接锅信用抵消反感"); }
    }

    // 含具体数字或时间
    if (/[0-9０-９]/.test(text) || /(点|号|天|周|次|分|块|元|版)/.test(text)) {
      s += 6; trace.push("含量化依据 +6");
    }

    // 关键词命中
    var kwHits = 0, kws = def.keywords || [];
    for (var k = 0; k < kws.length; k++) {
      if (text.indexOf(kws[k]) >= 0) kwHits++;
    }
    if (kwHits > 0) {
      var bonus = Math.min(kwHits * 2, 6);
      s += bonus; trace.push("类型特征词 +" + bonus);
    }

    // 推卸词惩罚
    for (var w = 0; w < SHIRK_WORDS.length; w++) {
      if (text.indexOf(SHIRK_WORDS[w]) >= 0) {
        s -= 15; trace.push("使用推卸词 -15");
        break;
      }
    }

    // 公文腔加成（仅对 npc.formalBonus 为真的对象生效）
    if (npc && npc.formalBonus) {
      var formalHits = 0;
      for (var f = 0; f < FORMAL_WORDS.length; f++) {
        if (text.indexOf(FORMAL_WORDS[f]) >= 0) formalHits++;
      }
      if (formalHits > 0) {
        var fb = Math.min(formalHits * 4, 12);
        s += fb; trace.push("公文腔对上频道 +" + fb);
      }
    }

    s = Math.max(0, Math.min(100, Math.round(s)));
    trace.push("合计 " + s);
    return { score: s, trace: trace };
  }

  /**
   * 计算说服力 S（0-100）
   *
   * @param reason   玩家提交的理由文本
   * @param argType  论证类型中文名
   * @param npc      NPC 对象
   * @param pot      锅对象
   * @param types    ARGUMENT_TYPES 表
   * @param state    局内状态，仅用到 catchCredit（反向型解锁判定）
   */
  function computePersuasiveness(reason, argType, npc, pot, types, state) {
    return computePersuasivenessDetailed(reason, argType, npc, pot, types, state).score;
  }

  /** 从锅文本里抽出可用于匹配的实词（去停用词，取 2-4 字片段） */
  function extractKeywords(potText) {
    if (!potText) return [];
    var stop = ["的", "了", "是", "在", "已经", "没有", "一个", "你", "我", "他", "她", "它",
                "今天", "现在", "到", "还", "就", "都", "而", "并且", "但是"];
    var cleaned = String(potText).replace(/[，。、！？：；「」《》\s]/g, "|");
    var parts = cleaned.split("|").filter(Boolean);
    var out = [];
    parts.forEach(function (p) {
      stop.forEach(function (s) { p = p.split(s).join("|"); });
      p.split("|").forEach(function (frag) {
        if (frag.length >= 2 && frag.length <= 6) out.push(frag);
      });
    });
    return out.slice(0, 8);
  }

  /**
   * 从预生成判定库取文案，返回可直接交给 JudgeEngine.judge() 的 ai 载荷。
   *
   * 注意：这里**不挑** reaction_success / reaction_fail。
   * 成败是引擎算出来的，只有引擎知道该用哪一条；
   * 若在这里就挑好，会出现「文案说对方接了、数值判它失败」的矛盾。
   *
   * @param npcId    NPC id
   * @param argType  论证类型中文名
   * @param library  VERDICTS 对象（{ entries, generic }）
   * @returns {{technique:String, verdict:String, reactionSuccess:String,
   *            reactionFail:String, hit:Boolean, source:String}}
   */
  function lookup(npcId, argType, library) {
    var miss = { technique: "", verdict: "", reactionSuccess: "", reactionFail: "", hit: false, source: "none" };
    if (!library) return miss;

    var entries = library.entries || library;   // 兼容直接传入扁平 map
    var entry = entries[npcId + "::" + argType];

    if (!entry) {
      // 未命中 -> 按论证类型取通用兜底文案，三条轮换，保证不会出现空白气泡
      var pool = (library.generic || {})[argType];
      if (!pool || !pool.length) return miss;
      entry = pool[genericCursor[argType]++ % pool.length];
      if (!entry) return miss;
      return shape(entry, "generic", npcId + "::" + argType);
    }
    return shape(entry, "library", npcId + "::" + argType);
  }

  /** 通用文案的轮换游标（每种论证类型独立计数） */
  var genericCursor = { "事实型": 0, "情感型": 0, "转移型": 0, "反向型": 0, "荒诞型": 0 };

  // reaction 变体游标：同一 (npcId, 论证类型) 反复甩时，按次数轮换数组里的多条回复，
  // 避免玩家连续甩同一人时看到一模一样的台词（修改 2 · 丰富回复）。
  var reactionCursor = {};

  /** 取一条 reaction：字符串原样返回；数组则按游标轮换返回 */
  function pickVariant(v, key) {
    if (Array.isArray(v)) {
      if (!v.length) return "";
      var c = reactionCursor[key] || 0;
      reactionCursor[key] = c + 1;
      return v[c % v.length];
    }
    return v || "";
  }

  function shape(entry, source, key) {
    return {
      technique: entry.technique || "",
      verdict: entry.verdict || "",
      // 支持数组变体：同一 (npc, 论证类型) 反复甩时轮换，避免文案单调
      reactionSuccess: pickVariant(entry.reaction_success, key + ":ok"),
      reactionFail: pickVariant(entry.reaction_fail, key + ":no"),
      hit: true,
      source: source
    };
  }

  return {
    classifyArgumentType: classifyArgumentType,
    computePersuasiveness: computePersuasiveness,
    computePersuasivenessDetailed: computePersuasivenessDetailed,
    extractKeywords: extractKeywords,
    lookup: lookup,
    roleOfNpc: roleOfNpc,
    reasonRoleOf: reasonRoleOf,
    fitOf: fitOf,
    TYPE_DEFAULT_ROLE: TYPE_DEFAULT_ROLE,
    FIT_MATCH: FIT_MATCH,
    FIT_MISMATCH: FIT_MISMATCH,
    SHIRK_WORDS: SHIRK_WORDS
  };
});
