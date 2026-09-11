/**
 * 《锅从天降》 锅池
 *
 * 每口锅自带「四种论证类型的固定理由模板」，这就是玩家的快速选项。
 * 因为快速选项的文本是固定的，判定结果可以完全预生成 -> 运行时 0ms，断网可玩。
 * 只有「自由输入」才需要实时调用 AI。
 *
 * ownershipOverride：覆盖 npcs.js 里的默认 potOwnership。
 *   同一个 NPC 对不同锅的归属程度是不同的，
 *   例如「摸鱼组员」对「PPT没人做」的归属是 0.9（他本来就该做），
 *   但对「宿舍电费超了」的归属是 0.0（跟他无关）。
 *
 * selfish：标记为 true 的锅属于「几乎只能怪自己」的一类（睡眠、时间、自制力）。
 *   第三幕会优先抽这类锅，因为它们才是「过去的自己 / 未来的自己」
 *   这两个 NPC 真正对应的对象 —— 幕次转折靠锅池完成，不靠弹提示框。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.POTS = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  return [
    {
      id: "ppt",
      scene: "小组作业",
      text: "小组作业的 PPT，明天上午要交，到现在还没人开始做。",
      weight: 1.0,
      tutorial: true,
      ownershipOverride: { moyu: 0.9, didi: 0.2, roommate: 0.4, daoshi: 0.1 },
      options: {
        "事实型": "这部分是他在群里认领的，我有截图",
        "情感型": "我这周已经连着三天熬到两点了",
        "转移型": "这个环节本来就没有明确负责人",
        "反向型": "是您上次说不用做太细的",
        "荒诞型": "水星逆行，电脑开不了机"
      }
    },
    {
      id: "freeload",
      scene: "小组作业",
      text: "组员连续 14 天没在群里说过话，但他朋友圈更新了 9 条。",
      weight: 0.9,
      ownershipOverride: { moyu: 1.0, didi: 0.1, daoshi: 0.1 },
      options: {
        "事实型": "群记录里他最后一次发言是 14 天前",
        "情感型": "我一直在替他兜着，真的撑不住了",
        "转移型": "分组是老师随机指定的，不是我选的",
        "反向型": "是他自己说要负责查资料的",
        "荒诞型": "他最近水逆，命里缺勤"
      }
    },
    {
      id: "trash",
      scene: "宿舍生活",
      text: "宿舍的垃圾已经三天没人倒了。",
      weight: 1.0,
      tutorial: true,
      ownershipOverride: { roommate: 0.6, didi: 0.0, daoshi: 0.0, moyu: 0.0 },
      options: {
        "事实型": "这周我值了两次日，你一次都没值",
        "情感型": "我今天真的累到不想动",
        "转移型": "值日表从来没排过，制度本身是空的",
        "反向型": "上次是你说不用的先放着",
        "荒诞型": "垃圾自己会长腿走的"
      }
    },
    {
      id: "electric",
      scene: "宿舍生活",
      text: "宿舍电费超了 200 块，没有任何人承认自己开了空调。",
      weight: 0.8,
      ownershipOverride: { roommate: 0.5, jiaowu: 0.4, didi: 0.0 },
      options: {
        "事实型": "电表读数和你的作息完全对得上",
        "情感型": "我这月生活费已经见底了",
        "转移型": "空调是宿舍标配，费用应由后勤承担",
        "反向型": "是你把温度调到 18 度的",
        "荒诞型": "水星逆行，电表走得快"
      }
    },
    {
      id: "noise",
      scene: "宿舍生活",
      text: "凌晨三点，有人在外放短视频。",
      weight: 0.8,
      ownershipOverride: { roommate: 0.8, fudaoyuan: 0.2, didi: 0.0 },
      options: {
        "事实型": "我录下来了，时间戳是 3:07",
        "情感型": "我明天八点有考试",
        "转移型": "宿舍管理条例第十条写得很清楚",
        "反向型": "是你先说我打呼的",
        "荒诞型": "这是宇宙送我的白噪音"
      }
    },
    {
      id: "tweet",
      scene: "社团活动",
      text: "社团活动的推文今晚要发，还没有人写。",
      weight: 0.9,
      tutorial: true,
      ownershipOverride: { xuezhang: 0.8, moyu: 0.5, didi: 0.2, daoshi: 0.0 },
      options: {
        "事实型": "排班表上这一栏写的是他的名字",
        "情感型": "我已经连做了三场活动的物料了",
        "转移型": "新媒体部和工作部的职责边界一直没划清",
        "反向型": "是学长说这次让我锻炼一下的",
        "荒诞型": "灵感被水星带走了"
      }
    },
    {
      id: "budget",
      scene: "社团活动",
      text: "社团活动经费超支 800 元，票据对不上。",
      weight: 0.7,
      ownershipOverride: { xuezhang: 0.9, jiaowu: 0.4, moyu: 0.3 },
      options: {
        "事实型": "报销单上签字的那个人不是我",
        "情感型": "我垫的钱到现在还没回来",
        "转移型": "财务审批流程本身就有漏洞",
        "反向型": "这个预算是您批的",
        "荒诞型": "通货膨胀，钱自己变少了"
      }
    },
    {
      id: "course",
      scene: "教务选课",
      text: "抢课失败，你被调剂到了《高尔夫球》。",
      weight: 0.9,
      tutorial: true,
      ownershipOverride: { jiaowu: 0.9, daoshi: 0.1, fudaoyuan: 0.3, didi: 0.0 },
      options: {
        "事实型": "系统日志显示我在开放第 3 秒就提交了",
        "情感型": "我已经连续三个学期抢不到课了",
        "转移型": "选课规则本身就没有公示清楚",
        "反向型": "培养方案是你们改的",
        "荒诞型": "我和这门课八字不合"
      }
    },
    {
      id: "ticai",
      scene: "教务选课",
      text: "体测 800 米没跑完，成绩栏写着「缺考」。",
      weight: 0.6,
      ownershipOverride: { jiaowu: 0.5, daoshi: 0.1, roommate: 0.0 },
      options: {
        "事实型": "那天校医院有我的挂号记录",
        "情感型": "我跑到第四圈真的喘不上气",
        "转移型": "体测时间和考试时间冲突了",
        "反向型": "是体育老师说可以先走的",
        "荒诞型": "跑道是逆时针的，影响运势"
      }
    },
    {
      id: "read",
      scene: "情感社交",
      text: "你发出去的消息，已经被读了 11 个小时。",
      weight: 0.8,
      ownershipOverride: { ex: 0.7, roommate: 0.1, didi: 0.0 },
      options: {
        "事实型": "已读的时间戳是 11 小时前",
        "情感型": "我删了重打了七遍才发出去",
        "转移型": "已读不回这个功能本身就是一种暴力",
        "反向型": "是你先说随时可以找你的",
        "荒诞型": "他正在经历水逆"
      }
    },
    {
      id: "groupchat",
      scene: "情感社交",
      text: "你在群里发的那句话，被截图转到了另一个群。",
      weight: 0.7,
      ownershipOverride: { ex: 0.4, roommate: 0.5, didi: 0.2, daoshi: 0.0 },
      options: {
        "事实型": "截图里被裁掉的前半句才是重点",
        "情感型": "我发那句话的时候手是抖的",
        "转移型": "转发的人没有征求过任何人的同意",
        "反向型": "是你先把我拉进那个群的",
        "荒诞型": "聊天记录被宇宙重新剪辑过了"
      }
    },
    {
      id: "birthday",
      scene: "情感社交",
      text: "你忘了那个人的生日，而对方记得你的每一个。",
      weight: 0.6,
      ownershipOverride: { ex: 0.5, roommate: 0.3, didi: 0.1, daoshi: 0.0 },
      options: {
        "事实型": "日历那天正好撞上期中周第三场",
        "情感型": "我不是不在乎，我只是害怕在乎",
        "转移型": "生日这件事本来就不应该拿来计分",
        "反向型": "是你自己说过不喜欢过生日的",
        "荒诞型": "我的时间感知在逆行里塌了"
      }
    },
    {
      id: "money",
      scene: "经济压力",
      text: "生活费在月底准时归零，而距离下个月还有 9 天。",
      weight: 0.7,
      ownershipOverride: { roommate: 0.0, jiaowu: 0.1, didi: 0.0 },
      options: {
        "事实型": "账单显示 63% 花在了食堂以外",
        "情感型": "我已经吃了四天挂面了",
        "转移型": "物价上涨不是我能控制的",
        "反向型": "是你们说大学要学会理财的",
        "荒诞型": "我的钱包也在水逆"
      }
    },
    {
      id: "offer",
      scene: "就业压力",
      text: "秋招结束了，你的 offer 数量是 0。",
      weight: 0.7,
      ownershipOverride: { daoshi: 0.2, jiaowu: 0.2, xuezhang: 0.1 },
      options: {
        "事实型": "我投了 87 份简历，只收到 3 个回复",
        "情感型": "我连续两个月每天改简历到凌晨一点",
        "转移型": "今年的招聘名额整体缩减了四成",
        "反向型": "是就业中心说这份简历没问题的",
        "荒诞型": "全体 HR 集体水逆"
      }
    },

    // ── 第三幕专属：selfish = 几乎只能怪自己的锅 ───────────
    // 这两口锅的存在意义是让「过去的自己」「未来的自己」不再是彩蛋，
    // 而是唯一说得通的选项 —— 这时候玩家会自己发现那个隐藏动词。
    {
      id: "late",
      scene: "自我管理",
      text: "凌晨四点睡，早上八点的课迟到了 40 分钟。",
      weight: 0.8,
      selfish: true,
      ownershipOverride: { jiaowu: 0.1, daoshi: 0.0, roommate: 0.1, didi: 0.0, moyu: 0.0 },
      options: {
        "事实型": "闹钟响过三次，我都按掉了",
        "情感型": "我这周真的没有一晚睡好",
        "转移型": "这门课本来就不该排在一二节",
        "反向型": "是您说过这门课不点名的",
        "荒诞型": "我的生物钟在另一个时区"
      }
    },
    {
      id: "scroll",
      scene: "自我管理",
      text: "说好复习一整晚，结果短视频刷到了凌晨两点。",
      weight: 0.8,
      selfish: true,
      ownershipOverride: { roommate: 0.1, jiaowu: 0.0, daoshi: 0.0, didi: 0.0 },
      options: {
        "事实型": "屏幕使用时间显示昨晚是 5 小时 12 分",
        "情感型": "我白天已经绷了一整天了",
        "转移型": "推荐算法本来就是为了让人停不下来",
        "反向型": "是室友先递给我手机的",
        "荒诞型": "手机自己亮起来的，我拦不住"
      }
    },
    {
      id: "sick",
      scene: "自我管理",
      text: "连续第五天没吃早饭，胃在第六天准时罢工。",
      weight: 0.6,
      selfish: true,
      ownershipOverride: { shitang: 0.2, roommate: 0.0, jiaowu: 0.0, didi: 0.0 },
      options: {
        "事实型": "食堂七点半就关门了，我七点四十才起",
        "情感型": "我最近真的连起床都很费劲",
        "转移型": "课表把早八排满了，本来就没有吃饭的时间",
        "反向型": "是阿姨说少吃一顿没关系的",
        "荒诞型": "我的胃在水逆"
      }
    }
  ];
});
