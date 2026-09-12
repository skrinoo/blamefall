# 《锅从天降》开发日志

> **本文件是提交材料里「人机协作与方法（15 分）」的主证据。**
>
> 它记录的不是「我们做了什么功能」，而是**「我们是怎么和 AI 一起把错误找出来的」**。
> 每一条都尽量附可复现的证据：代码里的断言、控制台里的扇展数据、或文档里的更正记录。
> 没有证据支撑的结论不写进来。

---

## 0. 一句话总结

这个项目最大的收获不是那 54 条判定文案，而是一条被撞了四次才学会的铁律：

> **凡是可以查表或可以用规则算出来的确定性游戏数据，一律不让 LLM 输出。**
> **LLM 只负责三件事：理解自然语言论证的质量、为一种行为命名、写一句有洞察的点评。**

下面记录这条铁律是怎么被撞出来的，以及撞墙过程中顺手发现的六个真 bug。

---

## 1. 模型选型对比表

同一个任务（4 个甩锅案例的判定文案），在不同模型上的真实表现：

| 模型 | 网关 | 正式回答 | completion_tokens | 手法名质量 | 结论 |
|---|---|---|---|---|---|
| **gemini-2.5-flash** | `openai-next` | ✅ 完整 JSON | **525** | 「特长强征法」「星象归因流」「轮次对账单」 | **✅ 采用** |
| step-3.7-flash | `stepfun` | ❌ **空字符串**，只回吐思维链 | **4409** | 四个全是「XX甩锅」（技能甩锅 / 玄学甩锅 / 对等甩锅） | ❌ 禁用 |
| 任意模型 | `aiping` | — | — | — | ❌ **HTTP 402 余额不足**，整个网关不可用 |

### 三条选型结论

**① 禁用一切思考型模型。**
step-3.7-flash 在 `max_tokens=2500` 下把预算全烧在思维链上，`message.content` 是空的。
8.4 倍的 token 换来 0 字节的可用输出。这不是「效果差」，是**功能性失效**。

> 这个失效形态直接写进了代码：`engine/api.js` 的 `validate()` 第一条就是
> `if (typeof raw !== "string" || !raw.trim()) return null;`
> `scripts/generate-verdicts.ps1` 的 `Invoke-Chat` 在 content 为空时**显式抛错并附 usage**，
> 而不是静默返回空。两处注释都写明了原因。
>
> **「有返回」不等于「可用」**——这是本项目最重要的一条工程直觉。

**② completion_tokens 是选型的关键指标，不是 latency。**
延迟可以靠乐观 UI 掩盖（2.0s 飞行动画覆盖 1850ms 判定预算），token 烧光了没法掩盖。

**③ temperature 分场景。**
实时裁判 `0.85`（要稳定命中格式），批量文案 `0.92`（要 54 条互不重样）。
`max_tokens = 0`（本网关语义为「不限制」；严格 OpenAI 兼容实现下需改成实际值，脚本参数已暴露）。

---

## 2. 最重要的架构发现：把 AI 从热路径上摘掉

### 发现过程

最初的设计是「每次甩锅都调 AI 判定」。写数据表时注意到一件事：

> 快速选项（`pot.options` 里的 4-5 条理由）的文本是**写死的**。

文本写死 ⇒ 判定结果可以在构建期一次性生成 ⇒ 运行时纯查表。

### 这一刀买到了三样东西

| | 调 AI | 查表 |
|---|---|---|
| 延迟 | ~800ms（需要乐观 UI 掩盖） | **0ms** |
| 成本 | 每次约 130 tokens | **0** |
| 断网 | 不可玩 | **可玩** |

实测约 **90% 的操作走查表路径**。只有「自由输入」才真的调 `/api/judge`。

### 落地形态

```
data/verdicts.js   54 条判定库（9 normal NPC × 5 类型 + 3 abstract NPC × 3 类型）
                 + 每种类型 3 条通用兜底文案（库未命中时轮换）
engine/fallback.js 说服力 S 对固定文本实算（关键词表 + 长度 + 类型匹配 + 公文腔）
engine/api.js      只管自由输入，返回值只有「通过校验的对象」或 null
```

> **副作用（后来才意识到很重要）**：因为快速选项走查表，
> `QUICK_CAP = 85` 让它的说服力**永远够不到** `CRIT_S = 88`。
> 「完美论证」暴击于是成了自由输入的专属奖励——
> 这个设计不是规划出来的，是架构决定的副产品。第 5 节的扇展数据证明它成立（`crits = 0`）。

---

## 3. 四次撞同一堵墙

同一条铁律，用四次真实的失败换来。每次都是「让 LLM 输出一个本该确定的数值」。

### 第一次：`moral_cost` 漂移

v1 prompt 让模型判断这次甩锅的道德代价（低/中/高）。
**同一个输入（甩给学弟学妹）两次调用分别返回「高」和「低」。**

道德代价完全由 NPC 身份决定——欺负学弟学妹代价高，甩给天气代价低。
这是查表数据，不是判断题。

→ v2 加了 NPC→低/中/高 的**锁定表**，让模型「查」而不是「判」。

### 第二次：`argument_type` 漂移

同一个案例（C2）两次调用分别判成「转移型」和「反向型」。

→ v2 补了五类型的**定义 + 例句**。有效，但没根治——
真正根治是 v3 把它从「自由判断」变成「五选一 + 前端白名单校验」。

### 第三次：`pot_ownership` 错判（**最危险的一次**）

gemini-2.5-flash 把「导师」对「小组作业 PPT 没人做」的锅归属判成 **0.8**。
正确值是 **0.1**——PPT 是学生的活，跟导师关系极小。

为什么危险：G 占 P 公式 20% 权重。

```
ΔG = 0.8 − 0.1 = 0.7      ΔP = 0.7 × 0.2 = +0.14
```

**+0.14 足以翻转任何边界案例**（阈值 0.6）。一个 0.55 的失败会被判成 0.69 的成功。
而且它不会报错，不会崩溃，只会让玩家觉得「这游戏判定很玄」。

→ v3 **删除 `pot_ownership` 字段**，改为引擎静态查表：
`pot.ownershipOverride[npcId]` 优先，回落到 `npc.potOwnership`。

### 第四次：`power_success` 把荒诞型评成全场最强

批量生成判定库时，让模型一并输出成功/失败两套说服力基线。
拿到的结果：

| 组合 | 模型给的 `power_success` | 设计意图 |
|---|---|---|
| 荒诞型 → 学弟学妹 | **90** | basePower = 10，本该几乎必败 |
| 荒诞型 → 摸鱼组员 | **92** | 同上 |

**一个「水星逆行」成了全游戏最强论证。** 如果这批数值落盘，整个数值系统当场崩塌：
玩家会发现最优策略是对着所有人喊玄学，而游戏想说的「厘清责任才有最高 P 值」彻底失效。

→ 判定库里**删除所有数值字段**，说服力改由 `engine/fallback.js` 对固定文本实算。
→ 这条教训被写进 `scripts/prompt-lib-batch.txt` 的第二节，标题是
「**绝对禁止输出任何数值（硬约束）**」，并且附上了上面这个荒诞型 90-92 的完整故事。
→ `scripts/generate-verdicts.ps1` 的 `Test-VerdictItem` 用字段名黑名单强制执行：

```
(?i)power|score|persuas|rate|prob|rating|weight
```

**模型只要敢打分，条目就被丢弃并记进失败报告。** 不是靠 prompt 求它，是靠代码拦它。

> ### 为什么第四次才学会
>
> 前三次的失败形态都是「数值不稳定」，还能安慰自己「多试几次 / 加 few-shot 就好了」。
> 第四次是「数值很稳定，但稳定地错」——荒诞型两次都是 90+。
> **模型不是判得不准，是它的审美和游戏的设计意图根本不一致。**
> 它觉得一句漂亮的话就该得高分，而游戏需要这句话在数值上必然失败。
>
> 这个分歧无法用 prompt 修复。只能把它从这条链路上摘掉。

---

## 4. Prompt 迭代记录

完整的版本史、每一版的动因与实测证据在 **`prompts/judge-v3.md`**，此处只列骨架：

| 版本 | 字段数 | 核心变更 |
|---|---|---|
| v1 | 7 | 初版，全交给模型判断 |
| v2 | 7 | 加 `moral_cost` 锁定表、五类型定义 + 例句、few-shot、禁 markdown 围栏 |
| v3 | **5** | 删 `pot_ownership`、删 `moral_cost`、`npc_reaction` 拆成成功/失败两条 |
| v4-lib | **4** | 批量生成侧删掉 `power_success` / `power_fail`，加手法名查重清单 |

字段数从 7 降到 4，**降的全是数值字段**。文案字段一个没少。

### 一条反直觉的 prompt 教训

v4-lib 之前有一批生成，**9 条 verdict 全在复读同一句话**。

排查发现根因：那句话出现在了 prompt 的**字段说明**里当示范。
模型把它当成了必抄模板。

→ 修法不是加「禁止复读」的约束，而是**把示范句从字段说明里删掉**，
并在 `prompt-lib-batch.txt` 里给错误示范时明确写上：

> 上面这个错误示范本身也不许出现在你的输出里，
> 下面的正确形态同样不许照抄，只供你理解格式。

**给模型看的每一个完整句子，都有可能变成它的模板。**

---

## 5. 平衡：用全量扇展代替试玩

### 为什么不能靠试玩

一局 60 秒，玩家大概甩 10-15 次。要覆盖 `17 锅 × 14 NPC × 5 类型 = 1190` 个组合，
需要打上百局，而且**低概率路径（暴击、反甩、悬空）几乎抽不到**。

→ 每次改公式或改数据表，都在浏览器控制台里把 1190 个组合全跑一遍真实的 `judge()`。
本机无 Node，但浏览器里 `NPCS` / `POTS` / `ARGUMENT_TYPES` 就是游戏实际加载的那一份数据，
**不存在「测试数据和线上不是同一份」的问题**。

### 第一轮扇展暴露的问题

```
1050 组合（当时 15 口锅）
总胜率 48.9%   暴击 0   悬空 75   锁定 0

四个 NPC 胜率异常：
  社团学长  4/75 = 5.3%
  教务处    2/75 = 2.7%
  前任      钥匙孔仅 5 格
  导师      0/75（最佳 P = 0.408）
```

### 关键判断：这四个不是同一个病

最容易犯的错误是把四个 `baseAcceptance` 一起调高。逐个看数据后发现病因完全不同：

| NPC | 真实病因 | 修法 | 为什么不是调数值 |
|---|---|---|---|
| 社团学长 | `prefers` 只有转移型，社团锅的 `ownershipOverride` 只有 0.6-0.7 | `prefers` 加「事实型」；tweet/budget 的 override 提到 0.8/0.9 | 排班表、报销单都是白纸黑字，「事实型」在主题上本来就成立——是数据表漏了，不是他太难 |
| 教务处 | **`desc` 写着「理由含书面语时说服力额外加成」，引擎从未实现过** | `fallback.js` 加 `FORMAL_WORDS`（24 词）+ `npc.formalBonus` 开关，命中给 `min(hits×4, 12)` | **数据表许下的承诺必须由引擎兑现。** 调高数值只是把 bug 盖住 |
| 前任 | **锅池只有 1 口情感社交锅**，是内容缺口 | 新增 `groupchat` / `birthday` 两口锅（15 → 17）；`baseAcceptance` 20 → 68 | 他的难度应当全部来自三重锁（场景锁 + 类型锁 + 50% 反甩）。锁够了，数值就该放开 |
| 导师 | 设计如此 | **不改** | 他是暴击专属目标。常规路径推不动是正确的 |

> ### 「前任」那一格值得单说
>
> 他的 `baseAcceptance` 从 20 提到 68，看起来是「降低难度」，实际是**把难度搬到该在的地方**。
>
> 三重锁已经足够难：只有情感社交场景的锅递得过去、只有情感型论证听得进去、
> 即使都对还有一半概率被反甩。
>
> 但**钥匙对的时候必须能开**。如果三重锁全对了还是失败，
> 玩家学不到「哦，前任只吃这一套」这条规则，只会觉得游戏在耍他。
>
> 这条经验被写进了 `npcs.js` 的注释：
> **「难度应全部来自锁」**——锁是可学习的规则，数值只是不可学习的墙。

### 第二轮扇展（最终数据）

```
1190 组合（17 锅 × 14 NPC × 5 类型）

selfTest()          4/4 通过
总胜率              51.8%
暴击数              0        ← QUICK_CAP 生效的证明
悬空数              85
锁定数（信用 9）    0

对照组（接锅信用 = 0，正常开局）：
  胜率 40.7%   锁定 238 次   反向型对真实 NPC 0 胜
```

**三条设计支柱在数值层面全部成立：**

1. **暴击只属于自由输入。** `crits = 0` 证明 `QUICK_CAP = 85` 生效，
   快速选项永远够不到 `CRIT_S = 88`。这个爽点必须靠玩家自己打字换来。
2. **荒诞型万能但无用。** 对真实 NPC `0/153`，对抽象 NPC `85/85`。
   永远甩得出去，永远只值 30 分。纯粹的解压阀，不是策略选项。
3. **反向型是接锅换来的大招。** 信用 0 时 `locked 238 / 真实 NPC 0 胜`；
   信用 ≥ 3 时 `48/153 = 31%`，从「比荒诞型还弱」跳到**第二强论证**。

   ```
   事实型 94 (61%) > 反向型 48 (31%) > 情感型 30 (20%) > 转移型 20 (13%) > 荒诞型 0 (0%)
   ```

### `selfTest()`：把文档表格换成可执行断言

`prompts/judge-v3.md` §4 有一张「引擎复算表」，最初是**手算**的。
本次校对发现三处错了：

| 案例 | 手算 | 引擎实算 | 错在哪 |
|---|---|---|---|
| 学弟学妹 · 事实型 | 0.72 | **0.70** | 文档一处用 G=0.3、另一处用 G=0.2；实际 `ppt.ownershipOverride.didi` = 0.2 |
| 室友 · 事实型 | 0.80 | **0.82** | 取了 `npc.potOwnership` 0.5，但 `trash` 对室友有 `ownershipOverride` **0.6**，覆盖优先 |
| 导师 · 反向型 | A「5−20 触反感」 | **A「5−8 关系惩罚」** | 反向型解锁后**免疫**反感惩罚，A=0 纯粹来自关系惩罚 |

三处都不是公式错了，是**手算时取错了数据源**。

→ 教训固化进代码：`game.js` 的 `selfTest()` 每次开局跑四条断言，
期望值写死在代码里，引擎或数据表一改就当场报错。

> **能用可执行断言表达的东西，就不要用文档表格表达。**

顺带一个细节：`selfTest()` 里 `catchCredit` 给的是 **9 而不是 0**。
因为第二条案例是导师·反向型，信用不足时它会走 `locked` 短路直接 P=0——
那样测的是锁，不是公式。**自检必须测公式。**

---

## 6. 浏览器实测抓到的六个 bug

原型做完后在真实浏览器里逐环节验证（用 `.click()` 驱动全链路 + DOM 断言）。
下面六个都是**试玩时看不见、只有断言能抓到**的问题。

### ① 结算标题行重复渲染，尾巴挂着一个永远为 0 的陈旧值

```js
$("report-score").innerHTML = "得分 <b>100</b> · 心理阴影面积 <b>2</b> · 撑满了 60 秒";
```

`#report-score` 是个 `<b>`，代码把**整句**塞了进去。
而它原本的兄弟节点 `<span>·</span> 心理阴影面积 <b id="report-shadow">0</b>` 仍留在 DOM 里。
页面实际渲染成：

> 得分 **得分 100 · 心理阴影面积 2 · 撑满了 60 秒** · 心理阴影面积 **0**

同一句话渲染两遍，尾巴还挂着一个 stale 的 0。

→ 给 `<p>` 加 `id="report-scoreline"`，改写整个 `<p>`。
实测断言：`staleSiblingGone: true`。

### ② 段位评语与同页数据自相矛盾

得分 100（一次成功甩给学弟学妹，difficulty 1.0 × 100）落在「甩锅新手」档位之下
（当时 `min: 150`），命中底档「锅的合法持有人」，其评语是：

> 「本局没有任何一个人真正接下你的锅。」

而同页的数据卡明确写着 **1 次成功**。

→ 两处修改：
- 「甩锅新手」`min` 从 150 降到 **100**——100 正是全库最低的非零得分
- 底档评语重写为：「本局没有任何一个人真正接下你的锅。它要么还在你身上，
  要么被你挂到了天气和水逆头上。」
  这样只甩给天气/水逆（每次 30 分）的玩家仍落在底档，而这句话对他们也成立。

> **文案不能只是「写得漂亮」，它必须在本档位的全部数据形态下都为真。**

### ③ 接锅在教学时刻数值完全无感

接锅是全游戏**唯一**能降低心理阴影面积的手段（−8）。
但阴影从 0 开局，玩家第一次按下那个隐藏按钮时——正是整个游戏的教学时刻——
`clamp(0 − 8, 0, 100) = 0`。

飘字写着「阴影 −8」，数字纹丝不动。**接锅看上去完全无效。**

→ 三处修改：
- 新增 `SHADOW_BASELINE = 12` 作为开局阴影。
  12 刚好等于「一次接锅能看到明确下降、又不至于开局就像已经崩了一截」。
  主题上也成立：**你上大学到现在，已经背过一些锅了。**
- `catchSelf` 计算 `shadowApplied = S.shadow - shadowBefore`，
  飘字与开发者日志都报**实际生效值**而不是意图值。
- 同样的问题在 `crashPot` / `slipPot` / `finishThrow` 里也修了：
  这三处都补了 `updateHud()`，让得分与阴影不再依赖下一帧。

### ④ 疲劳值开局显示 `-0`

```js
chip.querySelector(".npc-fatigue").textContent = "-" + (n.fatigueStep * t);
```

`t = 0` 时，开局十四个 chip 同时挂着 **`-0`**，看上去像已经甩过一轮了。

→ `t > 0 ? "-" + (n.fatigueStep * t) : "0"`

### ⑤ 「悬空」被误归为「失败」

辅导员的结局是锅悬空不落：既没得分，也没代价。
但它走的是 `success = false` 分支，于是被计进 `stats.fail`，
体质报告会把「被辅导员按住」误报成「你甩不动」。

画面上也更糟：玩家看到「甩锅失败」四个大字，却既不掉血也不扣分——**一个自相矛盾的画面**。

→ 把 `suspend` 从后置覆盖提成 `judge()` 里的**独立结局分支**，放在结算数值之前 return。
游戏侧独立统计 `stats.suspended`，配独立的视觉语言：
中性灰 `--hold: #7c8798`（既不好也不坏，所以不给它情绪色）、
锅 `.pot.suspended`（轻轻浮住，不抖也不弹）、chip `.npc.hold`、气泡 `.bubble.hold`、
标签「悬 空」、日志 mark「悬」。

结局从四种变成**五种**：成功 / 失败 / 被反甩 / 延期交付 / 悬空。

### ⑥ prompt 规格文档漏了一个 NPC

`prompts/judge-v3.md` §2 的【NPC 性格】清单里有 11 个 NPC，**漏了「前任」**。
他是能接自由输入的真实 NPC，模型会拿不到任何语气指导。

→ 已补，并在文档里写清了这份静态清单与 `npcs.js` 的关系：
请求体逐次注入的 `npcDesc` 是权威人设，静态清单提供的是整张权力关系图；
两者会漂移，改 NPC 名单时必须同步。

---

## 7. 工程环境踩坑

### 零构建约束

本机**没有 Node/npm**，Python 只有 WindowsApps 存根。这条约束决定了整个技术形态：

- 原型零构建、零依赖，双击 `index.html` 即玩
- 全部用经典 `<script>` 而不是 ES module——**`file://` 下 module 会被 CORS 拦掉**
- 自写 UMD 包装器
- 批量生成脚本用 PowerShell，不是 Node

### UMD 作用域 bug（代价最大的一次）

```js
(function (root, factory) {
  var data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.JudgeAPI = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // ❌ 工厂函数里拿不到外层的 root 形参
  var CFG = root.BLAMEFALL_CONFIG || {};   // ReferenceError

});
```

浏览器里直接抛 `ReferenceError`，**连带 `game.js` 整个没启动**——
页面白屏，控制台只有一行错，看上去像 HTML 写坏了。

→ 工厂内自己再取一次全局：

```js
var G = (typeof globalThis !== "undefined") ? globalThis
      : (typeof window !== "undefined") ? window : {};
```

这段注释现在写在 `engine/api.js` 第 29-30 行，注明了它曾经炸过。

### PowerShell 5.1 的九个坑

坑 1-5 在 `scripts/generate-verdicts.ps1`，坑 6-9 在 `scripts/dev-server.ps1` / `smoke-test.ps1`。
全部在各自脚本里规避并注明「改动时请勿简化掉」：

| # | 坑 | 表现 | 规避 |
|---|---|---|---|
| 1 | `.ps1` 含中文必须存为 **UTF-8 with BOM** | 5.1 无 BOM 时按系统 ANSI 代码页读，中文注释与字面量全成乱码 | 显式重编码，脚本 `.NOTES` 里写了修复命令 |
| 2 | `Invoke-RestMethod` 用字符串 body | 按 ISO-8859-1 编码，**中文请求体全废** | 传 `[Text.Encoding]::UTF8.GetBytes($json)` 字节数组 |
| 3 | 网关响应不带 charset | 5.1 把 UTF-8 当 Latin-1 解，**中文响应全废** | 自己从 `RawContentStream.ToArray()` 按 UTF-8 解码 |
| 4 | **`param` 的类型约束在整个脚本作用域持续生效** | 见下 | 变量改名 |
| 5 | **管道会展开单元素数组** | 见下 | `@()` 包住 |
| 6 | **Content-Length 是字节数，`StreamReader.Read(buf,i,n)` 的 n 是字符数** | UTF-8 汉字 3 字节只算 1 字符 → 永远差一截 → 阻塞至 ReceiveTimeout 抛异常。**纯 ASCII body 正常，中文 body 挂死** | 改字节级 `List[byte]` 读取；header 按 ASCII 解，body 先补齐字节再整体 UTF-8 解码 |
| 7 | **`ConvertTo-Json` 把非 ASCII 转义成 `\uXXXX`** | 发出去是纯 ASCII 字节 → 编码断言永远为真，等于没测 | 手拼 JSON 字符串 + `UTF8.GetBytes()` |
| 8 | **`netstat` / `Get-CimInstance` 在沙箱里间歇性被拒绝访问** | netstat 失败 → `$left` 为 null → else 分支打印「已释放」= **假阳性**；CIM 失败 → `found=0` 看着像没进程 | 改用 .NET API 三重验证（`Get-Process` + `TcpClient.BeginConnect` + `TcpListener.Start` 试绑） |
| 9 | **CIM 过滤条件字符串会自匹配当前查询进程** | `Where-Object { $_.CommandLine -like '*dev-server.ps1*' }` 命中了执行查询的 powershell 自己 | 逐个查 CommandLine 全文 + CreationDate 甄别，不盲目批量 kill |

#### 坑 4：`[string] $Manifest` 与 `$manifest` 是同一个变量

PowerShell 变量名**不区分大小写**。脚本里 `$Manifest` 是路径参数（`[string]`），
`$manifest` 是解析出的对象。它们是同一个变量。

给一个 `[string]` 类型的 param 赋 PSCustomObject，PowerShell **静默强转成字符串**，不报错：

```
type=String  len=629  npcs=1     ← 对象被 ToString() 成了 629 字符
```

随后 `$manifest.npcs` 变成对字符串取属性 → `$null` → `foreach` **零次迭代**。
整个工作清单为空，脚本只会平静地告诉你「没有需要生成的条目」。

排查这个花的时间比写脚本还长——因为它**没有任何错误信号**。

**同一个坑在本次会话又踩了一次**：`scripts/stitch-shots.ps1` 的 param 是
`[string]$Top`，而函数返回值赋给了 `$top` —— 同一个变量，哈希表被静默强转成字符串，
`$top.H` 变 `$null`，`[Math]::Min($null, 1394)` 再被强转成 0，
最后报出一句完全指错方向的「两张图宽度不一致：top= bottom=2512」。
而 `$bot` 因为和 `$Bottom` 不同名所以安然无恙 —— **一半坏一半好，比全坏更难查**。

→ 解析结果改名 `$mf`，并加了地基断言：

```powershell
foreach ($req in 'npcs', 'argumentTypes', 'existingKeys') {
    if (@($mf.$req).Count -eq 0) { throw "manifest 解析异常：字段 '$req' 为空。" }
}
```

**静默失败必须被改造成吵闹失败。**

#### 坑 5：`Group-Object` 只有一个分组时

```powershell
$byNpc = $work | Group-Object -Property { $_.Npc.id }   # 1 个分组时返回裸 GroupInfo
$byNpc.Count      # → 5（组内条目数），不是 1（分组数）！GroupInfo 自己有 Count 属性
$byNpc[1].Group   # → $null（对标量索引）
```

后果：5 个条目被切成 2 批共 **9 个槽位**，prompt 里出现 4 个
「`npc_id = （空）`」的幽灵组合。

→ `$byNpc = @($work | Group-Object ...)`，并在 chunk 循环里加 null 保护。
修完复算：`15 + 15 + 15 + 9 = 54`，`npc_id` 空值 0 个。

### Vercel 部署的坑：`config.runtime` 不再接受 nodejs 值

2026-09-11 首次部署 5 秒就失败，日志只有一行：

```
Error: api/health.mjs: unsupported "runtime" value in `config`: "nodejs20.x"
```

`export const config = { runtime: "nodejs20.x" }` 是旧版 Vercel 文档的标准写法，
现在 `runtime` 只认 `"edge"`，Node 版本改由项目设置的 Node.js Version 控制。
阴险之处在于**本地一切正常**：dev-server 不看这个键，冒烟测试 29/29 全绿
也完全不预警 —— 唯一能暴露它的地方是部署日志。

→ 两个 `.mjs` 删掉 `runtime` 键只留 `maxDuration`，原位置加警示注释防止被加回去；
同步记入 `docs/DEPLOY.md` §3 故障对照表。

### vercel.app 在大陆的双层封锁：前一天的 200 是窗口期

2026-09-12 早上复测生产域名：连接超时。逐层查：

1. `Resolve-DnsName blamefall.vercel.app` → `2a03:2880:…face:b00c:…`（Meta 的 IPv6 段）
   + `199.96.58.177`（Twitter 段）—— 根本不是 Vercel 的 IP
2. 换 `-Server 8.8.8.8` / `1.1.1.1` → **同样拿到伪造答案**：污染发生在传输途中，不是本机配置
3. 绕过 DNS 直连 Vercel 边缘 `76.76.21.21:443`：TCP 通，但
   `SslStream.AuthenticateAsClient('blamefall.vercel.app')` 在握手时被 RST 强断 → SNI 层封锁

结论：DNS + SNI 双层封锁，前一天拿到的 200 是窗口期。
评委在大陆网络，单挂 vercel 链接等于赌运气。

→ 双链接：GitHub Pages 镜像保底（可玩，自由输入自动降级本地裁判）；
Vercel 挂自定义域名保 AI 完整版（污染与黑名单都按域名匹配，换自有域名两层同时绕过）。
查证方法与配置步骤记入 `docs/DEPLOY.md` §8。

**同日修正：封锁是波浪式间歇，不是永久。** 午间复测同一台机器：
`blamefall-yy3a.vercel.app` 全程可达，probe min/median/max = 1289/1373/1537，
全在 1850 预算内；同一波里 `github.io` 可达而 `github.com:443` 的 push 断
—— 域名选择性进一步佐证匹配按域名。
早上那段的每一句在当时都真，但外推成「永久双层封锁」就错了 —— **间隔复测才是可达性的唯一证据**。

**同日二次修正：`-yy3a` 不是部署哈希，是项目名。** 创建时 `blamefall` 撞全局已有项目
被自动加后缀；Domains 页只有 `blamefall-yy3a.vercel.app` 一条 Valid。
09-11 测的 `blamefall.vercel.app` 已被释放（再测连接层直接拒），
README 改挂项目域名 + Pages 镜像两条，释放域名不再出现。
结论不变且更强：不赌单链接。

**同日三次落地：把「间隔复测」从人工动作变成一条命令。** 既然可达性随时在变，
README 里手写的「✅ 已上线」写下那一刻就开始过期 —— 这本身就是个会撤谎的文档。
新增 `scripts/check-links.ps1`：实测两条链接 → 重写 README 的
`<!-- LINK-STATUS:START/END -->` 标记块（含巡检时间戳）。
判定与冒烟测试同源：**不看状态码看内容**——Vercel 要求 `/api/health` 返回 `ok=true`，
Pages 要求 body 含 ASCII 标记 `screen-title`（不用中文标记，避开字符集解码坑）。
不可达时如实写「本机此刻不可达，不可达 ≠ 挂了」而不是谎报宕机。
链接清单写在脚本顶部 `$Links`，是唯一真相，以后换域名只改这一处。
（首跑实测：当时正处封锁波，vercel 分支如实报不可达、pages 分支报 200 可达，
两条分支行为符合预期；health 解析分支另用仿真 JSON 单独验证。）

### 工具层的两个约束

| 约束 | 应对 |
|---|---|
| `evaluate_script` 有 **15000ms 硬超时**，且超时后残留 promise 会继续在页面里跑 | 立即 `reload` 杀掉残留；把长流程拆成 ≤12s 的短脉冲，利用「页面状态在调用之间保持」把上一段末尾当下一段开头 |
| 标签页 `visibilityState = hidden` 时 **`requestAnimationFrame` 完全不触发**，**`setTimeout` 被节流约 +650ms** | 游戏时钟/握持预算/spawn 全冻结；`setTimeout(1350)` 实测 1999ms（drift 恒定 ~650ms 与请求时长无关）。同步 `.click()` 仍可驱动全链路，但**所有基于时间的测量在 hidden 页面不可信**；`take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` |

> rAF 冻结一开始被误判成引擎 bug。
> 查证过程：Grep `function loop(` → 发现 `dtReal = Math.min((ts - lastTs) / 1000, 0.05)`
> **dt clamp 本来就是对的**，且 `updateHud()` 只在 loop 里调 → 确认是 rAF 没触发，不是算错了。
>
> 但这个环境问题换来一个真实改进：`updateHud()` 被加进
> `finishThrow` / `catchSelf` / `crashPot` / `slipPot` 四处，
> 让得分与阴影这两个最重的反馈**不再依赖下一帧**（16ms 也是浪费）。

### SearchReplace 类工具的两个坑

- **中文分隔线注释绝不放进匹配文本。** `// ── 收尾 ──────` 这种破折号数量对不上就失配，
  本次会话失败了 3 次。改用 3 行纯代码做锚点，靠变量名差异保证唯一性。
- **Grep 会在匹配行上剥离缩进**（上下文行保留缩进，匹配行没有）。
  直接拿 Grep 输出当匹配文本必失配。需要精确原文时一律改用 Read 指定行区间。

---

## 8. 人机协作方法论沉淀

可直接摘录进飞书文档的六条：

### ① 分清「判断题」和「查表题」

给 LLM 的每一个字段都要问一句：**这个值是唯一确定的吗？**
是 → 查表 / 规则计算，不要给模型。
不是 → 才交给模型。

本项目 7 个字段里有 4 个是查表题，全都出过问题。

### ② 不要靠 prompt 求模型，要靠代码拦模型

`prompt-lib-batch.txt` 写了「绝对禁止输出任何数值」，
`generate-verdicts.ps1` 同时用字段名黑名单强制执行。

**prompt 是软约束，校验器是硬闸门。两个都要，但只有后者可靠。**

### ③ 给模型看的每个完整句子都可能变成模板

那批 9 条复读的 verdict，根因是示范句写在了字段说明里。
写 prompt 时要区分「格式示范」和「内容示范」，后者尽量不给完整句子。

### ④ 平衡性要用全量扇展验证，不要用试玩

试玩一局覆盖 15/1190 = 1.3% 的组合，而且抽不到低概率路径。
扇展脚本几十行，跑一次几秒钟，能直接指出「哪四个 NPC 有问题」。

### ⑤ 数据表许下的承诺，引擎必须兑现

教务处的 `desc` 写了「理由含书面语时说服力额外加成」，而引擎从来没实现过。
这个 bug 的表现是「教务处胜率 2.7%」，看起来像数值问题，实际是**机制缺失**。

→ 校对数据表时，把每一句 `desc` 都当成一条待验证的需求。

### ⑥ 静默失败必须改造成吵闹失败

三个实例：
- `[string]` param 被赋对象 → 静默强转 → 工作清单为空 → 「没有需要生成的条目」
- 思考型模型返回空 content → 静默 → 气泡空白
- `selfTest()` 期望值写死 → 引擎一改就当场报错（这个是正面例子）

**每一个「平静地告诉你没事」的分支，都值得再检查一遍它是不是真的没事。**

---

## 9. 当前状态与已知阻塞

### 已完成

```
blamefall/
├── README.md               公开仓库门面（含实测验证表）
├── .gitignore              含 !.env.example 例外
├── .env.example            环境变量模板（全空值，无占位密钥）
├── vercel.json             includeFiles 把 prompts/ 打进 lambda bundle
├── index.html              双击即玩，零构建零依赖
├── style.css               含五种结局各自的视觉语言
├── game.js                 四动词 + 三幕节奏 + 五结局 + selfTest + 开发者面板
├── api/
│   ├── _gateway.mjs        共享层（judge 与 health 走同一条上游路径）
│   ├── judge.mjs           主裁判端点（144 行，刻意做薄）
│   └── health.mjs          健康检查 + 延迟实测（probe 串行 × 3）
├── data/
│   ├── npcs.js             14 NPC
│   ├── pots.js             17 锅
│   ├── arguments.js        5 论证类型
│   ├── verdicts.js         54 条判定库 + 每类型 3 条通用兜底
│   └── commentary.js       解说词 + 段位评语
├── engine/
│   ├── judge.js            P 公式 + 完美论证暴击 + 五种结局
│   ├── fallback.js         说服力实算（含公文腔加成）
│   └── api.js              自由输入客户端，1850ms 预算（实测反推）+ autoSameOrigin + 全字段校验
├── prompts/
│   ├── judge-v3.txt        system prompt 唯一权威副本（64 行，UTF-8 无 BOM）
│   └── judge-v3.md         prompt 规格 + 版本史 + 引擎复算 + 平衡扇展
├── docs/
│   ├── DEVLOG.md           本文件
│   ├── DEPLOY.md           部署指南 + 故障对照表
│   └── shots/              01-title / 02-game / 03-report（拼接）
├── scripts/
│   ├── export-manifest.js  浏览器控制台导出判定库清单 + 覆盖率自检
│   ├── manifest.json       54/54 覆盖，无缺口无多余
│   ├── prompt-lib-batch.txt v4-lib system prompt（批量生成用）
│   ├── generate-verdicts.ps1 批量生成器（DryRun 已验证：54 条 / 4 批 / 0 幽灵）
│   ├── dev-server.ps1      本地 HTTP 服务器（MOCK/PROXY 双模式，TcpListener 手写）
│   ├── smoke-test.ps1      29 条断言，本地与生产通用
│   └── stitch-shots.ps1    截图纵向拼接（重叠区行匹配 + 横向偏移搜索）
└── assets/
```

### 已知阻塞与待办

| 项 | 状态 | 说明 |
|---|---|---|
| `/api/judge` 服务端 | ✅ 已写完 | `_gateway.mjs` + `judge.mjs` + `health.mjs`；冒烟测试 29/29 全绿（MOCK 模式）；浏览器端到端 423ms 返回 |
| `/api/judge` 端到端延迟 | ✅ 已实测 | 2026-09-11 生产 probe：min/median/max = 1560/1711/2207ms 无错误码；1350ms 预算击穿，按 DEPLOY.md §4 重算为 timeout 1850 / flightMs 2000 |
| 公开仓库 + README | ✅ 已推送 | `skrinoo/blamefall` 公开（已改名）；密钥扫描三条正则：真密钥形状 0 命中 |
| Vercel 部署 | ✅ 已上线 | `blamefall-yy3a.vercel.app`（项目名撞名被加后缀）；首次部署栽在 `config.runtime: "nodejs20.x"`（Vercel 只认 edge），删键后 Git 集成自动重部署成功；health 三绿 |
| 大陆可达性 | ✅ 多链接 | 封锁为波浪式间歇（波内 DNS 污染 + SNI RST，窗口期全绿）；README 挂 Pages 镜像 + 项目域名 `blamefall-yy3a.vercel.app` 两条；生产冒烟 28/28 全绿 |
| 截图验证 | ✅ 已补 | MCP 的 `take_screenshot` 确认不可用（无头实例 `attached=false`，与 IDE 预览面板是两回事）；改为用户手动截图 + `stitch-shots.ps1` 拼接卷宗页（overlap=616 行 / xoff=5px，接缝不可见） |
| `aiping` 网关 HTTP 402 | 🔴 阻塞 | 余额不足，图像/音乐/TTS 增强层全部无法验证 |
| 问卷调研 | ⚠️ 未做 | 「问题与用户洞察 25 分」需要证据支撑 |
| Demo 视频 | ⚠️ 未做 | 部署后录屏 |
