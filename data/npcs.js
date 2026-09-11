/**
 * 《锅从天降》 NPC 静态数据表
 *
 * 这里的所有数值都是「确定性游戏数据」，不交给 LLM 判断。
 * 零成本验证（2026-09-11）发现：让 LLM 输出 pot_ownership 会严重错判
 * （gemini-2.5-flash 把导师对「PPT没人做」的锅归属判成 0.8，应为 0.1），
 * 因此锅归属、道德代价、抗甩性全部改为引擎查表。
 *
 * UMD 写法：既能作为经典 <script> 在 file:// 下运行（原型阶段），
 * 也能在迁移到 Next.js 后用 require() 引入。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.NPCS = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /**
   * 字段说明
   * ─────────────────────────────────────────────────────────────
   * id                 内部标识，同时是判定库 verdicts 的外键
   * name               显示名
   * glyph              头像占位字符（立绘未生成前用）
   * baseAcceptance     基础抗甩性 A0（0-100），越高越好甩
   * fatigueStep        疲劳惩罚：本局每被甩一次，A 额外减去该值
   * relationInit       初始关系值
   * relationStep       被成功甩锅一次的关系值变化
   * coldWarAt          关系值低于此值触发「冷战」，本局剩余时间拒接
   * difficulty         得分难度系数，得分 = 100 x difficulty
   * potOwnership       默认锅归属 G（0.0-1.0），可被 pot.ownershipOverride 覆盖
   * moralCost          道德代价（锁定表，禁止 LLM 自行推断）
   *                    高 -> 甩成功时心理阴影面积 +2
   * prefers            偏好论证类型，命中则 A +15
   * dislikes           反感论证类型，命中则 A -20
   * reflectChance      反甩概率（0-1），锅飞回去砸玩家
   * kind               normal | abstract | self
   *                    abstract：无主体（天气/水逆/星座），跳过判定直接成功，得分 x0.3
   *                    self    ：未来的自己 / 过去的自己，走特殊分支
   * scene              限定只接某类锅（null = 不限）
   * desc               性格设定，同时作为 LLM prompt 里的 NPC 性格描述来源
   */

  return [
    {
      id: "didi",
      name: "学弟学妹",
      glyph: "\uD83E\uDDD1\u200D\uD83C\uDF93",
      baseAcceptance: 95,
      fatigueStep: 8,
      relationInit: 100,
      relationStep: -20,
      coldWarAt: 30,
      difficulty: 1.0,
      potOwnership: 0.2,
      moralCost: "高",
      prefers: ["情感型"],
      dislikes: ["转移型", "反向型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      desc: "讨好型，几乎不会拒绝，回答里常带犹豫和自我说服，从不抱怨"
    },
    {
      id: "roommate",
      name: "室友",
      glyph: "\uD83D\uDECF\uFE0F",
      baseAcceptance: 75,
      fatigueStep: 8,
      relationInit: 100,
      relationStep: -10,
      coldWarAt: 30,
      difficulty: 1.2,
      potOwnership: 0.5,
      moralCost: "中",
      prefers: ["事实型"],
      dislikes: ["反向型", "荒诞型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      desc: "平等关系，会反驳也会认账，语气直接，会记账"
    },
    {
      id: "moyu",
      name: "摸鱼组员",
      glyph: "\uD83D\uDC1F",
      baseAcceptance: 50,
      fatigueStep: 6,
      relationInit: 80,
      relationStep: -10,
      coldWarAt: 25,
      difficulty: 1.5,
      potOwnership: 0.6,
      moralCost: "中",
      prefers: ["事实型", "转移型"],
      dislikes: ["情感型"],
      reflectChance: 0.4,
      kind: "normal",
      scene: null,
      desc: "他自己就在摸鱼，被甩时有四成概率把锅原样扔回来"
    },
    {
      id: "xuezhang",
      name: "社团学长",
      glyph: "\uD83C\uDF93",
      // baseAcceptance 原为 25，导致他在 1050 组合扇展里胜率 0%（最佳 P=0.51）。
      // 难度 2.0 的含义是「难」，不是「不可能」—— 他的难应该来自
      // 0.35 的反甩率和 -15 的关系坡降，而不是连偏好类型都永远推不动。
      baseAcceptance: 55,
      fatigueStep: 5,
      relationInit: 70,
      relationStep: -15,
      coldWarAt: 20,
      difficulty: 2.0,
      potOwnership: 0.3,
      moralCost: "中",
      prefers: ["转移型", "事实型"],
      dislikes: ["情感型", "荒诞型"],
      reflectChance: 0.35,
      kind: "normal",
      scene: null,
      desc: "甩锅老手，擅长把责任包装成「锻炼机会」，反甩时会用这句话"
    },
    {
      id: "daoshi",
      name: "导师",
      glyph: "\uD83D\uDC68\u200D\uD83C\uDFEB",
      baseAcceptance: 5,
      fatigueStep: 3,
      relationInit: 60,
      relationStep: -25,
      coldWarAt: 15,
      difficulty: 3.0,
      potOwnership: 0.1,
      moralCost: "中",
      prefers: ["事实型"],
      dislikes: ["反向型", "情感型", "荒诞型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      desc: "权力上位，语气平淡而有压迫感，不解释理由，一句话就能让人闭嘴"
    },
    {
      id: "jiaowu",
      name: "教务处",
      glyph: "\uD83C\uDFDB\uFE0F",
      // 原为 baseAcceptance 40 + relationInit 50，扇展胜率 2/75。
      // 他的难应当来自「只能在他真的管得着的锅上说得通」（选课/经费/体测），
      // 而不是来自连钥匙对了也推不动。
      baseAcceptance: 50,
      fatigueStep: 4,
      relationInit: 60,
      relationStep: -5,
      coldWarAt: 10,
      difficulty: 1.6,
      potOwnership: 0.3,
      moralCost: "中",
      prefers: ["转移型", "事实型"],
      dislikes: ["情感型", "荒诞型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      // 兑现 desc 里早已写下、但引擎一直没实现的承诺（见 fallback.js FORMAL_WORDS）
      formalBonus: true,
      desc: "官僚系统，只会输出模板化公文用语；理由含书面语时说服力额外加成"
    },
    {
      id: "fudaoyuan",
      name: "辅导员",
      glyph: "\uD83D\uDCCB",
      baseAcceptance: 40,
      fatigueStep: 4,
      relationInit: 70,
      relationStep: -8,
      coldWarAt: 20,
      difficulty: 1.6,
      potOwnership: 0.2,
      moralCost: "中",
      prefers: ["情感型"],
      dislikes: ["荒诞型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      suspend: true,
      desc: "习惯用「你再想想」化解一切，锅会悬空不落，不好也不坏"
    },
    {
      id: "shitang",
      name: "食堂阿姨",
      glyph: "\uD83C\uDF5A",
      baseAcceptance: 70,
      fatigueStep: 10,
      relationInit: 100,
      relationStep: -25,
      coldWarAt: 40,
      difficulty: 1.0,
      potOwnership: 0.3,
      moralCost: "高",
      prefers: ["事实型"],
      dislikes: ["反向型", "荒诞型"],
      reflectChance: 0,
      kind: "normal",
      scene: null,
      desc: "无辜。甩给她时裁判点评会变得温柔，反而更让人内疚"
    },
    {
      id: "ex",
      name: "前任",
      glyph: "\uD83D\uDC94",
      // 原为 baseAcceptance 20 + relationInit 20，双重惩罚叠加场景锁，
      // 扇展胜率 0%。前任的难度应当全部来自「锁」：
      //   只有情感社交场景的锅递得过去（其余原样弹回），
      //   只有情感型论证听得进去（其余三种全在反感表里），
      //   即使都对，还有一半概率被反甩。
      // 钥匙对的时候要能开——否则玩家永远学不会这个规则。
      // relationInit 从 20 提到 45：分手之后还剩一点余地，但依旧全场最低。
      baseAcceptance: 68,
      fatigueStep: 5,
      relationInit: 45,
      relationStep: -10,
      coldWarAt: 5,
      difficulty: 2.2,
      potOwnership: 0.1,
      moralCost: "中",
      prefers: ["情感型"],
      dislikes: ["事实型", "转移型", "荒诞型"],
      reflectChance: 0.5,
      kind: "normal",
      scene: "情感社交",
      desc: "只接情感类的锅。学业和行政的锅甩过去会被原样扔回来"
    },
    {
      id: "tianqi",
      name: "天气",
      glyph: "\uD83C\uDF27\uFE0F",
      baseAcceptance: 100,
      fatigueStep: 0,
      relationInit: 100,
      relationStep: 0,
      coldWarAt: -1,
      difficulty: 0.3,
      potOwnership: 0.0,
      moralCost: "低",
      prefers: [],
      dislikes: [],
      reflectChance: 0,
      kind: "abstract",
      scene: null,
      desc: "抽象概念，无法开口，由裁判代为陈述其「态度」"
    },
    {
      id: "shuini",
      name: "水逆",
      glyph: "\uD83D\uDD2E",
      baseAcceptance: 100,
      fatigueStep: 0,
      relationInit: 100,
      relationStep: 0,
      coldWarAt: -1,
      difficulty: 0.3,
      potOwnership: 0.0,
      moralCost: "低",
      prefers: [],
      dislikes: [],
      reflectChance: 0,
      kind: "abstract",
      scene: null,
      desc: "抽象概念，无法开口，由裁判代为陈述其「态度」；一本正经配合荒谬前提"
    },
    {
      id: "xingzuo",
      name: "你的星座",
      glyph: "\u2652",
      baseAcceptance: 100,
      fatigueStep: 0,
      relationInit: 100,
      relationStep: 0,
      coldWarAt: -1,
      difficulty: 0.3,
      potOwnership: 0.0,
      moralCost: "低",
      prefers: [],
      dislikes: [],
      reflectChance: 0,
      kind: "abstract",
      scene: null,
      desc: "抽象概念，无法开口，由裁判代为陈述其「态度」"
    },
    {
      id: "future_self",
      name: "未来的自己",
      glyph: "\u23F3",
      baseAcceptance: 100,
      fatigueStep: 0,
      relationInit: 100,
      relationStep: 0,
      coldWarAt: -1,
      difficulty: 0.0,
      potOwnership: 0.0,
      moralCost: "低",
      prefers: ["情感型"],
      dislikes: [],
      reflectChance: 0,
      kind: "self",
      scene: null,
      deferToNextRound: 0.3,
      desc: "还没发生，无法回应，只能由裁判陈述后果。甩给他等于拖延"
    },
    {
      id: "past_self",
      name: "过去的自己",
      glyph: "\uD83D\uDEA8",
      baseAcceptance: 100,
      fatigueStep: 0,
      relationInit: 100,
      relationStep: 0,
      coldWarAt: -1,
      difficulty: 1.0,
      potOwnership: 0.0,
      moralCost: "高",
      prefers: [],
      dislikes: [],
      reflectChance: 0,
      kind: "self",
      scene: null,
      fixedReaction: "\u2026\u2026",
      fixedVerdict: "他已经无法为自己辩护了。",
      desc: "已无法辩解"
    }
  ];
});
