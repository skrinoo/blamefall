/**
 * 《锅从天降》 判定库清单导出器
 *
 * 用法：
 *   1. 双击打开 blamefall/index.html
 *   2. F12 打开控制台
 *   3. 把本文件整段粘进去回车
 *   4. 控制台会打印一份 JSON，把它保存为 scripts/manifest.json
 *
 * 为什么要这么绕：
 *   本机没有 Node，也没有可用的 Python（只有 WindowsApps 存根），
 *   跑不了任何构建脚本。但浏览器里 NPCS / ARGUMENT_TYPES / VERDICTS
 *   这三个全局已经是**游戏实际加载的那一份数据**，
 *   从这里导出可以彻底排除「手抄 data/*.js 抄漏一行」的可能。
 *
 * generate-verdicts.ps1 消费导出的 manifest.json。
 */
(function () {
  var KIND_RULES = {
    normal:   ["事实型", "情感型", "转移型", "反向型", "荒诞型"],
    abstract: ["事实型", "情感型", "荒诞型"],
    // self 类刻意留空：future_self / past_self 的文案写死在 npcs.js 的
    // fixedVerdict / fixedReaction 里，引擎走 source=fixed 分支，从不查库。
    self:     []
  };

  var manifest = {
    generatedAt: new Date().toISOString().slice(0, 10),
    rules: {
      typesForKind: KIND_RULES,
      abstractReactionRule: "抽象 NPC 无法开口，reaction 写成括号内的状态描述，不要写成台词。"
    },
    argumentTypes: Object.keys(ARGUMENT_TYPES).map(function (k) {
      var d = ARGUMENT_TYPES[k];
      return {
        name: k,
        basePower: d.basePower,
        desc: d.desc || "",
        keywords: d.keywords || [],
        locked: !!d.locked,
        unlockCredit: d.requiresCredit || null
      };
    }),
    npcs: NPCS.map(function (n) {
      var o = {
        id: n.id, name: n.name, kind: n.kind, scene: n.scene || null,
        difficulty: n.difficulty, moralCost: n.moralCost,
        prefers: n.prefers || [], dislikes: n.dislikes || [],
        desc: n.desc
      };
      if (n.formalBonus) o.formalBonus = true;
      if (n.suspend) o.suspend = true;
      if (n.fixedVerdict || n.fixedReaction) o.fixedText = true;
      return o;
    }),
    existingKeys: Object.keys(VERDICTS.entries).sort(),
    // 手法名单独导出一份。generate-verdicts.ps1 会把它整份塞进 prompt，
    // 让模型看得见「哪些名字已经被占了」。只给 existingKeys 不够——
    // 组合键里没有名字，模型无法据此避开重名（「磁场」曾被复用 4 次）。
    existingTechniques: Object.keys(VERDICTS.entries)
      .map(function (k) { return VERDICTS.entries[k].technique; })
      .filter(function (v, i, a) { return v && a.indexOf(v) === i; })
      .sort(),
    genericFallback: Object.keys(VERDICTS.generic).reduce(function (acc, k) {
      acc[k] = VERDICTS.generic[k].length;
      return acc;
    }, {})
  };

  // 覆盖率自检：应该生成哪些、已经有哪些、还缺哪些
  var expected = [];
  manifest.npcs.forEach(function (n) {
    (KIND_RULES[n.kind] || []).forEach(function (t) {
      expected.push(n.id + "::" + t);
    });
  });
  var have = {};
  manifest.existingKeys.forEach(function (k) { have[k] = true; });

  manifest.coverage = {
    expected: expected.length,
    present: manifest.existingKeys.filter(function (k) { return expected.indexOf(k) >= 0; }).length,
    missing: expected.filter(function (k) { return !have[k]; }),
    // 库里有、但规则认为不该有的（例如给 self 类误加了条目）
    unexpected: manifest.existingKeys.filter(function (k) { return expected.indexOf(k) < 0; })
  };

  var json = JSON.stringify(manifest, null, 2);
  console.log(json);

  // 顺手做一次可读性汇报，免得要去 JSON 里翻
  console.log("%c── 判定库覆盖率 ──", "font-weight:bold");
  console.log("应有 " + manifest.coverage.expected + " 条，实有 " + manifest.coverage.present + " 条");
  console.log("缺口 " + manifest.coverage.missing.length + " 条" +
    (manifest.coverage.missing.length ? "：" + manifest.coverage.missing.join(", ") : "（无）"));
  console.log("多余 " + manifest.coverage.unexpected.length + " 条" +
    (manifest.coverage.unexpected.length ? "：" + manifest.coverage.unexpected.join(", ") : "（无）"));

  // 重名手法自检：technique 全库不得重复，否则卷宗里会看到两条一模一样的学名
  var seen = {}, dup = [];
  Object.keys(VERDICTS.entries).forEach(function (k) {
    var t = VERDICTS.entries[k].technique;
    if (seen[t]) dup.push(t + "（" + seen[t] + " / " + k + "）");
    else seen[t] = k;
  });
  console.log("重名手法 " + dup.length + " 处" + (dup.length ? "：" + dup.join(", ") : "（无）"));
  console.log("已用手法名 " + manifest.existingTechniques.length + " 个（随 prompt 发给模型用于查重）");

  // 尝试直接下载成文件；file:// 下可能被浏览拦掉，那就手动复制上面的 JSON
  try {
    var blob = new Blob([json], { type: "application/json;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manifest.json";
    a.click();
    console.log("%c已触发下载 manifest.json", "color:#4ea8de");
  } catch (e) {
    console.warn("自动下载失败，请手动复制上面的 JSON：" + e.message);
  }
})();
