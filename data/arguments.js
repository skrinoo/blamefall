/**
 * 《锅从天降》 五种论证类型
 *
 * 这是「辩」这个动词的教学层：玩家通过选项学会甩锅的语法。
 * basePower 是该类型在「没有任何 NPC 偏好加成」下的基础说服力，
 * 最终说服力 S = basePower + NPC 偏好修正 + 锅归属修正 + 理由文本修正。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.ARGUMENT_TYPES = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  return {
    "事实型": {
      id: "fact",
      icon: "\uD83D\uDCCB",
      basePower: 62,
      locked: false,
      desc: "援引客观事实、记录、已有分工作依据",
      example: "这部分是他上周认领的",
      // 自由输入的关键词识别表（本地兜底引擎用）
      keywords: ["记录", "截图", "日志", "签字", "排班表", "值日", "认领", "群里说", "时间戳", "数据", "名单"]
    },
    "情感型": {
      id: "emotion",
      icon: "\uD83D\uDCA7",
      basePower: 48,
      locked: false,
      desc: "援引自己的状态、付出、情绪作依据",
      example: "我这几天真的已经尽力了",
      keywords: ["累", "尽力", "熬", "撑不住", "已经", "连续", "真的", "我最近", "睡不着", "焦虑"]
    },
    "转移型": {
      id: "shift",
      icon: "\uD83D\uDD00",
      basePower: 44,
      locked: false,
      desc: "援引流程、制度、职责边界，主张责任不属于自己这一环",
      example: "这个环节本来就没人明确负责",
      keywords: ["流程", "制度", "规定", "条例", "职责", "边界", "本来就", "没人明确", "培养方案", "公示"]
    },
    "反向型": {
      id: "reverse",
      icon: "\uD83D\uDD04",
      basePower: 58,
      // 需要接锅信用 >= 3 才解锁，这是第四幕的核心奖励
      locked: true,
      requiresCredit: 3,
      desc: "把对方的行为当作自己行为的原因，责任反推给发起方",
      example: "如果我不做，谁做？",
      keywords: ["是您", "是你", "你们说", "他自己说", "照着您", "让我", "批的", "先说"]
    },
    "荒诞型": {
      id: "absurd",
      icon: "\uD83D\uDD2E",
      basePower: 10,
      locked: false,
      desc: "援引无法证伪的玄学、超自然、无厘头前提",
      example: "水星逆行",
      keywords: ["水逆", "水星", "星座", "八字", "运势", "宇宙", "魔法", "鬼", "命", "玄学"]
    }
  };
});
