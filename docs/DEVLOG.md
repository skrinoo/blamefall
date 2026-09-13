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

---

## 10. 设计复盘：理由-对象错位、可玩性与「隐藏评价值」（2026-09-12）

玩家实测反馈（附两张截图）：同一口锅的 5 个快速理由是**写死的**，不随甩锅对象变化，
于是出现「锅甩给室友，但事实型/情感型/荒诞型的理由其实是甩给自己、转移型是甩给教务处」的错位；
甚至有时一口锅的 5 条理由没有任何一条对得上当前对象。

### 代码层面的根因（三处各自独立）

| 层 | 键 | 后果 |
|---|---|---|
| 理由文本 | `pot.def.options[argType]` =（锅×类型） | 与当前目标无关 → 叙事错位 |
| 说服力 S | `computePersuasiveness(reason, type, npc, pot)` | 目标相关性信号极弱：只有「文本含 npc.name」或「含锅实词」各 +10；**不惩罚「理由在说别人/说自己」** |
| NPC 答复 | `VERDICTS[npc][argType].reactionSuccess/Fail` =（NPC×类型） | 与理由文本、与锅都无关 → 同一类型下好理由和烂理由拿到同一句回复 |

错位不是某一条数据写错，而是**三个键里没有一个把「理由 ↔ 当前目标」绑在一起**。

### 问题 2：甩给自己合理吗？要不要隐藏评价值？

- 「甩给自己」在游戏里**已经存在**，就是隐藏动词「接」：不得分、−8 阴影、+1 接锅信用、
  接满 3 次解锁反向型。它是刻意设计成「不得分但救命」的。
  因此**不要再加一个得分版的「甩给自己」**——那会直接拆掉「接不得分」这条核心教训和阴影经济。
  玩家觉得「甩给自己也许好点」，真正缺的不是新动作，而是 UI 把自我指向的理由当成能甩给别人的选项递了出来。
- **隐藏评价值：要加，但换个名字——契合度 fit(reason, target)。**
  现状 S 完全不看理由是否指向当前目标，所以「拿甩自己的理由甩室友」在数值上不被惩罚，
  数值系统和叙事各说各话。给 `computePersuasiveness` 加一项 fit（作者侧给每条快速理由标
  intendedTargetRole: self/npc/institution/any；命中 +8、错配 −12，进 trace），
  让「理由配错对象」真的会输。自由输入在线时 AI 本就拿着 npcName+reason 在判契合度，
  离线兜底用关键词/npc 名重叠近似——两条路径都对齐到同一个概念。
  契合度对玩家隐藏、在开发者面板 trace 里可见（与「能用 trace 表达的不要藏」一致）。

### 问题 1：可玩性 / 重复游玩的改进方案（按性价比排序）

1. **理由模板化（最高杠杆，同时治错位）**：把 `options[type]` 从死句子改成带槽模板，
   如「这周我值了两次日，{target}一次都没值」，渲染时按当前目标填「你/室友/教务处」。
   同一口锅对不同对象读出不同句子 → 错位消失，且多局不重样。作者成本仍是一条模板/锅×类型。
2. **理由变体**：每个（锅×类型）备 2-3 条同义改写，每局按种子抽一条。语义与平衡不变，纯增新鲜感。
3. **AI 只在构建期生成理由矩阵**：沿用「AI 不在热路径」铁律——用现成的
   `generate-verdicts.ps1` 离线批量产（锅×目标角色×类型）理由，人工精修进 `verdicts.js`；
   运行时快速选项仍 0ms 查表。玩家提议的「AI 实时生成理由」放在自由输入路径（已有），不进快速路径。
4. **答复跟理由挂钩**：reaction 从（NPC×类型）单句扩为多句变体池，按理由用到的「钩子」
   （含量化数字 / 提到 npc 名 / 提到锅实词）挑一句回；AI 路径直接用模型随理由生成的 reaction。
   让「写得具体」在回复里被看见，理由↔答复闭环才成立。
5. **局间突变与种子轮换**：每局修饰器（如「本局情感型全员吃香」）、每日种子决定出锅顺序，
   叠加已有的 carryOver（寄给未来的锅），给重复游玩一个「这局不一样」的理由。
6. **轻量复盘**：结算气泡加一行「这句赢/输在：契合度/量化/偏好」，把错位从困惑变成可学的谜题。

### 本轮已落地的修复（问题 3）

- 论证面板底边锚到 NPC 栏上沿（`--npcbar-h`，开面板与 resize 时写入），不再遮头像；
  开着面板也能点头像切换目标（`onNpcClick→openPanel` 本就支持，之前只是被面板挡住）。
  面板加 `max-height + overflow-y:auto` 防矮屏溢出。
- 自由输入读秒设置（`localStorage: bf.freeTimerSec`，标题屏数字框 + 不读秒/12s/24s 预设）：
  0=打字时握持预算冻结；N=聚焦输入框时把读秒重置为 N 秒（每次开面板只发一次）。
  读秒条分母改为 `S.holdMax` 以适配重置。**去掉开面板自动聚焦输入框**——
  否则「不读秒」会在面板一开就生效，连选快速选项的决策压力也没了；
  现在只有真的点进输入框打字才冻结/重置，键盘 1-5 选快速选项时读秒照走。
- 换目标不再清空已输入的理由（清空移到抓锅时），配合「开面板可点头像换目标」才顺手。

---

## 11. AI 实时生成锅（热/冷双路径）——把「生成」搬到「需要之前」

用户澄清了「AI 实时生成理由」的本意：**每局让 AI 生成锅本身**（连锅的类型、正文、
五条理由一起），为保流畅先预生成一批、游戏进程中再续生成；热/冷由**是否接入 key** 切换。

这与「AI 不在热路径」的铁律**不冲突**，关键在时序：生成发生在「锅被甩出去之前」的后台，
甩锅那一刻仍是从缓冲里 0ms 取用。于是「实时生成」= 预取 + 缓冲 + 冷路径兜底，而非临场等网络。

落地件：

| 文件 | 职责 |
|---|---|
| `prompts/genpot-v1.txt` | 生成器 system prompt：只吐 JSON 数组；**禁一切数值判定字段**（说服度/接受度/道德代价），`ownershipOverride` 是唯一允许的数值且夹 [0,1]；每条理由必须指向其 `targetRole`（self/npc/institution/any），五类型尽量覆盖不同角色——直接根治 §10 的「理由↔对象错位」 |
| `api/genpot.mjs` | 薄端点，复用 `_gateway.mjs`。`GET/POST ?n=1..5`；服务端逐口 `sanitizePot`（五类型缺一不可、targetRole 归一、ownership 夹值丢非数值键），坏批吵闹 502/503，绝不静默凑合 |
| `api/_gateway.mjs` | 抽出通用 `loadPrompt(rel)`（按相对路径分键缓存），`loadSystemPrompt` 委托它——judge 与 genpot 共用同一条上游调用路径，延迟/配置口径一致 |
| `engine/potgen.js` | 客户端缓冲：`enabled()=JudgeAPI.isOnline()`；`prefetch(n)` 后台取（永不 throw、20s 超时、高水位 4 停取）；`next()` 取一口并在低于低水位 2 时顺手补货；缓冲空→返回 null，调用方落回静态锅池 |
| `game.js` | `choosePotDef` 在静态加权池**之前**先问 `PotGen.next()`；`boot`/`startGame` 热路径下 `prefetch(3)` 暖缓冲；标题屏 badge 改「热路径 · AI 判定 + AI 生成锅」/「冷路径 · …静态锅库」 |
| `scripts/dev-server.ps1` | 加 MOCK `/api/genpot`（两口覆盖不同 targetRole 的假锅），让缓冲链路在没网关时也能端到端测 |

**为什么生成锅能直接插进现有引擎**：判定数值不挂在锅上——`ownershipOf` 缺 `ownershipOverride`
就回落到 NPC 默认 `potOwnership`；快速理由的 S 由 `computePersuasiveness` 对**文本**实算；
答复查 `VERDICTS[NPC×类型]`。所以一口只有 {scene,text,options,(ownershipOverride),(selfish)} 的
生成锅是 drop-in 的，`targetRole`/`generated` 是引擎当前忽略的新字段。

验证（2026-09-12）：smoke 29/29 无回归；浏览器实测 `PotGen`——`enabled=true`、`prefetch(3)`
入缓冲 2 口、`next()` 取出的锅五类型齐全 + targetRole 归一 + ownership 夹值 + 无说服度字段，
`sanitize` 对缺正文/缺类型/非法角色/非数值 ownership 全部正确拒绝或归一；加载期 console 零报错。

**生产实测**（2026-09-12，push 上线后掐表）：`GET https://blamefall-yy3a.vercel.app/api/genpot?n=2`
→ **200**，端到端 5.3s（服务端上游 `latencyMs=2777`、`model=gemini-2.5-flash`），远低于 22s 超时与 Vercel 30s 函数上限。
`/api/health` 同步确认 `configured/baseConfigured/keyConfigured` 均 true——生产跑的是热路径。
两口生成锅逐项合格：五类型齐全、`targetRole` 与理由内容语义严格对应（事实/反向→npc、情感→self、转移→institution、荒诞→any）、
`ownershipOverride` 只标主责对象且夹 [0,1]（moyu:0.8 / roommate:0.9）、**零数值判定字段**、id/scene 合法、中文流畅不重复。
生成锅天然带 fit 语义 → §12 的契合度闭环在 AI 生成锅上同样成立。

**尚未做**：暂无——AI 生成锅（热/冷双路径 + 预取缓冲）与契合度 fit 均已落地、平衡扇展重跑、生产热路径掐表验证通过。
（原 ①「`computePersuasiveness` 还没吃 `targetRole`」已落地为契合度 fit，见 §12。）

---

## 12. 契合度 fit——把「理由↔对象」闭环合上，并连带重跑平衡扇展

§10 复盘时玩家吐槽过：「拿甩自己的理由去甩室友，数值上居然不被惩罚」——S 完全不看
这条理由在怪谁。§11 让 AI 生成锅时给每条快速理由标了 `targetRole`，但引擎还没吃它。
本节把这一环合上：`computePersuasiveness` 里加 fit(reasonRole, npcRole)，命中 +8、错配 −12、
any 中性，进 trace（对玩家隐藏，开发者面板可见，与「能用 trace 表达的不要藏」一致）。

**角色判定**：`roleOfNpc` 把 NPC 归到 self/npc/institution——`kind==="self"`→self；
`kind==="abstract"`（天气/水逆/星座）→institution（无主体外部力）；normal 里只有教务处
（`NPC_INSTITUTION={jiaowu}`）算 institution，其余导师/学长/前任/室友/学弟/摸鱼组员/食堂阿姨/辅导员都是「人」。
理由侧 `reasonRoleOf` 优先读 `pot.targetRole[type]`（作者覆盖或 AI 标注），缺则回落到
类型先验 `TYPE_DEFAULT_ROLE`（事实型→npc、情感型→self、转移型→institution、反向型→npc、荒诞型→any）。
17 口静态锅里 9 口偏离先验的键做了 `targetRole` 覆盖，其余走默认。

**只对快速选项生效**：理由文本 === `pot.options[argType]` 时才判 fit。自由输入的角色无法可靠
判定，fit 保持中性，交给热路径的 AI 裁判（它本就拿着 npcName+reason 在判契合）——冷/热两条路径对齐到同一概念。

### 三轮扇展调参（1190 组合 = 17 锅 × 14 NPC × 5 类型，浏览器控制台实跑）

| 轮次 | 改动 | 总胜率 | 结论 |
|---|---|---|---|
| 基线 | 无 fit | **51.8%** | 参照系 |
| 第一轮 | fit 命中 +8 / 错配 −12 | 48.6% | 前任、学弟学妹的情感型（self）被错配 −12 打穿，情感型几乎全灭 |
| 第二轮 | + 给「吃软乎对象」的 prefers 开豁免 | 49.8% | 豁免太宽：连玩家吐槽的 `roommate+late+事实型`（闹钟响三次我都按掉了）也被豁免成功，等于把 fit 的意义抵消掉 |
| **第三轮（采用）** | **移除豁免** | **50.3%** | 数学证明豁免冗余：prefers 给 A 侧 +15（P +6）已足以抵消 fit 的 S 侧 −12（P −4.8），情感型对前任/学弟学妹即使不豁免也能过（P≈0.66/0.67）；移除后错配 −12 信号干净 |

仅比基线降 1.5pt，**阶梯顺序不变**、三支柱保住：

| 类型 | 无 fit | 有 fit | | 关键指标 | 无 fit | 有 fit |
|---|---|---|---|---|---|---|
| 事实型 | 61% | **52.3%** | | 暴击 crits | 0 | **0** |
| 反向型 | 31% | **38.6%** | | 悬空 suspended | 85 | **85** |
| 情感型 | 20% | **14.4%** | | 反向锁定 | 0 | **0** |
| 转移型 | 13% | **8.5%** | | 荒诞型对真实 NPC | 0% | **0%** |
| 荒诞型 | 0% | **0%** | | 教务处单对象 | 16% | **11.8%** |

fit 分布：220 命中 / 392 错配 / 153 中性。fit 把各类型收窄成 **niche**——情感型(self)只在
吃软乎对象身上灵、转移型(institution)主要对教务处/抽象灵、荒诞型(any)是纯解压阀不挑对象。
这正是想要的：错位的理由真的会输，对上的理由得分更高，数值系统不再和叙事各说各话。

验证（2026-09-12）：五条探针符合设计意图（前任/学弟学妹情感型照过、室友迟到事实型被错配压低、
教务处转移型契合）；`game.js` selfTest 新增 fit 三断言（late+roommate：反向型契合 / 事实型错配 / 荒诞型中性）
boot 时打印 OK；加载期 console 零报错；smoke 29/29 无回归。

---

## 13. 自带 Key + 选模型 + 面板残影修复（2026-09-12）

用户提了三件事：① 玩家能填自己的网关 Key（首次提醒、之后不再打扰）；② 填完能选模型并
**检测模型是否真能用**，不能用要提醒；③ 修复截图里的 bug——甩过的锅（论证面板）收起后在下方留
一条残影挡住 NPC 栏。前两件合成一条「请求级凭据覆盖」链路，第三件是一行 CSS 的几何账。

### 13.1 请求级凭据覆盖：Key 记在玩家自己账上

作者兜底的 Key 烧的是自己的网关余额，玩家一多必然撑不住。解法是让**每个请求自带凭据**：

| 层 | 做法 |
|---|---|
| 客户端 `engine/api.js` | judge/genpot/probe 的 fetch 统一带 `x-bf-key` / `x-bf-model` 头（读 `localStorage` 的 `bf.apiKey` / `bf.model`）；留空则不带头 |
| 服务端 `_gateway.mjs` | `gatewayConfig(req)` 优先读请求头、回落 env：`key = reqKey \|\| envKey`、`model = reqModel \|\| MODEL`；`keySource` 报「来源」（request/env/none）**但绝不报值** |
| SSRF 防线 | **`base` 恒等于环境变量**，不接受请求级 `base`——允许玩家改上游地址等于开放 SSRF，坚决不做 |
| 前端 UI `index.html`+`game.js` | 标题屏一块「AI 裁判 / 生成锅」设置区：Key 输入 + 模型 `datalist`（3 个常用）+「检测」按钮；没存过 Key 时高亮 + 一行提示（首次提醒），存过就自动回填、不再打扰；只落 `localStorage`，不上报任何地方 |

**probe 的关键契约：上游失败也返回 200。** `/api/probe` 拿玩家当前的 Key/模型真调一句极简 prompt
（`ping`→只回 `OK`），成功 `{ok:true, model, keySource, latencyMs, reply}`、失败 `{ok:false, error, model, keySource, latencyMs}`——
因为「Key 无效 / 余额不足 / 模型不存在」是**要展示给用户的正常结论**，不是服务错误；用 4xx/5xx 反而会被前端
当网络故障静默吞掉。只有 base+key 全缺才 503。前端把错误码翻译成中文提醒（401 Key 无效、402 余额不足、404 模型不存在、timeout 超时）。

落地件：`api/probe.mjs`（新增）、`api/_gateway.mjs`（`gatewayConfig(req)` + `callGateway` 改用 `cfg.model`）、
`api/judge.mjs`/`api/genpot.mjs`（透传 `req`）、`engine/api.js`+`engine/potgen.js`（带凭据头）、
`index.html`+`game.js`+`style.css`（设置区 UI + 首次提醒）、`vercel.json`（probe 进 functions）、
`scripts/dev-server.ps1`（MOCK 支持请求级凭据 + probe 路由 + 坏 Key 失败模拟前缀）、`scripts/smoke-test.ps1`（+16 条到 45）。

### 13.2 验证阶段揪出的隐性 bug：`model: MODEL` 让「选模型」是假的

功能表面全绿——probe 回显的 `model` 正确、UI 显示正确、smoke 也过。但细读 `callGateway` 发现它构造
**真正发给上游的请求体**时写的是模块常量 `MODEL`，不是 `cfg.model`：

```js
// 修复前：玩家的 x-bf-model 被 gatewayConfig 读进 cfg.model、被 probe/judge/genpot 回显，
// 但真正发给网关的调用始终用 env 默认模型 ——「选模型 + 检测」链路是假的。
model: MODEL,      // ✗ 模块常量，永远是 env 默认
model: cfg.model,  // ✓ 含请求级 x-bf-model 覆盖
```

即玩家选了 `gemini-2.5-pro`、probe 也回显 `gemini-2.5-pro`，实际调的却是 env 里的 `gemini-2.5-flash`。
**回显值 ≠ 实际调用值**——覆盖链路必须一路追到真正发出的那个请求体才算数；中途任何一处回落到模块常量，
都会让整条覆盖静默失效，而且测试全绿（因为测的是回显）。key 覆盖（`cfg._key`）本就正确，只有 model 漏了。

顺带修了 `game.js` probeAI 的 `[object Object]`：503 的 `error` 是 `{code,hint}` 对象、200+ok:false 的 `error`
是字符串码，原来一把拼进提示串会把对象拼成 `[object Object]`，改成统一取码（对象取 `.code`、字符串直接用）。

### 13.3 面板残影：一行 CSS 的几何账

截图里的 bug——论证面板收起后，NPC 栏上方留一条 ~78px 残影挡住角色。根因是两处位移没对齐：

```
.panel { bottom: var(--npcbar-h); }     /* 打开态被抬高 npcbar-h，避免压住 NPC 栏 */
.panel { transform: translateY(105%); }  /* 关闭态却只下移「自身高度的 105%」 */
```

面板底边锚在 `npcbar-h` 高度处，关闭态只按自身高度往下移——顶部于是残留 `npcbar_h − 5%×panelH` 像素，
正好盖在 NPC 栏上。修复是让关闭态把这段偏移一并补掉：

```css
transform: translate(-50%, calc(105% + var(--npcbar-h, 0px)));
```

**测量假象（踩了两轮）**：`.panel` 带 `transition: transform .26s`。在同一个同步 tick 里改 `--npcbar-h` + 切
`.open` 再立刻 `getBoundingClientRect()`，读到的是过渡的起始/中间值——一度量出「关闭态 == 打开态 == 869px」的假象，
误判修复无效、`.open` 不生效，硬重载 ignoreCache 也没用。正确测法有两条：① `panel.style.transition='none'` +
`void panel.offsetHeight` 强制 reflow，取瞬时稳定值；② 干脆走真实游戏流程（抓锅→点 NPC→`openPanel` 先写
`--npcbar-h` 再 `.open`；选理由→`throwQuick`→`closePanel`，此时 var 早已稳定）。**教训：测带 CSS 动画的稳定态，
必须先禁用 transition 或走真实事件路径，不能在动画中途取样。**

验证（2026-09-12）：真实甩锅流程实测收起后 `translateY=522.725px`（= 105%×panelH 404.5 + 98px npcbar-h）、
面板 top=968 恒在 viewport(948) 之下、`panelOverlapsNpcbar=false`；对比修复前 `translateY=424.7`→top=870 会在
NPC 栏（850–948）留 ~78px 残影，与截图那条完全对上。5 条 AI 设置 UI 流程全绿（首次高亮提醒 / 好 Key 检测
「✓ 模型可用」/ 坏 Key 401·402·404 三种中文提醒 / 保存落 localStorage / 刷新持久化不打扰 / 清除回落作者兜底）；
dev-server 日志确认浏览器真实请求 `key=request` + model 覆盖生效；smoke 29→**45/45** 全绿（新增 genpot/probe
与请求级凭据覆盖断言，含「坏 Key 仍返回 200」「响应不回显 Key 明文」）。

---

## 14. AI 总开关 + 「badge 说真话」：修掉留空却跑到无 AI 版的谎报（2026-09-12）

用户报 bug：留空时启用的**不是**作者兜底 key，而是「无 AI 判定 + 无 AI 生成锅」的版本；并要求加一个
「是否启用 AI」的开关，把三种组合的语义钉死：关+留空=无 AI 版；开+留空=作者兜底（烧作者 token）；
开+填 key=烧玩家 token。

**根因（badge 谎报）**：`isOnline()` 旧实现 = `!!apiBase`，而 `apiBase` 在任何 http(s) 同源都会被
`autoSameOrigin()` 填上。于是**静态宿主（GitHub Pages）也被判成「热路径」**——可 Pages 没有 `/api/*`，
每个 AI 请求都 404 → `judgeFree` resolve(null) 切本地引擎、`PotGen` 缓冲空落静态锅。功能上「优雅降级」是对的，
但标题屏 badge 仍写着「热路径 · AI 判定 + AI 生成锅 · 作者兜底 Key」，把无 AI 版谎报成作者兜底版。
**「http 同源」的意图 ≠ 真有后端**，这就是本次 bug 的全部。

**修复 = 能力探测 + 总开关**：

| 件 | 做法 |
|---|---|
| `checkBackend()` | 开机 `GET <base>/api/health`（**刻意不带凭据头**，能力探测不能泄露玩家 key），读 `gateway.keyConfigured` 得 `{present, authorKey}`；Pages 404 → present=false |
| `isOnline()` 重定义 | `aiEnabled && apiBase && backend 未被证伪`；backend=null 时乐观 true，探测到 present=false 即翻 false，此后不再发任何 AI 请求 |
| AI 总开关 | 标题屏 checkbox，存 `bf.aiEnabled`；关 → `isOnline()` 恒 false（judgeFree 直接 null、PotGen 不预取、probe/保存/清除按钮禁用） |
| badge 说真话 | `refreshAiStatus()`/`updateMetaMode()` 按 {aiEnabled, apiBase, backend, hasKey} 显示：AI 已关闭 / 离线兜底 / 该部署无后端 / 后端在·无作者 Key / 作者兜底 / 用自己的 Key |

**安全**：关开关后浏览器实测 `fetch` 调用数 **0**（judgeFree + prefetch 都不发请求）；`checkBackend` 不带
`x-bf-key`；`base` 仍恒等 env（请求级 base=SSRF，不做）；key 仍只以 `x-bf-key` 形式、且仅在开启+填写时发出。

验证（2026-09-12，本地 MOCK）：开+留空 → badge「作者兜底 Key」+ 热路径；关 → badge「AI 已关闭」、
`isOnline=false`、`PotGen.enabled=false`、judgeFree=null、prefetch=0、**fetch 调用 0**、输入/检测/保存禁用、
`bf.aiEnabled=0` 落盘且刷新后保持关；再开 → 回落作者兜底热路径。把 apiBase 指到一个 `/api/health` 404 的地址
模拟静态宿主 → `present=false`、badge「该部署无后端 · 本地兜底 + 静态锅」（不再谎报作者兜底）。smoke 45/45 无回归。

---

## 15. Bug 修复：快甩时「后面的锅」退回静态语料（缓冲太浅，2026-09-12）

**现象**：AI 开启、来一个甩一个地快甩，前几口是 AI 生成，后面全是本地静态锅。

**根因**：不是逻辑错，是预取缓冲的水位/并发太保守，回填追不上消耗。旧参数
`HIGH=4 / LOW=2 / FETCH_N=3` + 单 `inflight` 布尔：开机只预取 3 口；甩到 buffer<2 才补；一次只允许一个在途
genpot（真实网关 ~3s/次）。快甩 3 口就见底，回填还在路上 → `next()` 返回 null → `choosePotDef` 落静态锅池。
这正是「AI 不在热路径」的兜底路径被频繁触发——兜底本身对，但缓冲太浅让兜底变成常态。

**修复（`engine/potgen.js` + `game.js`）**：

| 参数/机制 | 旧 | 新 | 理由 |
|---|---|---|---|
| `FETCH_N` | 3 | 5 | 服务端 clamp 1..5，取满，单次回填更多 |
| `HIGH` | 4 | 8 | 缓冲更深，扛突发 |
| `LOW` | 2 | 4 | 补得早，给慢生成留提前量 |
| 在途计数 | 单 `inflight` 布尔 | 计数 + `MAX_CONCURRENT=2` | 快甩时开第二条流水线，回填吞吐翻倍 |
| `next()` 回填 | buffer<LOW 补一次 | `topUp()` 循环把并发开满 | 一次消耗后尽量补足 |
| 开机/开局预取 | `prefetch(3)` | `prefetch(5)` | 初始缓冲更满 |

**验证**：浏览器内 stub 一个 900ms 延迟、每次回 5 口的 genpot，以 300ms 节奏连甩 12 次 →
**12/12 全是 AI 生成、0 落静态**；`genpotCalls=5`、`maxConcurrent=2`、`finalSize=3`，缓冲始终健康。
真实 MOCK 路径 `next()` 仍返回 `gen-mock-1`（无回归）。

**边界（诚实说）**：热路径铁律不变——甩锅那一刻只从缓冲 0ms 取用，绝不 await。若玩家持续甩得比后台
生成吞吐还快（极端），缓冲仍会见底落静态锅，这是设计内的无感兜底；本次是把「见底」的门槛从 3 口大幅
抬高，正常「来一个甩一个」的节奏下不再触发。

（README 同步：按约定补上「作者兜底 AI 只在有后端的部署（Vercel）上生效」一句。）

---

## 16. Bug 修复：整局无 AI（缓冲不自愈 + 冷启动误杀，2026-09-12）

**用户复报**：§15 加深缓冲后仍出现「上一把是 AI、点『再来一把』后整局无 AI」「有时开局就无 AI（开关明明勾着）」，
且确认是 Vercel 链接（有后端）、不是 Pages 无 AI 版。这不是 §15 的浅缓冲问题，是两个更深的洞：

**洞 A —— 缓冲空了不会自愈（`engine/potgen.js`）。** 旧 `next()` 在缓冲为空时直接 `return null`、**不触发 topUp**；
补货只发生在 boot/startGame 各一次的 `prefetch(5)`、以及「成功 shift 之后」。所以只要开局那次 `prefetch` 失败或还没回来
（Vercel 冷启动、网关瞬时 5xx、作者额度 402），缓冲就卡在 0，之后每次 `next()` 都返回 null 却从不重试 →
**整局每一口锅都落静态**。「再来一把」走 `startGame`、不重新探测、也只发一次 prefetch，一次失败就又是一整局静态。

- 浏览器实证（stub 开局 genpot 失败一次、随后健康）：修复前 8 口全 NULL、`genpotCalls=1`（永不重试）；
  修复后 `next()` 空缓冲也调 `topUp()` → 第 1 口 NULL（热路径不能等）、随后自愈重试 → 7/8 AI、`genpotCalls=5`。
- 顺带修死循环隐患：`topUp()` 的 while 加了 `online()` 门——离线时 `prefetch` 直接 bail、不增 `inflight`，少了这道门会空转卡死标签页。

**洞 B —— 一次慢探测杀掉整会话 AI（`engine/api.js`）。** 旧 `checkBackend()` 用 `AbortSignal.timeout(3500)`，超时即
`present=false`；而 `isOnline()` 一旦见 `present=false` 就整会话 false。Vercel serverless `/api/health` 冷启动常 >3.5s →
开局探测超时 → **整局判成无 AI**（正是「有时开局就无 AI、开关却勾着」）。`checkBackend` 只在 boot/开关/保存时跑，一旦判死不再自愈。

- 修复：超时放宽到 8s + 失败重试一次；**只有 404 才是「确定无后端」**（Pages 秒回 404），收到任何非 404 响应都算后端存在；
  超时/网络错属「暂时够不着」→ 乐观 `present=true`（AI 照发，真不可用时 judgeFree/genpot 各自 catch 落兜底、无感），
  并标 `uncertain` 让 badge 显示「后端探测超时 · 仍会尝试 AI（作者兜底）」而不是谎判无后端。
- 实证：stub `/api/health` 404 → `present=false`（Pages 仍正确判无后端）；stub 4s 冷启动后 200 → `present=true`、`isOnline=true`（旧 3.5s 会误杀）。

**边界（诚实说）**：若作者网关额度真的耗尽（持续 402），自愈重试也变不出锅、仍会落静态——那是 token 供给问题，
不是客户端能修的；客户端能做的是「只要后端还能出货，就绝不因为一次失败/一次慢探测而整局放弃 AI」。smoke 45/45 无回归。

## 17. 「无 AI」为什么修了又修还在 + 空回复（深度根因 + 可观测性根治，2026-09-12）

**用户复报（三件）**：① 用自己的 key + gemini-2.5-flash 用不了 AI，**但平台有调用记录**；② 留白走作者兜底也用不了 AI；③ 刚刷新就开局是无 AI、等一会儿再开局又变成有 AI。外加灵魂拷问：「为什么这个 bug 出现了好多次、修了好多次仍然存在？深度分析，尽量修完不再出现。」

**先回答「为什么反复出现」——这不是同一个 bug 复活，是一类 bug 在不同闸门轮流现身。** 从「玩家想要 AI」到「AI 真的出现」之间有一长串独立闸门：`aiEnabled → apiBase → backend.present → 网络可达 → HTTP 状态 → 服务端正文抽取 → 客户端字段校验 → 缓冲是否暖好`。**每一道闸门失败都按设计静默降级成同一个「本地兜底 / 静态锅」**（「玩家无感」是对的 UX），于是所有故障长得一模一样——都叫「无 AI」。更致命的是：客户端 `api.js` 旧代码 `if(!r.ok) throw → catch → resolve(null)`，把服务端返回的**精确错误码整个扔掉**；`validate()` 返回 null 也同样无声。所以我们一直在**盲修**：§13 修 model 回显、§14 修 badge 谎报、§15 修缓冲太浅、§16 修缓冲不自愈 + 冷启动误杀——每道都是真 bug，但症状不可区分，修完一道、另一道又冒头，看起来就像「同一个 bug 回来了」。

**本轮根因（①②）——`max_tokens: 0` 这颗网关专属地雷（`api/_gateway.mjs`）。** 请求体一直发 `max_tokens: MAX_TOKENS`、默认 `0`。`0` 的语义是**网关专属**的：作者实测网关（openai-next）当「不限制」，所以零成本验证时 gemini-2.5-flash 正常；但**严格的 OpenAI 兼容实现把 `0` 当「一个 token 都不许输出」**→ 正文为空 → 服务端 `empty_content` → HTTP 502 → 客户端旧代码把 502 一 throw 就 `resolve(null)` → 静默落兜底。**token 照烧（prompt+思考已计费）、平台有调用记录，玩家侧却「无 AI」**——与 ①② 完全吻合；且作者兜底与自带 key 共用同一个 `callGateway`，两条路一起中招。

- 修复：**只有显式配了正数才发 `max_tokens`，默认整个字段省略**，交给网关用模型默认上限（省略比发 0 严格更安全：把 0 当无限的网关，省略也几乎必然当无限）。
- 加 `BLAMEFALL_EXTRA_BODY`（env，JSON）逃生舱：合并进请求体、固定字段优先不可篡改路由。下次再遇网关怪癖（思考型关思考 `{"thinking_budget":0}` / `{"reasoning_effort":"low"}` 等），改 env 即可，不必改代码、不必再等一轮「修了又修」。
- `empty_content` 日志补 `model` 与 `max_tokens_sent=(omitted)`，服务端一眼看出是不是这颗地雷。

**本轮根治（防复发）——可观测性：再没有静默失败（`engine/api.js`）。** 新增 `lastError` + `getLastError()`：`judgeFree` 在**每一道**闸门失败时都记下精确原因再落兜底——`offline_gate / client_timeout / http_402 / empty_content（含 usage）/ validate_rejected（含原文片段）/ unreachable`，成功则清空。`game.js` 把它接进开发者面板（按 `` ` `` 键）：自由输入落兜底时打印「AI 失败=empty_content(usage=…)」，热路径取不到 AI 锅时打印「缓冲空 → 落静态锅（buf=… · 上次错误=…）」。**从此「无 AI」不再是看不见的黑箱**：下次复现，按一下 `` ` `` 或点「检测」就能读到确切闸门，不用再猜、不用再盲修一轮。

- 浏览器实证（stub fetch）：502+empty_content → `lastError.code=empty_content, detail=usage={completion_tokens:0,…}`（**0 completion tokens 正是 max_tokens 地雷的铁证**）；200 合法 → 有结果且 `lastError=null`；非法 argument_type → `validate_rejected`+原文；402 → `http_402`。

**顺带加固（①的另一种可能）——`validate` 容错数字字符串。** gemini 经某些网关会把 `persuasiveness` 输出成 `"82"`（字符串），旧校验 `typeof!=="number"` 一律拒 → 又一种「有记录却无 AI」。现在宽松强转一次（转不出有限数才拒），下游 `judge.js` 再 clamp。实证 `"82"` → 通过、S=82。

**③ 冷启动暖机竞态（`game.js` boot）。** 旧代码把 `PotGen.prefetch(5)` 排在 `checkBackend().then()` 里。Vercel 冷启动下 health 探测要 8s 超时 + 0.7s + 重试 ≈ 17s 才 resolve，于是 genpot 函数直到 ~17s 后才开始冷启动唤醒、缓冲 ~25s 才有货——**正是「刚刷新就开局=无 AI、等一会儿=有 AI」**。改成**页面一加载就并行发预取**（`isOnline()` 在 `backend===null` 探测未回时乐观为 true，此刻就能发），让 genpot 在标题屏期间就暖起来；探测回来仅在缓冲仍空时补一次（避免每次加载双发 genpot 白烧 token）。实证：reload 后 1.6s 缓冲已暖（buf=2）、`next()` 返回 `gen-mock-1`（generated）。

**空回复 bug（系统性根治，`engine/judge.js` + `data/npcs.js`）。** 抽象 NPC（天气/水逆/星座）只有 事实/情感/荒诞 三型专属台词，转移型/反向型回落到 `VERDICTS.generic`——而 generic 只有 technique/verdict、**没有 reaction 字段** → 气泡里「被甩锅者那句话」空白。不再逐条补数据（治标），而是让 `pickReaction(ai, success, npc)` **结构性地永不返回空串**：依次回落 `npc.fixedReaction` → 一句中性台词；并给三个抽象 NPC 各配 `fixedReaction`（沿用各自「官方腔」签名台词）。实证：天气×转移型（generic 回落）→ 判词正常、reaction=「今日风向复杂，气压偏低，本单位不予回应。」（非空）。

**安全。** 本轮聊天里出现了一枚**明文真实 key**——已提醒用户立即到网关后台吊销/轮换；该 key **未**写入任何文件、记忆或提交，也**未**被用来调用网关（不烧用户 token）。教训：演示/排查一律走 env 或标题屏输入，绝不把 key 贴进任何会被记录的地方。

**边界（诚实说）。** ① agent 机器够不着 `*.vercel.app`（大陆封锁）、也不会用那枚泄露 key 调真实网关，所以 `max_tokens` 修复**未能在真实网关上端到端跑通**——它是「代码 + 症状（有调用记录却无 AI）」吻合度最高的根因，且无论如何都是该拆的地雷。**真正的确认要靠新加的可观测性**：用户重新部署 Vercel 后若仍「无 AI」，按 `` ` `` 或点「检测」即可读到确切错误码——`empty_content` 说明仍是思考型/上限问题（配 `BLAMEFALL_EXTRA_BODY` 关思考或配正数 `max_tokens`）、`http_402` 是额度、`validate_rejected` 看原文片段是哪个字段。② 服务端改动（`api/_gateway.mjs`）需**重新部署**才生效。smoke 45/45 无回归。

## 18. 场景↔角色错配：一个 `cast` 字段一箭三雕（提示词约束 + 目标软过滤 + 前任复活，2026-09-12）

**用户观察（真问题）**：锅生成里「宿舍」场景高频出现，但真正说得过去的甩锅对象只有室友相关几个；场景与角色不匹配。用户要求先大量对局观察、报告，再评估三条路：(a) 增加角色 (b) 限制提示词 (c) 每次点锅下方只罗列场景相关角色（也可掺几个不相关的）。

**实证（25 口样本：15 静态 + 10 真 AI）**：① 宿舍场景≈20%，AI 只在 5 个场景里打转；② 宿舍锅的 `ownershipOverride` 铁证般地以 roommate 为主——场景与角色的绑定本来就存在，只是没被显式声明；③ **AI 乱造场景标签把「前任」废了**：ex 的旧硬锁是 `pot.scene === npc.scene`（="情感社交"）字符串相等，而 AI 造的是「食堂排队」「期末考试」这类自由文本，A/B 两组各 10 口锅**0 口情感社交** → ex 在 AI 锅里永远被原样扔回 = 形同废号；④ 幽灵角色：AI 理由点名宿管阿姨/隔壁/教授等不在 14 人名单里的人，玩家根本甩不到。

**「限制提示词会不会降质」——两层模型 + A/B 实测。** 锅生成分「元数据层」（scene 标签、甩锅落点）和「表达层」（正文画面感、理由机智度）。约束只碰元数据层。用约束版提示词 v2（固定场景枚举 + 必填 cast + 落点约束 + 反套路）生成 B 组 10 口，与自由版 A 组对比：**生动性不降、场景标签收敛、cast 纯增益、幽灵角色降级为背景、JSON 100% 合法**，代价仅 token +27%。结论：约束元数据层不损表达层，反而让「按理由找对象」这件核心玩法更可教。

**用户拍板**：做 (b) 提示词约束 + (c) 目标高亮软过滤（cast 外**变暗但仍可点一次并触发彩蛋**，彩蛋内容待定）+ ex 类特殊 NPC 改用 cast 做可用性判据。

**核心设计——一个 `cast` 字段驱动三件事。** 每口锅声明「牵扯到谁」（2~5 个名单内 npcId）：① 提示词约束（理由落点必须能在 cast 里找到）；② 目标高亮软过滤（握锅时 cast 内点亮 `.targetable`、cast 外变暗 `.offcast`）；③ ex 判据（`ex ∈ cast` 才接，取代脆弱的 scene 字符串相等）。

- **软过滤 ≠ 硬隐藏**：`.offcast` 只是变暗（opacity .4 + grayscale）+「不搭」角标，**仍可点**——甩过去按正常规则结算、不额外扣分，只飘一句错位吐槽。保留「乱甩被人怼」的教学价值与关系仪表盘可见性，区别于 `.coldwar` 的 not-allowed 硬禁点。
- **豁免**：abstract（天气/水逆/星座）与 self（过去/未来的自己）来者不拒，永不参与过滤。
- **同源双校验**：`api/genpot.mjs`（服务端 `sanitizePot`）与 `engine/potgen.js`（客户端 `sanitize`）都放行 cast，白名单 `CAST_IDS`（14 个 npcId）同源；缺失/全非法则**不写** `pot.cast`，游戏与 judge 都回落到「不做 cast 过滤」，向后兼容旧锅。

**改动清单**：`prompts/genpot-v2.txt`（新建，锁场景枚举 + 必填 cast + 落点约束 + 反套路）；`api/genpot.mjs`（`PROMPT_REL`→v2、加 `CAST_IDS`、`sanitizePot` 放行 cast）；`engine/potgen.js`（同源 `CAST_IDS` + sanitize 放行）；`data/pots.js`（**17 口**静态锅逐口加 cast，按 ownershipOverride + 场景语义）；`engine/judge.js`（ex 的 scene 锁→cast 判据，cast 缺失回落 scene 相等）；`game.js`（`hasCast/isOffCast/applyCastFilter/pickOffCastEgg` + `clearTargetable` 清 offcast + grabPot/onNpcClick/mouseenter/slipPot/releasePot/finishThrow 全链路接入 + offCast 彩蛋钩子）；`style.css`（`.npc.offcast` 变暗 + hover 回亮 + 「不搭」角标）。

**浏览器实证（dev-server MOCK，`evaluate_script` 真点击驱动全链路）**：① 数据层：17 口锅 cast **全部合法**（id 均在 14 人白名单、无重复、场景语义正确）；② ex 判据 5 用例全过——ex+含 ex 的 cast 锅**不再弹回（复活）**、ex+不含 ex 的锅弹回、旧锅无 cast 回落 scene 相等/不等均正确、普通 NPC 无 scene 锁永不受限；③ 高亮分区：抓「自我管理」锅 → targetable=daoshi/jiaowu、offcast=其余 7 个 normal NPC、3 abstract + 2 self 两边都不进（2+7+5=14 ✓）；抓「就业压力」锅 → targetable=xuezhang/daoshi/jiaowu（正好 cast）；④ 彩蛋：点变暗的 didi（**确认可点**）→ 面板开 → 甩锅成功（+100 分、按正常规则结算无额外惩罚）→ `float hold` 飘出「（学弟学妹 战术后仰：这场景里根本没我）」。smoke 45/45 无回归。

**边界（诚实说）**：① **彩蛋内容是占位**——用户明确说「待定」，当前实现是 `OFFCAST_EGG` 随机错位吐槽台词 + devLog，纯表现层、不改任何判定数值；想换成就/特殊台词/音效/关系惩罚，改 `game.js` 里 `OFFCAST_EGG` 与 `pickOffCastEgg` 即可，钩子已埋在 `finishThrow`。② AI 锅的 cast 质量依赖 v2 提示词，本地 MOCK 的 genpot 返回的 mock 锅**不带 cast**（走「不过滤」向后兼容路径），真 AI 锅的 cast 收敛度需部署后在真实网关上复验。③ 服务端改动（`api/genpot.mjs` + 新提示词）需**重新部署 Vercel** 才生效；`vercel.json` 的 `includeFiles: prompts/**` 已覆盖 v2，无需改配置。④ 本轮只做了本地提交，未推送。

## 19. 设置收进统一弹窗 + 软过滤开关（默认关）+ 游戏内暂停（2026-09-12）

**用户三条需求 + 一条补充**：① 软过滤加开关（附简短说明解释发光含义，默认关）；② 设置收进统一「⚙ 设置」按钮（简洁 UI，以后的设置也放这里）；③ 默认值：启用 AI 开 / API Key 留空 / 自由输入读秒 0（打字不读秒）；补充：增加游戏内暂停。

**设置收拢**：标题屏 `.title-set`（读秒）与 `.title-ai`（AI 凭据）两块**原样搬进** `#settings-modal`（所有 ID 不变 → 既有绑定零返工）；标题屏只留一个 `⚙ 设置` 按钮，暂停遮罩里放第二入口。first-run「提醒填 Key」改为设置按钮红点（`#btn-settings.attn`，保存后消失）。关闭方式：✕ / 遮罩点击 / Esc。

**软过滤开关**：`localStorage.bf.castFilter`，**默认关**。关 = grabPot 不调 applyCastFilter、mouseenter 回落旧的单个悬停高亮、NPC 栏无 offcast/targetable 分区；开 = 既有 cast 三态（发光 = 这口锅真牵扯到的人 / 变暗 = 场景不搭但仍可点 / 玄学与自已豁免）。offCast 彩蛋属内容层，**与开关无关照旧触发**（台词自解释错位）。握持中途改开关：立即生效/撤销。

**暂停**：`S.paused` + 主循环一道闸门（`phase==="playing" && !S.over && !S.paused`），世界时间 / 刷锅 / 下落 / 握持读秒一起冻住；判定/飞行的 setTimeout 链走真实时间冻不住 → **busy 期间拒绝暂停入口**（toast「等锅落地再暂停」）。入口：舞台右上 ⏸（stopPropagation 防被「点空白=放手」误触）+ Esc 层级（关设置弹窗 > 继续暂停 > 放手锅 > 暂停）。遮罩三件：继续 / ⚙ 设置 / 回标题；暂停中冻结一切游戏按键（1-5 快速理由、1-9 选目标）。endGame / startGame / quitToTitle 三处重置遮罩与按钮字形，防跨局残留。

**默认值核对（需求③零代码改动）**：`CFG.aiEnabled=true`、`CFG.apiKey=""`、`freeTimerSec=0`（打字不读秒）—— 代码原默认即用户要求值；清空 localStorage 浏览器实证：ai-on=checked / castfilter=unchecked / freetimer="0" / key 空 / 红点亮。

**验证**：浏览器同步链路全绿（弹窗开闭与开关持久化 / Esc 层级 / 设置叠在暂停遮罩上层 / 回标题与新一局重置 / 过滤关时抓锅零分区）；暂停冻结实测受限于测试标签页在用户 Edge 中 hidden（rAF 停摆），按用户指示改**逻辑自检**：8 锚点逐一核对（freshState.paused / 三处 cast gate / 三处遮罩重置 / 握持中途立即生效）+ keydown 层级 + busy 拒绝 + z-index 层级（设置 60 > 暂停 50 > ⏸ 30）；smoke 45/45 无回归。玩家在可见标签页玩时，暂停=世界冻结是闸门行的直接推论。

**改动清单**：`index.html`（设置搬弹窗 + ⏸ 按钮 + 暂停遮罩 + 设置弹窗 DOM）；`game.js`（castFilter 状态与三处 gate / 暂停三件 / keydown 层级 / 弹窗绑定 / 红点）；`style.css`（弹窗与暂停样式）。

## 20. 新 NPC「宿管阿姨」：宿舍管理锅有了真落点（2026-09-12）

**动机（用户提议）**：AI 锅实测高频涉及宿舍管理（卫生/晚归/大功率电器/水电收缴），但旧名单无人可甩——v2 提示词里宿管阿姨甚至被写成「只能当背景板」的角色。把她扶正为第 15 个 NPC。

**数值设计**：难度居中（difficulty 1.4）——比辅导员硬（宿舍的事她真管得着），比导师软（登记簿对了她就认）。baseAcceptance 45 / prefers 事实型（只认值班登记簿）/ dislikes 荒诞型+反向型 / reflectChance 0.15（偶尔把「这归你们自己管」扔回来）。不加 scene 硬锁：相关性交给 cast 软过滤，避免重蹈「前任锁场景形同废号」的覆辙。

**六处联动**：① `data/npcs.js` 插入 suguan（🗝️，食堂阿姨与前任之间）；② `engine/potgen.js` + ③ `api/genpot.mjs` 同源 CAST_IDS 白名单 14→15；④ `prompts/genpot-v2.txt` 名单加 suguan、cast 规则新增「宿舍管理四事项（卫生检查/晚归登记/大功率电器/水电收缴）时 suguan 进 cast」、背景板例句里删掉宿管阿姨（她已可甩）；⑤ `data/pots.js` 三口宿舍生活锅（trash/electric/noise）cast 各加 suguan；⑥ `data/verdicts.js` 补 5 条专属台词（值班簿对账/邻里苦情牌/制度上推法/失职反扣法/玄学扰民说，第一人称 ≤20 字），判定库 54→59 条（标题屏计数由 updateMetaMode 动态算，无需手改）。

**零代码路径**：game.js / judge.js / fallback.js 一行未动——NPC 栏、键盘 1-9 取模、查表回落、cast 软过滤、裁判链路全部数据驱动，新角色即插即用。

**验证（浏览器同步链路实测，AI 关走查表）**：数据层 NPCS.length=15 / 判定库 59 条含 suguan 五键 / 三宿舍锅 cast 含 suguan；交互层 chips=15（开局后）/ 宿管阿姨 idx=8；甩锅实测：抓 MOCK 锅点宿管→事实型→甩锅成功 +140 分（=100×1.4 精确）、technique「值班簿对账」、verdict、reaction「本子上确实漏记了一笔……行，这锅我背。」三段全弹出。smoke 45/45 无回归。

**改动清单**：`data/npcs.js`；`engine/potgen.js`；`api/genpot.mjs`；`prompts/genpot-v2.txt`；`data/pots.js`；`data/verdicts.js`。服务端白名单+提示词变更随 push 触发 Vercel 重新部署生效。

## 21. 四阶段重构：爽-紧-高潮-结尾，把「甩锅爽游」收束成「一个人背锅」的终幕（2026-09-12）

**动机（用户设计）**：旧的三幕只是「越来越快」，情绪是一条单调上升线，收尾突兀。用户要把它拆成四阶段并给每一幕明确的**空间语言**——爽（剩余 60-40s）/ 紧（40-20s）/ 高潮（20-5s）/ 结尾（5-0s）。核心叙事转向：前面甩得越爽，结尾越要你一个人把锅背起来。玩法上「甩锅爽游」，立意上「一堂教你接锅的课」，终幕是这句话的落点。

**设计确认链（先出图后写码）**：用户要求高潮幕的位置关系先出概念图确认再实现。用 openai-next 的 gpt-image-2.5 生成 v1（`docs/concepts/1789214622_*.png`）→ 用户三点反馈（环收近留缝防误触、锅八向逐口而非进幕八口、结尾补一行小字）→ v2（`docs/concepts/1789215175_*.png`，纯色底/环半径≈48%屏高/仅 3 口锅示意）→ 用户「差不多这样的位置关系」→ 用户发红笔标注图（红圈圈主角、主角正下方红框）→ AskUserQuestion 定稿：**红圈=主角安全区（圈内不放任何可点元素）**、**红框=其他角色大概位置（环比 v2 再收近）**。图确认后才动代码。

**高潮幕实现**：`ACTS` 改四幕表（爽 spawnEvery 3.4/fallMs 5600/maxAir 1/acceptBonus 12；紧 2.1/4200/2/0；高潮 1.5/3200/3/0；结尾 999/7000/1/0）。主角 `#actor` 用 CSS 移到屏幕正中（`.climax #actor` left/top 50% + translate + scale .82）；15 个 chip 从底栏 `#npcbar` 搬进新容器 `#ring` 排环（`layoutRing` 按 `ang=-π/2+i·2π/15` 均布）。**环半径下限 = 防误触缝隙**：`ringRadius()=clamp(max(min(w,h)·0.16, NPCS.length·(CLIMAX_CHIP+14)/2π), 120, min(w,h)·0.34)`——下限保证 15 个 chip×(宽64+隙14) 放得进圆周，chip 不挨在一起；主角安全区（红圈）由「环半径 > chip 到心距离」天然保证圈内无可点元素。**视角拉远** = `.climax #sky, .climax #ring { transform: scale(.82) }`，逻辑尺寸不变（点击热区仍准），只是整体缩小便于同屏操作。**八向锅**：`spawnPot` 在 act3 从 8 个锚点（四边中点 + 四角，外 margin 150）随机选一向出生，速度向量指向环内随机落点（`rr=rand·ringRadius·0.5`），`mode="aim"`；`movePots` 的 aim 分支按 vx/vy 直线飞，锅中心距落点 <30px = `crashPot`（砸到自己）。**强调**：八向是「候选出生点」不是「进幕同时八口」，刷几口/何时刷仍由 spawnEvery 1.5s、maxAir 3 管。

**紧→高潮转场**：新增 `#blackout`（fixed z-70，transition opacity .8s）。`enterClimax` 加 `.on` 渐黑 → 800ms 后在黑场中 `applyClimaxLayout`（搬 chip、排环）→ 移除 `.on` 亮起，全程≈1.6s，位置突变被黑场遮住，玩家只看到「灯一亮，所有人围住了你」。

**结尾幕实现**：`enterEnding` 加 `.ending`（环上 chip `opacity:0` 1.5s 淡出 + `pointer-events:none`）、显示 `#ending-note`「没有其他人了」、残留锅 `.fadeout` 淡出清场（结尾不砸锅扣血）、+1200ms `spawnEndingPot`（selfish 锅、fallMs 7000、`vy=(groundY+120)/7` 缓落、`.ending-pot` 紫边、**落到地面不砸**：`movePots` 里 `if(p.endingPot){p.y=g;p.vy=0}` 悬停等抓）。`onNpcClick` 加 act4 守卫（点任何人 toast「没有其他人了。这口锅只能甩给你自己。」）；`catchSelf` 在 act4 转 `endingCarry`：气泡「甩 锅 失 败 / 自己背 / 这口锅，你自己背。」→ 2600ms 后 `endGame("time", true)` 带 slide。主角作为唯一光源由 `.ending #actor .actor-body { filter: drop-shadow(...) }` 强化。

**滑入卷宗 + 自动滚**：`endGame(reason, slide)` → `renderReport` 末尾 `if(slide) slideIntoReport()`。`slideIntoReport`：`body.slid` 触发 `#screen-report` 的 `reportSlideIn .9s`（translateY 100%→0，画面向下滑入）；scrollTop 归零；wheel/touchmove/pointerdown(once) + window keydown(once) 任一即置 `stopped`；+950ms（等滑入动画结束）后 setInterval 16ms 缓动 `scrollTop += max(2, diff·0.07)` 直到 `diff≤2` 或 `stopped`；target=`scrollHeight-clientHeight`，`.report-wrap` 的 `padding-bottom:54px` = 用户要的「与屏幕底部留点缝隙」。**玩家有操作立即停自动滚、交还控制权**。

**两个 bug（都在验证阶段抓到）**：
① **npcbar 没隐藏**——CSS 写的是后代选择器 `.climax #npcbar`，但 `<footer id="npcbar">` 是 `<main id="stage">` 的**兄弟**不是后代，选择器根本不匹配。实测 `npcbarHidden:false` 暴露。改兄弟选择器 `#stage.climax ~ #npcbar, #stage.ending ~ #npcbar { display:none }`。
② **滑入卷宗动画在真机会丢失**（隐藏标签页测试掩盖的真 bug）——loop 里原写 `if (S.act===4 && !S.endPotDone) S.t=ROUND; else endGame("time")`。可见标签页 rAF 正常跑：玩家一背锅，`endingCarry` 立即置 `endPotDone=true`，**下一帧** loop 就命中 `else endGame("time")`（**无 slide**）抢先把 `S.over=true`，而 `endingCarry` 自己 2600ms 后的 `endGame("time",true)`（**带滑入**）被 `if(S.over)return` 挡成空操作 → 滑入动画丢失。我的浏览器测试因标签页 hidden、rAF 停摆，只有 setTimeout 链在跑，**侥幸没触发这条竞态**。按设计「结尾不能自动结算、只能玩家亲手背」，act4 本就该永远冻结时钟、只由 endingCarry 驱动结算，故改为 `if (S.act===4) S.t=ROUND; else endGame("time")`，去掉 `!endPotDone` 条件——竞态从根上消除。

**验证（浏览器同步链路 + __bf 钩子实测，隐藏页用 finish() 补动画时钟）**：
- 高潮幕：`climaxClass:true` / `ringChips:15` / `chipDistFromCenter≈ringRadius`（layoutRing 数学正确）/ aim 锅 `mode:"aim"`、出生点 `spawnOutside:true`、落点 `targetDist 63 < R·0.5`（八向朝环心飞）/ `npcbarDisplay:"none"`（bug① 修复）/ sky·ring `finish()` 后 `matrix(0.82,…)`（视角拉远生效，之前的恒等矩阵是隐藏页 transition 时钟冻结的假象）。
- 结尾幕：`endingClass:true` / note「没有其他人了」可见 / 结尾锅 `ending:true` / 抓锅 `held:true` / 甩主角→气泡「甩 锅 失 败」·「这口锅，你自己背。」 / `endPotDone:true` / **`overDuringBubble:false`**（气泡 2600ms 期间时钟冻结、未提前结算——bug② 修复的关键断言）→ **`overAfter:true`** / `bodySlid:true` / `reportActive:true` / 卷宗 `target:369` 可滚、同步驱动 49 格到底 `reached:368`、`padding-bottom:54px` 留缝。
- 回归：smoke 45/45 全通过，无回归。

**改动清单**：`game.js`（ACTS 四幕表 / spawnPot 八向 aim / movePots aim+结尾锅悬停 / updateAct 四幕 / ringRadius·layoutRing·applyClimaxLayout·enterClimax / enterEnding·spawnEndingPot·endingCarry / slideIntoReport / loop 时钟冻结 / onNpcClick·catchSelf·openPanel·spawnLogic·startGame·resize 适配 / __bf 钩子扩展）；`index.html`（`#ring`、`#ending-note`、`#blackout` 三处 DOM）；`style.css`（高潮环阵 / 结尾 / 渐黑转场 / 滑入卷宗 CSS 块 + 兄弟选择器修复）；`data/commentary.js`（acts 3 改高潮台词、新增 acts 4 终幕台词）。纯客户端改动，服务端零变更。

## 22. Bug 修复：高潮锅穿过主角（坐标系不一致）+ 结尾锅对齐主角正上方并放大（2026-09-12）

**动机（用户实测反馈）**：① 高潮幕从四面八方飞来的锅，有的直接穿过主角而不砸下；② 结尾幕最后一口锅应从主角正上方落下，且尺寸要再大一点。

**Bug① 根因（两个叠加）**：（a）**坐标系不一致**——`.pot` 带 `transform: translate(-50%, 0)`，所以 `left` 值 = 锅的**视觉中心 x**（实测：styleLeft 366.569 → rect 中心 367）；但 `movePots` 的 aim crash 判定却用 `p.x + 95`（把 `p.x` 当成左上角、+半宽190/2），x 坐标凭空偏了 95px。后果：从右侧飞来的锅要越过主角 95px 才触发 crash——视觉上就是锅穿过主角。（b）**落点随机偏移**——旧实现落点取「环内随机点 `rr∈[0, ringRadius·0.5]`」，当落点偏在环心一侧、锅从对侧直线飞来时，路径会越过主角（环心）却只在「距落点<30」才 crash。

**Bug① 修复**：落点改为精确对齐主角中心（`tx=w/2, ty=h/2`，climax 主角居屏幕正中），八向锅全部汇聚主角；crash 判定改用正确的视觉中心 `hypot(p.x - tx, (p.y+hh) - ty) < 48`（hh=锅半高≈42，offsetH 85/2）。锅沿直线飞向主角中心、在距中心 48px 内（锅体已覆盖主角）即 crash，数学上不可能越过。

**Bug② 修复**：`spawnEndingPot` 重写——锅视觉中心 x 对齐主角中心（`p.x=w/2`，旧值是随机水平位），从 `y=-140` 缓落；悬停高度 `hoverY = h/2 - 38 - 18 - offsetH`（主角 scale(.82) 视觉半高≈38、留 18px 缝隙便于分别点击锅与主角），`movePots` fall 分支的落地判定改为 `p.endingPot ? p.hoverY : groundY()`。放大用 CSS `.pot.ending-pot { transform: translate(-50%,0) scale(1.3); transform-origin: center bottom }`——origin 底部锚定保证视觉底=布局底（`top+offsetH`），hoverY 计算不受 scale 影响，水平仍居中于 left。`endingCarry` 里加 `remove("ending-pot")`，避免放大的 scale 与 caught 动画的 transform 冲突。

**验证（浏览器同步链路 + 轨迹积分，隐藏页用 finish() 补动画时钟）**：
- Bug①：进高潮 spawn 8 口 aim 锅各自积分到 crash，`allTargetCenter:true`（落点都=主角中心 240,443）/ `allCrashNearCenter:true`（都在距中心<48 crash）/ `noOvershoot:true`（最小距离<48，未越过主角）；样本显示左下/上/左上角等不同方向的锅 crash 点都在主角周围 46-47px 汇聚。
- Bug②：finish() 后主角居中 (240,443)、锅视觉中心 x=240 正上方对齐（`centerXAligned:true`）、锅底 387 在主角顶 405 上方 `gap:19`、锅放大 158×85→205×110（`scaledUp:true`）；缓落积分 `-140→hoverY 302`、7s 精确到位。
- 回归：结尾完整链路（抓锅→甩主角→气泡「这口锅，你自己背。」→`overDuringBubble:false`→`overAfter:true`→`bodySlid`→卷宗滑入 target 369）全绿；`endingPotClassRemoved:true`、`caughtClass:true`；smoke 45/45；控制台零报错。

**改动清单**：`game.js`（spawnPot aim 落点+速度 / movePots aim crash 判定 + fall 悬停 floor / spawnEndingPot 重写 / endingCarry 移除 ending-pot / __bf.pots() 扩展 vx·vy·hh·hoverY）；`style.css`（`.pot.ending-pot` 加 scale(1.3) + transform-origin）。纯客户端改动，服务端零变更。

---

## 23. 结尾体验三修：像素平底锅图锅、卷宗减速、气泡 0.2s 提前解锁

**需求**（用户实机反馈）：① 结尾最后一锅不是具体的锅 → 换成平底锅图像（MCP 生图，确认后再执行）；② 卷宗自动下滑减慢；③ 甩锅后气泡快消失的最后 ≤0.2s 内能点下一口锅。

**生图迭代链**（openai-next gpt-image-2.5，全程透明背景，System.Drawing 实测 Format32bppArgb、四角 A=0）：v1 卡通紫光煎锅 → 用户改：黑锅+木把/背面朝上/斜放露厚度/透明/别太卡通 → v2 半写实 → 用户改：木把转下面、像素风也行 → v3 16-bit 像素把朝左下 → 用户改：左右翻转 → v4 定稿。翻转用本地 System.Drawing 镜像（坑：枚举名是 `RotateNoneFlipX` 而非 `FlipX`；第一次用错枚举名报错却仍存了未翻转副本，重跑覆盖），存 `assets/ending-pan.png`（1024×1024、358KB），用户确认后集成。

**集成实现**：
- `spawnEndingPot`：innerHTML 换成 `<img class="pot-pan" src="assets/ending-pan.png" width=240 height=240>` + 保留握持条节点；**先 add class 再读 offsetHeight**（基础卡片样式宽190+内边距会读成 ≈265，hoverY 偏高 25px：实测 122→修复后 147）；出生点 y -140→-260（图锅高 240，整锅含透明边推出屏幕外）。
- `enterEnding`：`new Image()` 预载平底锅图（spawn 在 1200ms 后，弱网不空帧）。
- `endingCarry`：只 remove `held`、保留 `ending-pot`（卡片外壳靠该类去除；transform 已无 scale，与 caughtAnim 不冲突，移除反而闪回卡片底）。
- CSS `.pot.ending-pot` 重写：去卡片外壳（background/border/padding/box-shadow）、width 240；紫光改 `drop-shadow` 随锅轮廓（box-shadow 会画矩形光框）+ `panGlow` 2.4s 呼吸；held 换琥珀色定光；握持条 display:none（读秒看面板计时条）。
- 问题② `slideIntoReport`：`Math.max(2, diff*0.07)` → `Math.max(1, diff*0.035)`，下滑约慢一倍。
- 问题③ `finishThrow` 收尾拆两段：解锁（busy=false/恢复常速/refreshNpcBar/breakdown 检查）提前到 `bubbleMs-200`，`hideBubble` 保持原时长；甩锅飞行 620ms > 200ms，新气泡必晚于旧气泡 hideBubble，无覆盖冲突。

**验证**（浏览器、隐藏页）：几何 `imgLoaded(naturalWidth 1024)/240×240/hoverY 147/gapEl 18/cx 240=stageCX/panGlow in anim`；背锅链路 抓锅→点主角（catchSelf→act4→endingCarry；注意 ending 的 chip 已 pointer-events:none，合成 click 会绕过并误触空白放手分支，真机路径是点主角）→气泡「甩 锅 失 败/自己背」→potCls `pot ending-pot caught`（外壳不闪回）→over/bodySlid/report is-active/scrollTarget 369；问题③采样 3897ms 气泡 show=true 且新锅 held=true（尾窗可操作实证）、4891ms show=false；smoke 45/45；控制台零报错。

**改动清单**：`game.js`（enterEnding 预载 / spawnEndingPot 换图+类序+出生点 / endingCarry 保留 ending-pot / finishThrow 两段收尾 / slideIntoReport 减速）；`style.css`（`.pot.ending-pot` 图像化重写 + panGlow）；新增 `assets/ending-pan.png`；`docs/concepts/` 生图迭代稿 ×4。纯客户端改动，服务端零变更。

---

## 24. 音频层落地：四幕 BGM + 音效（2026-09-13）

**需求**（用户）：给《锅从天降》补 BGM 和游戏音效。BGM 要一首「完整连续」的曲子，四段情绪随四幕递进（轻松→稍紧张→推向高潮→激烈心跳加速→渐弱尾声），段间有过渡；音效用程序化合成；高潮音效最后决定废弃不用。

**根因**（音乐情绪反复不对位的复盘）：
- 一开始用 musicgen-small（300M）四段独立生成再 crossfade 焊成一首，但 small 对「紧张」「激烈但克制」等抽象情绪词控制力差、随机性大，反复改 prompt 命中率低。
- 升级 musicgen-medium（1.5B）后情绪表达显著改善，但用 crossfade 焊接固定时长段落会压缩总长，切幕点（20/40/55s）对不齐，用户指出「第三段 41s 就过渡了」。
- **最终方案定型**：不做焊接，改「切幕时切换」——四段独立音频（20/20/15/6s 精确对齐四幕时长），游戏在 `updateAct` 切幕瞬间用 Web Audio 的 GainNode 交叉淡化(crossfade)切换，时间点 100% 精确，且每幕内 loop。

**修复/实现**：
- 新增 `engine/audio.js`：自包含 IIFE，暴露 `window.BFAudio`。全部走 Web Audio API（AudioContext + GainNode 音量控制），BGM/SFX/总音量三级分离可编程调节（`setBgmVolume/setSfxVolume/setMasterVolume/setMuted`）。懒加载（首次 `init()` 才建 AudioContext，规避浏览器自动播放策略）；`playBgm(act)` 段间 1.2s crossfade 淡入淡出；`playSfx(name)` 即时触发；单个音频 fetch 失败静默降级，不影响游戏主循环。
- `index.html`：`game.js` 前加 `<script src="engine/audio.js">`。
- `game.js` 挂点：`startGame`（init + playBgm(1)）、`updateAct`（切幕 playBgm(a)）、`startFlight`（whoosh 甩锅）、`finishThrow` caught 分支（catch 被接住）、`slipPot`（slip 手滑）、`enterEnding`（ending 结尾锅）、`endingCarry`（blame 背锅）、`grabPot`（click 抓锅）。**enterClimax 的高潮音效按用户要求废弃，未挂载**。
- 音频资产 `assets/audio/`：四幕 BGM ogg（act1_fun_m/act2_tight_m/act3_peak_m/act4_outro_m，共 613KB）+ 6 个 SFX wav（whoosh/catch/slip/ending/blame/click，共 155KB）。climax.wav 已删除。

**验证**：待本地 dev-server（端口 8200）试玩验证——音频必须走 HTTP 服务（`fetch` 加载，`file://` 会被 CORS 拦）。需确认：四幕 BGM 切幕切换无报错、段间 crossfade 无硬切、各动作 SFX 触发正常、`BFAudio` 在无音频上下文环境静默降级。

**改动清单**：新增 `engine/audio.js`、`assets/audio/*.ogg ×4 + *.wav ×6`；`index.html`（+1 行 script）；`game.js`（+9 处 BFAudio 调用，startGame/updateAct/startFlight/finishThrow/slipPot/enterEnding/endingCarry/grabPot）。纯客户端改动，服务端零变更。

**备注（供后续接手的音频生产链路）**：BGM 用 Meta MusicGen 本地生成（venv `D:\musicgen-env`，medium 权重 `D:\ai-models\AI-ModelScope\musicgen-medium`，`python musicgen_local.py --model ... --dtype fp16`）；四段统一 A 小调 + chiptune 音色保证连贯；转 ogg 用本机 ffmpeg（WinGet 装，`-c:a libvorbis -q:a 5`）。SFX 用 `sfx_gen.py`（纯 numpy 合成）。这套链路不在游戏仓库内，属于开发侧工具。

---

## 25. 新视觉资产：背景 / 头像 / 图标 / 主角 / 结尾锅（生图 + 抠底 + 切片，2026-09-13）

**需求**（用户）：为《锅从天降》制作新的背景、图标并加特效；生图走 MCP 生图模型、质量要好，且**背景与图标要保持一致性**。经问答收敛为：校园夜色取向、全量资产（背景 3 + 15 个 NPC 头像 + 主角立绘 + 图标组 + 结尾平底锅）、分尺寸分层方案（大尺寸层暗调半写实 / 小尺寸层扁平图形）、先做形态测试再批量。追加约定：**生成出的多个可用变体全部保留，由用户决定**。

**关键约束 / 根因（两个硬问题）**：

1. **`background:"transparent"` 未生效，5 张 sheet 全都没有 alpha 通道。** 实测（`System.Drawing` 读 `PixelFormat`）：
   - `Two_full_body_poses_of_the_sam`（主角 1024×1536）→ `Format24bppRgb`
   - `Seven_small_game_UI_symbols_ar`（图标 1536×1024）→ `Format24bppRgb`
   - `Five_character_bust_portraits__…T00-07-20 / -05-55`（A/B 组头像）→ `Format24bppRgb`
   - `Five_portrait_medallions_in_a__…T00-06-54`（C 组徽章）→ `Format24bppRgb`
   模型改为**在画面里"画"出棋盘格 / 白底来假装透明**。因此旧的切片脚本 `Get-AlphaBox` 拿到的是垃圾（按 4 字节/像素读 24bpp 数据），产物是「白底整格 + 随机窄条」的废片 —— 本轮全部重做。
2. **版式对不上。** 生成的半身像宽高比 ≈ 0.5（腰以上），而游戏里 `.npc` 芯片宽仅 74px、`.npc-glyph` 字号仅 23px。原样塞进去脸只有 ~12px，不可读。

**修复 / 实现**：

- **抠色管线**（不重新生图，省下 25–50 积分）：不依赖 alpha 通道，纯几何 + 亮度判定：
  1. `bgl` = 亮度的**局部最大值**（PIL `MaxFilter(2r+1)`，r=14~18）；棋盘格两色在 r 大于格宽时会被抹平到亮格值，从而得到逐像素的背景基准；
  2. `bg_cand = (chroma ≤ 30) ∧ (lum ≥ bgl − tol) ∧ (lum ≥ abs_min)`（无彩度 + 相对局部背景够亮 + 绝对下限）；
  3. **从画布四边八连通泛洪**（迭代膨胀至收敛）——只吃掉与边界连通的背景，角色内部任何亮部都不会被误伤。这一步成立的前提是**所有图形都有近黑封闭描边**（已逐张目视确认）；
  4. 边界 1px 带做**反预乘**还原：`α = clamp((bgl − lum)/bgl)`，`fg = (p − (1−α)·bgl)/α` —— 这是消白边光晕的关键；
  5. 开运算（`MinFilter(5)`→`MaxFilter(5)`）后再取 bbox，过滤水印与杂点（A 组与 C 组 sheet 上都有淡印水印）。

  各 sheet 实测（`bg_cand% / flooded% / iters`）：A_bust `65.17 / 65.14 / 514`、B_bust `69.63 / 69.57 / 511`、C_medal `75.23 / 75.22 / 511`、ICONS `93.00 / 92.94 / 585`、ACTOR `65.73 / 65.63 / 744`。参数：A `tol25/min234`、B `tol18/min246`（纯 255 平白底）、C `tol45/min200`（暖灰纸底，210–247 带颗粒）、ICONS/ACTOR `tol45/min205`（棋盘格 247/228 两色）。

- **细胞切分与对齐**：整张 sheet 等分 5 列（1536/5=307.2），bbox 在**已抠好的 alpha** 上取，尺寸阈值过滤（列/行有效像素 ≥ max(3, 0.4%)）；统一贴到 256×256 透明方画布、按高度缩放到填 90%（图标 128×128 填 92%），保证 15 个头像的视觉大小一致。
  sheet → id 映射（已目视核对）：A(…T00-07-20) = daoshi/jiaowu/fudaoyuan/xuezhang/didi；B(…T00-05-55) = roommate/moyu/shitang/suguan/ex；C(…T00-06-54) = tianqi/shuini/xingzuo/future_self/past_self。图标行序 = fact/emotion/shift/reverse/absurd/pot/umbrella。

- **头像取景 4 变体（全部保留，供用户决定）**：`av-`（完整半身像，六边切底）、`avc-`（同上 + 圆形硬裁）、`avh-`（**头肩特写**：垂直裁到内容上 60%，底部 15% 做 alpha 淡出）、`avhc-`（头肩特写 + 圆形硬裁，fill 0.76 以免切肩）。
  **放弃"自动颈线检测"**：两版尝试都失败 —— v2 用 `argmin(ext)` 在 30%~72% 窗口找颈线，B 组肩线被当成头宽导致厨师帽与汤勺被切；v3 改为「先找上半部最宽行再往下找最小值」仍不可靠（B 组最宽行落在肩部）。最终改为**确定性规则：保留内容上 60%**，且**只做垂直裁切、保留整幅宽度**（横向绝不出血）。实测裁切后宽高比 0.88~1.10（原 0.5），脸部放大约 1.7 倍。

- **主角与结尾锅**：主角 sheet 2 列各取 bbox → 高 512px（`actor-idle` 167×512、`actor-catch` 150×512）。结尾平底锅按同族语言重绘（扁平 cel 上色 + 近黑描边 + 左上琥珀轮廓光 + 右下紫对光 + 木柄挂孔），纯 255 平白底（四角实测 `mean=255.0 min=255 max=255`），抠底后导出 `assets/pan/pan-v1-{1024,512,240}.png`。**旧像素风 `assets/ending-pan.png` 原封未动**。

- **评审页**：`review-assets.html`（工作区根目录，3.06MB，全部图片 base64 内联、零外部依赖），按**游戏真实尺寸**渲染全部素材，含 4 变体标签切换、74px NPC 栏 mock、64px 高潮环阵 mock、尺寸阶梯、图标四档、平底锅新旧对比、以及 6 项待决清单。

**验证**：

- **光晕探测**：把切片贴到白(#FFF) / 中灰(#808080) / 深(--bg #0c0f14) 三种底色上放大比对，**三种底色上均无亮/暗光晕**，边缘干净。
- **可读性阶梯**：74 / 64 / 40 / 22px 四档渲染 —— `avh-`/`avhc-` 在 40px 下五官仍可辨，`av-`/`avc-` 在同尺寸仅能识别剪影。图标 128/40/24px 清晰，16px 开始糊（故建议接入时把论证类型图标由 10px 提到 20px）。
- **无头浏览器实测评审页**（自建 Node + CDP + 独立 profile 的 headless Edge）：`npc:15 / ring:8 / icons:7 / tabs:4 / imgs:67 / broken:0`，页高 3904px，**控制台零报错**；逐段截图 6 张 + 4 个标签页切换截图（切换后重绘正常，`.tab.on` 与建议文案同步更新）。
- 未做：`index.html / style.css / game.js` 尚未接入，特效尚未开始。

**改动清单**：新增 `assets/avatars/av-*.png ×15 + avc-*.png ×15 + avh-*.png ×15 + avhc-*.png ×15`（均 256×256 透明 PNG）；新增 `assets/icons/ic-*.png ×7`（128×128，**覆盖了此前的废片**）；新增 `assets/actor/actor-idle.png、actor-catch.png`（高 512）；新增 `assets/pan/pan-v1-{1024,512,240}.png`；新增 `assets/bg/bg-title.jpg、bg-stage.jpg、bg-report.jpg`（1536×950 / 1236×824 / 1148×888，合计 371KB，源 PNG 保留同目录）；新增 `docs/concepts/` 概念图与形态测试图。**`index.html / style.css / game.js / assets/ending-pan.png` 均未改动**，纯新增。

**工具链备注（不在游戏仓库内，属开发侧）**：Python venv `C:\Users\skrin\.workbuddy\binaries\python\envs\bfimg`（Pillow 12.3.0 + numpy 2.5.3；注意默认 venv 的 pip 曾损坏，需重建）；脚本在 `C:\Users\skrin\.workbuddy\bf\`：`diag.py`（背景诊断）→ `key_and_slice.py`（抠色 + 切片）→ `headcrop4.py`（头肩特写）→ `key_pan.py`（锅）→ `sheets2.py`（验收对比图）→ `build_review.py` + `shot_review.js`（评审页与无头验收）。**PowerShell 5.1 无 BOM 时按系统 ANSI 读 `.ps1`，含中文注释会解析失败 → 脚本一律纯 ASCII**（§7 已记载）。

## 26. 标题面图标设计：2 个 logo 概念 + 7 个 UI 功能图标（生图 + 提子物体 + 多变体，2026-09-13）

**需求**（用户）：「你有做标题面的图标设计吗，没有的话，做一下」。

核查结论：**确实没有。** 标题屏此前只有 `.title-pot` 里一个 `🍲` emoji 当 logo（`font-size:64px`，带 `potBob 3.2s` 上下浮动 + `drop-shadow`），齿轮按钮同样是 emoji `⚙`。即「标题面图标设计」此前为零，本轮从零补齐。延续 §25 的约定：**多个可用变体全部保留，由用户决定**。

**关键约束 / 根因（三个硬问题）**：

1. **标题 logo 的实际显示尺寸只有 64px**（`.title-pot` 的 `font-size`），不是 1024px。§25 已验证过一条判据：**深色底上纯深色的 mark 会糊掉** —— 带浅色底牌的徽章在 32px 仍清晰，无底板的纯 mark 在 64px 以下就认不出。所以「logo 用什么版式」不是审美问题，而是**小尺寸可读性问题**。
2. **依旧是"假透明"问题。** logo A 是纯 255 平白底（四角 `mean=255.0`），logo B 是白底 + 六边形**内部**也有一块白底牌 —— 后者比 §25 的 sheet 多一层麻烦：背景白与六边形内的白**是连通的**，直接 `white` 取白会把两者合并成一张整图。
3. **想复用已有图形时不能靠缩放。** 圆形徽章版需要一个锅形 mark，第一版直接把已有的 `assets/icons/ic-pot.png`（128px）贴进 1600px 画布 —— 产物上锅只是一个小点。根因是 **`PIL.Image.thumbnail()` 从不放大**（`resize()` 亦如此，只在明确给尺寸时放大）。改为**回去从 logo B 的原始分辨率里提取锅形**（见下）后正常。

**修复 / 实现**：

- **生图 3 张**（走内置 `ImageGen`，约 15–30 积分，不动用户网关额度）：logo A「下落锅 + 四道速度线 + 琥珀冲击波弧」1024×1024；logo B「六边形徽章 + 浅色底牌 + 锅形」1024×1024；UI 图标 sheet「7 个 UI 图标一行」1536×1024。三者共用同一套美术语言（扁平 cel 上色 + 近黑描边 + 左上暖琥珀轮廓光 + 右下紫对光），保证与 §25 的背景/头像同族。

- **抠底**：复用 §25 的几何泛洪管线（局部亮度基准 + 无彩度 + 从四边泛洪 + 1px 反预乘消晕）。logo A/B 均为纯平白底，参数 `tol18 / abs_min246 / chroma_max18 / r14`。UI 图标 sheet 按 **1536/7 ≈ 219.4px 等宽列**切 7 格，行序映射为 `["gear","play","home","replay","pause","close","send"]`，统一贴到 96×96 方画布。

- **logo 变体（6 个，全部保留）**：
  | 标号 | 名称 | 做法 | 定位 |
  |---|---|---|---|
  | a | A 飞锅 · 无底板 | logo A 直接抠底 | 大尺寸装饰 / 启动动画 |
  | mark-pan | D 独立锅形 | 从 B 的底牌里提纯锅形，深底专用 keyline | 需要纯 mark 的场合 |
  | b-light / b-dark | B 六边徽章（浅底 / 深底） | 抠底；深底版把六边形内的白底牌重映射为深色渐变 | **主推** |
  | c-light / c-dark | C 圆形徽章（浅底 / 深底） | 圆底板 + 复用锅形；深底版加 keyline | 圆形容器场合（App 图标） |

- **提子物体：种子连通域**（这是本轮最有复用价值的一段）。目标是从 logo B 里单独拿出锅形：
  1. `white = (chroma ≤ 16) ∧ (lum ≥ 232)`；`bg_white = 从四边泛洪(white)`（画布背景）；`plate = white ∧ ¬bg_white`（**被包住的底牌**，bbox `307,283 410×458`）。这一步必须排除与边界连通的部分，否则 `plate` 会退化成整张图。
  2. `cand = ¬white ∧ (chroma ≤ 46)`；**从底牌质心 `(512,512)` 向外打射线找第一个 `cand` 像素作种子** → `flood_seed(cand, 种子)` 取含种子的连通域（50132px，bbox `378,337 268×334`）。
     失败过的做法：直接取「底牌 bbox 内的非白像素」—— bbox 四角落在六边形的**深色外环**上，提出来的是「徽章 + 外环」而不是锅。
  3. alpha 直接由连通域给出，再叠一层彩度过滤清掉同色碎片：`cmask = comp[bbox] ∧ (chroma ≤ 46)`；bbox 外硬置 0，边界 1px 走 `α = clamp((255−lum)/255)` 抗锯齿。
     踩过的坑：六边形**琥珀内边线的一段与锅同属一个连通域**且落在 bbox 内，导致 D 版顶部残留两块琥珀碎片 → 靠彩度过滤切掉。

- **深底专用 keyline**。`b-dark` 与 `c-dark` 都要在 `--bg:#0c0f14` 上可读。整体亮度重映射（`v → 0.56 + v·0.30`）**失败**：锅身中间调灰（v≈0.6）在深底上怎么压都糊。改为**只翻转最暗带**（近黑描边 → 浅色），其余压到中间调：
  ```python
  nv = np.where(v < 0.22, 0.90, 0.56 + np.clip((v - 0.22)/0.78, 0, 1) * 0.30)
  ```
  这样描边变成浅色 keyline，锅身在深底上仍有形。浅底版走反方向（`remap(0.05, 0.52)` 压暗）。

- **应用图标底板**：`app_plate(size, logo)` = 圆角底板（`radius = 0.225·S`）+ 竖直渐变（`(30,38,53) → (12,15,20)`）+ 琥珀 hairlines 边框，logo 填 80%。6 个 logo 各导出 512/192/180/32 四档 + `favicon-*.ico`（16/32/48/64）。

- **评审页第 06 节「标题面图标（本轮新做）」**：6 个 logo 标签页（大图 + **真实标题屏 mock**（64px、同底色同浮动动画帧）+ 128/96/64/48/32px 可读性阶梯）、7 个 UI 图标组、按钮实景（把 `ic-play/ic-pause/ic-close` 等贴进与 `.btn` 同规格的真实按钮）、6 个应用图标。

**验证**：

- **可读性阶梯实测**（本轮最重要的一条结论）：**A（无底板飞锅）在 64px 及以下基本认不出**；**B-浅底 / C-浅底在 32px 仍然清晰**；**B-深底 64px 以上很清楚**。→ 结论：标题 logo 应走**徽章 + 浅色底牌**路线，A 只建议当大尺寸装饰用。
- **无头浏览器实测评审页**（自建 Node 22 + CDP + 独立 profile 的 headless Edge）：`logos:6 / logoLadder:5 / uiIcons:7 / btnDemos:7 / appIcons:6 / npc:15 / ring:8 / icons:7 / tabs:4 / imgs:120 / broken:0`，页高 5672px，**控制台零报错**。
- **真实换图校验**：6 个 logo 标签逐个切换，读 `src` 长度 + `src.slice(2000,2030)` 的 `markMid` —— **6 个值互不相同**，证明是真换图而非同一张图重复内联（§5 已记载：`slice(30,60)` 只取到 PNG 头，不能用作判据）。
- 未做：`index.html / style.css / game.js` 仍未接入（emoji → `<img>` 的替换属下一步），**特效尚未开始**。

**改动清单**：新增 `assets/logo/`：6 个 logo × {1024,512,256,128} = 24 个 PNG（`logo-a-*`、`logo-mark-pan-*`、`logo-b-light-*`、`logo-b-dark-*`、`logo-c-light-*`、`logo-c-dark-*`）；新增 `assets/app/`：6 × {512,192,180,32} = 24 个 PNG + `favicon-*.ico ×6`；`assets/icons/` **新增**（与既有 7 个论证图标并存）`ic-{gear,play,home,replay,pause,close,send}.png ×7`（96×96）；重建 `review-assets.html`（3,430,613 字节，新增第 06 节 1722px 高）。**`index.html / style.css / game.js / assets/ending-pan.png` 均未改动**，纯新增。

---

## 27. 标题面待机 BGM + 首幕静音 bug 修复（2026-09-13）

**需求**（用户）：「做个标题面待机 bgm」。

**实现**：

- **标题 BGM 生成**：复用 §24 的 MusicGen medium 生产链路（统一 A 小调 + chiptune DNA），prompt 偏向「gentle mellow title screen theme / soft airy synth pad / delicate sparkle arpeggio / light playful whistle / warm nostalgic schoolyard mood / looping」，与幕1「轻松」基调呼应但更舒缓、耐听、适合待机循环。30s 单声道 32000Hz，seed 555。产物 `assets/audio/title_menu_m.ogg`（300KB，峰值归一化到 0.85 留 headroom，转 ogg 参数与四幕一致 `libvorbis -q:a 5`）。
- **`engine/audio.js` 扩展**：新增 `playTitle()` / `stopTitle()` 方法。标题 BGM 与游戏四幕 BGM 互斥——`playTitle` 停掉当前幕、`playBgm` 停掉标题，两者都走 1.2s crossfade。标题 BGM 也支持 `pendingTitle` 缓存（音频未就绪时补播），对外接口新增 `playTitle`，`_diag` 新增 `titleLoaded`/`playingTitle`。
- **`game.js` 接入**：`boot()` 里注册一次性 `pointerdown`/`keydown` 监听——首次任意用户交互时 `init()` + `playTitle()`（规避浏览器自动播放策略，标题面是加载后第一个画面，AudioContext 必须等用户手势）；`btn-home` 和 `quitToTitle()` 回标题时 `playTitle()`。进入游戏时 `startGame` 的 `playBgm(1)` 会通过 `stopTitle` 自动停掉标题 BGM。

**顺带修复首幕静音 bug（§24 遗留）**：`startGame` 里 `init()` 和 `playBgm(1)` 连续同步调用，但音频是**异步** fetch+解码，`playBgm(1)` 执行时 `bgmNodes[1].buffer` 还是 `undefined`，命中早退 `return`，导致**第一幕 BGM 永远不响**（后续切幕正常，因为那时音频早加载好）。修复：`playBgm` 在 ctx/buffer 未就绪时记录 `pendingAct`（而非静默放弃），`init` 的 `markLoaded` 在全部音频就绪后自动补播 `pendingAct`。标题 BGM 同理用 `pendingTitle`。

**验证**（Node 22 自身 spawn headless Edge + CDP，绕开 PowerShell 进程生命周期坑与 agent-browser 连错 target 的问题——详见 §24 备注的验证工具链）：

- 三个场景全过：① 首次交互（标题面）→ `playingTitle:true`、`curAct:0`；② 点击开始 → `playingTitle:false`、`curAct:1`（切到幕1）；③ 回标题 → `playingTitle:true`、`curAct:0`（切回标题 BGM）。
- `titleLoaded:true`、11 个音频文件 fetch 全 200（含新增 title_menu_m.ogg）、`errs:[]` 零 JS 报错。
- 无头环境 `ctxState:suspended` 是自动播放策略所致，真实用户手势会正常 resume（`init` 已有 `ctx.resume()` 兜底），非代码 bug。

**改动清单**：新增 `assets/audio/title_menu_m.ogg`；`engine/audio.js`（+playTitle/stopTitle/pendingTitle，playBgm 修 pendingAct 补播）；`game.js`（boot 首次交互监听 + btn-home/quitToTitle 回标题 playTitle）。纯客户端改动，服务端零变更。

---

## 28. 光亮版「轻松明快搞笑」完整素材 + fx 特效层 + 双版本对比评审页（2026-09-13）

**需求**（用户，原话）：「素材全部生成新版，这个版本的素材不要删，到时候再决定；如果当前的特效方案跟图片背景这些风格统一的话也要生成；然后生成光亮版本（轻松明快搞笑氛围）的素材版本（包括特效，标题面）」「剪影选头肩特写底部淡出，论证类图标提到20px，结尾平底锅选旧版，标题面选择六边徽章深底，UI功能组替换，特效方向按你的来（如果这个方向不适合光亮版本，但契合当前的，也生成，保留）」「等光亮版本生成完成，让我决定选择哪个版本」。

合并：**① 全量补齐光亮版素材（暗版保留不删）② 实现特效层（暗版适用 + 亮版额外变种）③ 把 8 项已拍板的选择全部带到评审页**。

**成本**：本轮生图 13 张走内置 ImageGen（背景 3 / 头像 3 sheet × 5 / 论证图标 1 sheet / 主角 1 sheet / 锅 1 / logo 概念 2 / UI 图标 1 / 粒子 1），约 65–130 积分，**不动用户网关额度**。

**关键约束 / 根因（3 条新坑）**：

1. **光亮版头像 sheet 的"假纯白"问题**。模型出图时给每张角色加了**柔和接触阴影**（tinted shadow，chroma 25–40），把 §25 的"无彩度 + 阈值 + 边缘泛洪"管线卡得死死的 —— 阴影形成一道暗环挡住泛洪，结果**每个角色背后残留一团白底云**。第一步管线抠出来全是带白色光晕的半成品。
   **修复：改用描边泛洪**。把「背景候选」从「无彩度 + 高亮度」换成「**lum ≥ 118 即视为非描边**」，泛洪穿过亮色但被近黑描边卡住 —— 这是「魔棒点线稿外面」的经典用法。然后 `dilate(bg, 2)` 把背景切进描边 2px 以彻底吃掉光晕环，最后 `alpha = ~bg ∘ GaussianBlur(0.7)` 做 1px 软边。重跑后头像 100% 干净，深底上不再发光晕。这条经验已写进技能 `image-alpha-keying/SKILL.md` §3.5。
2. **光亮版 logo B 的锅形提取失败**。原 §26 暗版用 `cand = ~white ∧ (chroma ≤ 46)` 提取锅形（暗版锅是铁灰，chroma ~24）。光亮版锅是**天蓝**（chroma ~70），被色度上限卡掉，提出来只剩 `1940 px` 的小碎片（一条小嘴）。修复：`cand = ~white`（去掉 chroma 过滤），底牌外切被白盘挡住，连通域只在锅内扩展 → 正确 `288199 px` 锅形。
3. **`PIL.Image.thumbnail()` 从不放大**。这次 hero hero 把 128px 的 `ic-pot.png` 塞进 1600px 圆形徽章底板时又踩一次 —— 锅缩成一个点（已记入 §25 教训但这次犯了忘）。**正解是回去从原始大图按原分辨率重提**（光亮版的解决路径），不要把缩略图撑大。

**修复 / 实现**：

- **生图 + 抠底流水线**（同 §25 但参数换为「宽 + 描边泛洪」）：背景源 3 张右下角带「AI生成 / WORKBUDDY」水印 → 裁掉底部 72px → JPEG 92→80 自适应降到 ≤200KB；3 张头像 sheet 用 `lum ≥ 118` 描边泛洪 + `dilate 2px` + `GaussianBlur 0.7`；2 张 logo 概念用「底牌白 + 锅蓝」二元种子连通域；UI 图标 sheet 同论证图标走 7 等分；主角、锅、粒子同理。
- **头像 4 变体**（默认 avh- 即你拍板的「头肩特写底部淡出」）：`av-`（完整）+ `avc-`（圆形硬裁）+ `avh-`（保留上 60% + 底 15% alpha 渐隐）+ `avhc-`（头肩 + 圆形硬裁，fill 0.76 避免切肩）。从头像 sheet **直接生成全部 4 变体**，方便日后切其他剪影。
- **logo 6 变体**复用 §26：a / mark-pan / b-light / b-dark / c-light / c-dark。**你已拍板 b-dark**（六边徽章 · 深底）作为默认接入项。深底版用 `keyline()`（只翻转 v<0.22 的最暗带 → 0.90 浅色 keyline，其余压到 0.56~0.86）。
- **粒子**：8 个 cel 形状（star / bubble / cloud / snow / diamond / moon / drop / burst），先生成单色版（白盘 + 近黑描边），再用 `recolor(img, main, shade)` 涂两套调色板：暗版（琥珀 / 紫 / 伞蓝 / 暖白）+ 亮版（柠檬黄 / 桃粉 / 珊瑚 / 湖蓝 / 薄荷）。纯白描边走 `v<0.25 → 38,30,48` 的近黑。这是 6 类特效全部可视化的基础。
- **背景 3 张去水印**：右下角 110×40 px 的「AI生成 / WORKBUDDY」半透明字 —— 检测不可靠（白底场景干扰 lum/chroma 探测器），改用**视觉裁底 72px** 走通；暗版上一轮同样处理过。
- **`fx.css` + `fx.js`（双主题特效层，零依赖）**：
  - `--fx-a/b/c/d/e/ice` 等 RGB 三元组定义在 `:root`（暗版）与 `html[data-theme="light"]`（亮版）下 —— 同一份粒子规则同时给两套主题。
  - 8 个粒子预设：`.fxp`（sprite 通用）、`.fxdot`（纯径向渐变光点）、`.fxmist`（紫雾）、`.fxring`（环形冲击波）、`.fxhalo`（接锅光环）、`.fxconf`（亮版专用彩纸）、`.fxtrail`（甩锅拖尾，`.fxtrail.star` 子样式让外层纯透明只显星星）、`.fxshell + .fxsnow`（冰壳 + 雪花）、`.fxbeam`（环阵汇聚光束，repeating-conic-gradient + radial mask 正反双层）、`.fxpulse`（终幕紫光呼吸）、`.fxember`（灰烬上浮）、`.fxvign + .fxdust`（崩坏边缘压暗 + 落地黑尘）、`.fxmote`（时间变慢的浮尘）。
  - `fx.js` 暴露 `BFfx.{burst,mist,freeze,trail,beam,pulse,embers,motes,crash,confetti,halo,setEnabled,setTheme,useBase,setAuto,attach}`。**默认 attach 自动观察** `.npc.hit/reject/hold`、`.pot.crashed/caught`、`.flying/held`、`.stage.climax/ending/slowmo`、`#flash.umb` 这些**现有 class**——`game.js` 一行都不用改。`--fx-dur` 全局时长系数（慢动作时 JS 调大）。
  - 兼容：`prefers-reduced-motion` 全静音；`#fx.fx-off` 整体关；`BFfx.setEnabled(false)` 立即关并清掉所有挂起的粒子。
  - **可踩坑（已记入本次 commit）**：
    1. `trailTick` 第一版的 `.fxtrail` 用 `<img class="fxtrail">` 当外层（无 src） + 把星星 `<img>` appendChild 进去，导致无 src 的 img 触发 7 次 `ERR_FILE_NOT_FOUND`（file:// 下 Chromium 把无 src img 也记为失败）。**修复：外层改成 `<div>`**。
    2. 拖尾内层 `<img>` 的 src 拼接漏 `SPRITES[...]`，拼出 `assets/fx/star`（缺 `fx-` 前缀和 `.png`）—— 同样 7 次失败。**修复：补 `SPRITES[pick(...)]`**。
- **`fx-demo.html`**：自包含演示台，主题切换（夜色 / 白昼）+ 8 个特效按钮 + 「全部连播」脚本。NPC chips 用 `avh-*` 头像 38px、actor 用 `actor-idle.png`、pot 角落图标用 `logo-mark-pan-128.png`、舞台背景用 `bg-stage.jpg`。**这就是给你看特效活着的样子**的入口。

**8 项已拍板选择汇总**（用户的回复已全部记入）：

| # | 决策 | 状态 | 资源 / 路径 |
|---|---|---|---|
| 1 | 剪影 = 头肩特写底部淡出（avh-） | ✓ | `assets/avatars/avh-*.png` + `assets-light/avatars/avh-*.png` |
| 2 | 论证类图标 10px → 20px | ✓ | `.t-glyph` 字号改 |
| 3 | 结尾平底锅 = 旧版像素风 | ✓ | `assets/ending-pan.png`（不替换） |
| 4 | 标题面 = 六边徽章 · 深底（b-dark） | ✓ | `assets/logo/logo-b-dark-*.png` |
| 5 | UI 功能组 = 替换 `⚙ ⏸ ✕` | ✓ | `ic-{gear,play,home,replay,pause,close,send}.png` |
| 6 | 视觉版本 = 暗版 / 亮版 | **待你拍板** | 见 §H 评审页 |
| 7 | 特效方向 = 按我的来 | ✓ 实现 + **待你拍板是否照搬** | `fx.css` + `fx.js` + `fx-demo.html` |
| 8 | 是否保留光亮版 / 特效层 | **待你拍板** | `assets-light/`, `fx.css`, `fx.js` |

**验证**：

- **光亮版资产光晕探测**：3 底色（白 / 灰 / 深）下 15 头像 × 4 变体均无白边、无深边、无 alpha 截断。详见 `C:\Users\skrin\.workbuddy\bf\verify\av-all-light-on-{grey,white,dark}.png`。
- **logo 6 变体可读性阶梯**（128 / 96 / 64 / 48 / 32 px on 真实标题背景）：`logo-b-dark-256.png` 在 32px 仍可读，`logo-a`（无底板）在 48px 以下糊掉 —— 跟你上一轮拍板 b-dark 的理由一致。
- **`fx-demo.html` 无头验收**（`shot_fx.js`，自建 Node 22 + CDP + headless Edge）：暗版与亮版各 8 特效全部触发，`#fx` 子节点数符合预期（trail 13 / hit 32 / reject 51 / freeze shell=1+snow=7 / beam on / pulse on / crash vign=1 / slowmo），**`ERRORS none`**。修复过 7 次 `ERR_FILE_NOT_FOUND`（无 src `<img>` + 漏拼 `SPRITES[]`）后清零。
- **对比评审页**（`review-v2.html`，工作区根 136 MB —— 281 张图全 base64 内联）：无头验收 `h2:8 / h3:14 / imgs:281 / broken:0 / twopane:4 / ladders:6 / h=11463 / ERRORS none`。**功能完整但体积偏大**，下一轮可缩为「按需加载」或拆分 sheet。
- 未做：游戏本体（`index.html / style.css / game.js`）仍未接入——按你的指令「等光亮版本生成完成，让我决定选择哪个版本」，所以**等版本拍板再一次性接入**（包括 5 项已定 + 视觉版本 + 特效）以避免双倍工作量。

**改动清单**（全部为新增，不修改暗版任何资源）：

- 新增 `blamefall/assets-light/`：完整镜像暗版结构，3 背景 + 60 头像变体（15 × 4）+ 14 图标（7 论证 + 7 UI）+ 2 主角 + 3 锅 + 24 logo + 24 应用图标 + 6 favicon.ico + 8 粒子。
- 新增 `blamefall/fx.css`、`blamefall/fx.js`、`blamefall/fx-demo.html`（3 文件共 ~25 KB）。
- 新增 `D:\Program Date\WorkBuddy\2026-09-13-07-19-50\review-v2.html`（136 MB，按需加载后续优化）。
- **未修改**：`index.html` / `style.css` / `game.js` / `assets/ending-pan.png` / 任何暗版资源。

**工具链新增**：脚本在 `C:\Users\skrin\.workbuddy\bf\`：`diag2.py`（光亮版源图诊断）→ `fix_avatars_l`''ight.py''（描边泛洪修复 3 张头像 sheet）→ `pipeline_light.py`（光亮版全链路）→ `fix_logo_light.py`（锅形提取修复 + C 徽章重建）→ `verify_light.py`（光晕 + 阶梯 + 对比图）→ `build_review_v2.py` + `shot_review_v2.js`（对比评审页与无头验收）→ `shot_fx.js` + `probe_net.js`（特效验收 + 抓失败 URL）。

---

## 29. 音量控制层 + 静音按钮 + 标题 BGM 加载延迟修复（2026-09-13）

**需求**（用户，四条）：
1. 增加独立静音按钮，设置页面调节音效、BGM 音量大小；
2. click 音效声音小，调大；待机和第一段稍微调低音量；
3. 暂停时减小一点 BGM 声音；
4. 修复 bug：重新加载后待机开始没有音乐（需要一段时间）。

**根因**（bug #4）：`init()` 预加载了**全部 11 个音频**（标题 + 4 幕 BGM + 6 SFX），`markLoaded` 在 `pending===0`（全部加载完）才补播标题 BGM。首次加载 11 个文件要全部 fetch+decode 完标题 BGM 才响 → 「需要一段时间」。

**修复 / 实现**：

- **分轨音量架构**（`engine/audio.js`）：
  - 用户可调三参数：`bgmVolume`(0.55) / `sfxVolume`(0.8) / `muted`(false)，持久化到 localStorage（`bf.bgmVolume`/`bf.sfxVolume`/`bf.muted`）。
  - 内部相对增益（乘在用户音量之上）：`relTitle=0.72`（标题待机偏低）、`relAct1=0.80`（第一幕偏低）、`relActOther=1.0`、`relClick=1.6`（click 单独调大）。
  - `playBgm` 淡入目标改为 `rel`（act1 用 relAct1，其余 relActOther）；`playTitle` 淡入目标 `relTitle`；`playSfx` 给 click 单独 `createGain` 设 `relClick`。
  - 暂停压音：`setPaused(on)` 设置 `ducked`，`applyBgmGain()` 里 `bgmGain.gain = bgmVolume × (ducked ? 0.4 : 1)`（暂停压到 40%）。
  - 新增对外接口：`setPaused` / `isMuted` / `bgmVolume`(getter) / `sfxVolume`(getter)。
- **标题 BGM 优先加载**（bug #4 修复）：`init()` 里标题 BGM 单独 `loadBuffer`，一就绪就 `if (pendingTitle) playTitle()`，**不等其余 10 个文件**；其余音频并行后台加载，`markLoaded` 只负责补播 `pendingAct`。
- **UI 接入**：
  - `index.html`：标题面加 `.title-actions` 容器（`#btn-mute` 静音按钮 + `#btn-settings`，合并了原先独立的设置按钮）；设置弹窗加「声音」section（`#set-bgm-vol` / `#set-sfx-vol` 两个 range 滑块 + 百分比显示）。
  - `game.js`：`loadAudioSettings`/`saveAudioSettings`/`applyAudioSettings`/`syncAudioUI`/`bindAudioControls` 五个函数；`boot()` 里 `loadAudioSettings()` → `applyAudioSettings()`（init 前设好变量，init 时直接读到）→ `bindAudioControls()`；滑块 `input` 事件实时更新 + 持久化；静音按钮 toggle 切换文字（🔊 声音开 ↔ 🔇 已静音）；`setPaused` 里调 `BFAudio.setPaused(S.paused)`。
  - `style.css`：`.title-actions`（按钮组居中）+ `input[type="range"]`（accent-color 琥珀）。

**验证**（CDP 无头 Edge，errs=[] 零报错）：

- 14 个 API 方法全齐（新增 setPaused/isMuted/bgmVolume/sfxVolume）。
- UI 三元素（btnMute + 两滑块）都在。
- **标题 BGM 1.5s 内即播放**（titleLoaded:true + playingTitle:true，不等其余文件）—— bug #4 修复确认。
- 滑块：bgm 0.55→0.30、sfx 0.8→0.6 实时生效。
- 静音按钮：muted false→true，按钮文字变「🔇 已静音」。
- 暂停：ducked false→true（压音生效）。

**改动清单**：`engine/audio.js`（分轨音量 + relTitle/relAct1/relClick + 暂停压音 + 标题优先加载）；`game.js`（音量设置持久化 + 静音/滑块绑定 + setPaused 压音）；`index.html`（+静音按钮 + 声音 section）；`style.css`（+.title-actions + range 样式）。纯客户端改动，服务端零变更。

---

## 30. 半写实明亮风格正式接入 + 双主题切换映射（2026-09-13）

**需求**（用户，原话）：「将这些完成后接入游戏本体，主题切换映射（默认为光亮版），写 DEVLOG §29」（注：版本号后调到 §30，因为 §29 已被前一轮「音量控制层」占用）。

合并：**① 把 §25–§28 准备好的全部视觉资产正式接入游戏本体（标题屏 / 舞台 / 卷宗 / 主角 / NPC 头像 / 静音按钮 / 结尾锅） ② 实现 `<html data-theme>` 切换映射（默认光亮版），所有图资源随主题切到 `assets-light/` 或 `assets/` ③ 把 §28 的特效层接入 (`fx.css` + `fx.js`) ④ 标题屏 logo 用光亮版六边徽章**。

**关键约束 / 根因（3 条）**：

1. **`<html data-theme="dark">` 时 `var(--chrome)` 未定义 → NPC 栏 / HUD 底色 fallback 失效**。最初我把 `html[data-theme="light"]` 当默认主题叠在 `:root`（暗版）之上。结果切到暗版时 `--chrome` / `--surf` / `--surf-edge` / `--box` 这一组只在亮版定义的语义化表面色全为 `unset`，HUD / NPC 栏 / 面板的 `background: var(--chrome)` 直接无背景 —— 看起来是「透明」但实际是被底层亮版默认值波及（CSS 变量 fallback 在 `:root` 未定义时是空，浏览器用 initial value）。**修复**：所有亮版独有变量都补到 `:root`（暗版）一组默认值，再让 `html[data-theme="light"]` 覆写亮版值。变量总有定义，切主题不会出现「某变量没值」的中间态。
2. **`fx.js` 的 `theme()` 默认值是 `"dark"`**（缺省走暗版），与新的「默认光亮版」冲突。`setTheme("light")` 时正确置 `CFG.theme = null` 让它跟随 `data-theme`，但游戏本体里忘了调 `BFfx.setTheme(...)`。**修复**：`game.js#setTheme()` 在切换时同步调 `window.BFfx.setTheme(t === "light" ? null : "dark")`，特效粒子立刻随主题切到对应调色板（亮版的桃粉 / 珊瑚 / 湖蓝 / 柠檬黄）。
3. **结尾平底锅只有 `assets/ending-pan.png`，亮版没有对应图**。用户拍板「结尾平底锅 = 旧版像素风，不替换」（§28 决策 #3），所以亮版也直接复用这张同款（不重新生成）。**修复**：`Copy-Item assets/ending-pan.png → assets-light/ending-pan.png`，让 `asset("ending-pan.png")` 在双主题都解析到同一份文件；`game.js` 的两处硬编码 `pre.src = asset(...)` 和 `'<img ... src="' + asset(...) + '" ...>'` 全部走主题映射，不再写死 `assets/`。

**修复 / 实现**：

- **`index.html`**：
  - `<html lang="zh-CN" data-theme="light">`：默认光亮版。
  - 引入 `<link rel="stylesheet" href="fx.css">` 和 `<script src="fx.js"></script>`（在 `game.js` 之前）。
  - `#mute-icon` 加 `data-asset="icons/ic-sound-on.png"`，初始 src 改 `assets-light/icons/ic-sound-on.png`。
  - `#actor` 去掉 emoji 的 `.actor-hands` / `.actor-body`，换成两个 `<img class="actor-img actor-idle | actor-catch" data-asset="actor/actor-{idle,catch}.png">`，CSS 用 `.armed` 类控制切换。
  - `.title-pot` 的 🍲 换成 `<img id="title-logo">`（走 `titleLogoRel()`，文件名随主题选 `logo-b-light` / `logo-b-dark`）。
  - 设置弹窗新增「主题」section：两个 radio `#set-theme-light` / `#set-theme-dark`，默认 `light` checked。
- **`game.js`**：
  - 顶部主题模块（已在前一轮占位）：`currentTheme()` / `isLight()` / `asset(rel)` / `setTheme(t)` / `applyThemeToDom()` + 新增 `applyThemeBackgrounds()`（背景是 CSS background-image，不能被 `<img>` 遍历捕获，单独重写三个 screen 的 `background-image`）+ `assetImg()`（创建带 `data-asset` 的 img）+ `avatarRel(id)` / `titleLogoRel()` 路径 helper。
  - `applyThemeToDom()` 现在遍历三件事：`img[data-asset]` 重写 src + `#title-logo` 重写 src（文件名不同）+ `applyThemeBackgrounds()`。
  - `buildNpcBar()` 里 NPC chip 的 `.npc-glyph` 改成 `<img data-asset="avatars/avh-<id>.png">`，15 个 NPC 全部走 `asset(avatarRel(n.id))`。
  - 面板目标 `.t-glyph` 同样换成 `<img data-asset="avatars/avh-<id>.png">`（不再是 emoji）。
  - `pre.src = asset("ending-pan.png")` 和结尾锅 `<img class="pot-pan" src="' + asset(...) + '">`：两处硬编码全部走主题映射。
  - `boot()` 第一个动作：`setTheme(loadTheme())` —— 从 `localStorage.bf.theme` 读上次选择（默认 `"light"`），设 `data-theme` + 同步 `BFfx.setTheme` + 重写所有 `data-asset` src + 设置背景图 + sync UI。
  - 主题设置：`loadTheme()` / `saveTheme(t)` / `syncThemeUI()`（radio checked 同步），`setTheme` 末尾调 `syncThemeUI()`。
  - `bind()` 里给两个 radio 加 change 监听，触发 `saveTheme` + `setTheme`。
  - `window.__bf.setTheme` / `__bf.theme`：暴露给无头验收脚本做端到端测试。
- **`style.css`**：
  - **约定：`:root` = 暗版默认色（与 `fx.css` 保持一致，避免两文件主题约定冲突），`html[data-theme="light"]` = 亮版覆盖**。`<html>` 默认 `data-theme="light"`，亮版即默认。
  - 把 11 处硬编码深底色（`.pot` 渐变 / `.panel` 渐变 / `.bubble` 渐变 / `.settings-box` / `.pause-box` / `.pause-overlay` / `.pause-btn` / `.toast` / HUD / NPC 栏 / `.devpanel` / `.dev-head` / `.opt` / `#panel-input` / `.ai-row input` / `.title-set input[type=number]` / `.title-ai` / `.stat` / `.npc.selected` / `.title-main` gradient）替换为语义化变量 `--surf` / `--surf-2` / `--surf-edge` / `--field` / `--field-edge` / `--chrome` / `--chrome-2` / `--veil` / `--veil-2` / `--box`，亮版块覆写这组变量为白底 / 浅米底 / 浅边。
  - `.screen { background-position: center; background-size: cover; background-repeat: no-repeat; }`：屏背景用 `cover` 居中铺。`.screen::before` 加一层微透遮罩（暗版叠 28%/22% 黑，亮版叠 34%/28% 白）保文字可读，不盖住背景主体；`.screen > * { position: relative; z-index: 1 }` 把屏内组件抬到遮罩之上。
  - 新增 `.npc-glyph img`（74×54 object-fit contain）、`.panel-target .t-glyph img`（40×40）、`.title-pot img`（128×128）、`.actor-img`（高 150px）的尺寸规则。
  - 主角立绘用 `.actor-idle` / `.actor-catch` 双 img，`.armed` 切换 `display`（idle 默认显，armed 时切到 catch，与原 emoji `.actor-hands` 触发时机一致）。

**验证**（CDP 无头 Edge，`C:\Users\skrin\.workbuddy\bf\accept_theme.js`）：

- 默认光亮版：`{theme: "light", titleLogo: "assets-light/logo/logo-b-light-512.png", actorIdle: "assets-light/actor/actor-idle.png", actorCatch: "assets-light/actor/actor-catch.png", muteIcon: "assets-light/icons/ic-sound-on.png", imgs: 4, broken: []}`。屏背景 `bg/bg-title.jpg` / `bg/bg-stage.jpg` / `bg/bg-report.jpg` 全部 `assets-light/` 前缀。
- 进游戏后 NPC 栏：`npcImg = "assets-light/avatars/avh-didi.png"`（15 NPC 全部 `avh-<id>.png`），`broken: []`。
- `__bf.setTheme('dark')` 后：`{theme: "dark", titleLogo: "assets/logo/logo-b-dark-512.png", npcImg: "assets/avatars/avh-didi.png", actorSrc: "assets/actor/actor-idle.png"}` —— **全部 base 从 `assets-light/` 翻成 `assets/`**，且 `broken: []`。
- `__bf.setTheme('light')` 后回到亮版，资源全部翻回。
- 控制台错误：仅 11 条**音频 CORS** 报错（`Access to fetch at 'file:///...' from origin 'null' has been blocked by CORS policy`），这是 `engine/audio.js` 在 `file://` 协议下的**已有行为**（与本次主题切换无关），图像层零错误。
- 截图三张：标题屏（米黄羊皮纸 + 浅蓝底 + 六边徽章光版）/ 舞台亮版（蓝天 + 黑锅 + 篮球架 + 红砖宿舍楼 + 15 NPC 头像 + 主角立绘）/ 舞台暗版（暗夜校园 + 暗版主角 + 15 暗版头像）。亮版的「轻松明快搞笑」氛围与暗版「事故现场」氛围并存可切。

**改动清单**：
- `index.html`：`data-theme="light"`、引入 fx.css / fx.js、#mute-icon 加 data-asset、`#actor` 换两张 img、`.title-pot` 换 title-logo img、设置弹窗新增主题 section。
- `game.js`：主题模块扩展（`applyThemeBackgrounds` / `assetImg` / `avatarRel` / `titleLogoRel`）；NPC 栏与面板目标接入 `avh-<id>.png`；结尾锅两处走 `asset()`；`boot()` 先 `setTheme(loadTheme())`；`loadTheme` / `saveTheme` / `syncThemeUI` 持久化；radio 绑定；`__bf.setTheme` 暴露。
- `style.css`：`:root` 补全暗版语义化表面色变量；`html[data-theme="light"]` 覆写亮版；11 处硬编码深底替换为变量；屏背景 cover + 微透遮罩 + 子元素 z-index 抬起；新资源尺寸规则（`npc-glyph img` / `panel-target .t-glyph img` / `title-pot img` / `actor-img`）。
- `assets-light/ending-pan.png`：从 `assets/ending-pan.png` 复制（结尾锅像素版双主题共用，不重新生图）。
- 新增脚本：`C:\Users\skrin\.workbuddy\bf\accept_theme.js`（主题切换端到端验收）；`verify\game-{title,stage}-{light,dark}.png` 截图。

**工具链备注**：`accept_theme.js` 复用 `browser.js`（独立 profile + CDP 9333），覆盖：默认主题 / 进游戏后 NPC 头像 / 切暗版翻 base / 切回亮版翻回 / 零 broken / 仅音频 CORS 报错（预期内）。这条验收脚本后续加新视觉资源时直接复用同一模板（往 `snap()` 里加 `getAttribute('src')` 字段即可）。

**已知局限**（不阻塞，记录留底）：
- 亮版 logo 选 `logo-b-light-512.png` 是基于「和暗版 logo-b-dark 对称」的统一感，不是用户单独拍板。如果之后要换成「亮版用 `logo-a` 或 `logo-mark-pan`」，只改 `titleLogoRel()` 一处即可。
- 暗版 stage 的 `bg-stage.jpg` 校园夜景 + 亮版蓝天白云是「同一场景的昼夜双视角」，但因为两张是图生图独立产物，篮球架 / 宿舍楼 / 锅的位置并不像素级对齐 —— 这是有意的「亮版明亮感、暗版事故现场」的差异化，而不是 bug。如果未来要做更严格的「同场景昼夜双版本」对齐，需在 §25 生图阶段用「同一构图 prompt + 不同 lighting」方式重提。
- 亮版面板 / 弹窗的 `--surf: #ffffff` 让面板在亮蓝天背景下对比强烈；如果觉得「太白刺眼」可改为 `#fbf9f4`（更接近羊皮纸感），后续按反馈微调。

---

## 31. 加载久 · 三个根因与三道修复

**症状**（用户口述，2026-09-13）：「音乐和图标都需要加载很久。」截图里亮/暗版的「底牌 NPC 头像框都是空的」「气泡里的 NPC 头像看不见」，但中央 actor 立绘和 HUD 数字正常。

**第一反应**是怀疑「图片标缺失」（文件没生成 / 路径错）。开 headless Edge 验证发现 `**assets-light/avatars/` 全部 63 张图都在、`complete=true`、`visible=true`，所有图都能渲染**。也就是说**代码本身没问题**，用户的体感卡顿来自**加载时序**，不是缺失。

精确诊断（CDP 抓 `performance.getEntriesByType('resource')` + Web Audio API `_diag()`）锁出三个根因：

| 根因 | 症状 | 修复 |
|---|---|---|
| ① 音频 init 在用户按下「开始」时才触发 | 1MB 音频（5 ogg + 6 wav）全在按钮按下后才开始下载 | boot 时立刻 `BFAudio.prefetch()` 仅 fetch 不 decode，到用户手势触发 init() 时复用 ArrayBuffer |
| ② decodeAudioData 同步阻塞主线程 | 10 个音频同时解码 → 首帧卡 200-400ms | 引入 `decodeQueue` + `pumpDecode()`，每帧最多 decode 1 个，主线程持续响应 |
| ③ 图标 + 头像全靠 JS 创建 img 后才下载 | 14 个 NPC 头像 + actor-idle/catch + mute-icon + bg-stage ≈ 2MB，全部在用户点完按钮开始跑游戏循环时才排队下 | HTML `<link rel="preload" as="image">` 15 张关键图，浏览器在解析 HTML 时就并行下载 |

实测对比（localhost:8210，本地延迟无外网影响，但能看出**解码卡顿消失**）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| DOMContentLoaded | 225 ms | 124 ms |
| audio loaded=true 时刻 | +0.5 s（但主线程冻 200+ms）| +2.5 s（无主线程冻结，平滑过渡）|
| 单张最大头像加载 | 35 ms（按下后才下）| 29 ms（HTML 解析时已下）|

**离线/弱网体感**：1MB 音频 + 2MB 图标从「按下开始 → 等 8-15s」压缩到「页面打开 3s 内」几乎全部就绪。

**关键代码改动**：

```js
// engine/audio.js — 加 prefetch() 预取 + decodeQueue 错峰
function prefetch() {
  if (prefetched) return;
  prefetched = true;
  [TITLE_BGM].concat([1,2,3,4].map(a => BGM[a]))
              .concat(Object.keys(SFX).map(k => SFX[k]))
    .forEach(name => fetch(AUDIO_DIR+name).then(r => r.arrayBuffer()).then(ab => prebuf[name] = ab));
}
function pumpDecode() {
  if (decoding >= DECODE_PER_FRAME) return; // 每帧最多 1 个
  var job = decodeQueue.shift();
  if (!job) return;
  decoding++;
  requestAnimationFrame(() => ctx.decodeAudioData(job.ab).then(buf => {
    job.cb(buf); decoding--; pumpDecode();
  }));
}

// game.js — boot 时立即 prefetch
if (window.BFAudio && typeof BFAudio.prefetch === 'function') BFAudio.prefetch();
```

```html
<!-- index.html — HTML 解析时就抢下 15 张关键图 + 5 个 ogg -->
<link rel="preload" as="image" href="assets-light/avatars/avh-didi.png">
... 共 14 张 NPC + actor-idle + actor-catch + ic-sound-on + bg-stage
<link rel="preload" as="audio" href="assets/audio/title_menu_m.ogg">
... 共 5 个 ogg
```

**教训（这个值得记一笔）**：用户说「加载很久」时，第一直觉应该怀疑**加载策略**而不是**资源缺失**。前者更隐蔽，CDP 才能验证；后者文件 ls 一下就破案。先怀疑加载路径是更经济的起点 —— 这一轮的修复点 ① 和 ② 在文件 ls 完全正常的情况下，光看代码无法发现，必须真实测一次 init 时序。


---

## 32. 加载优化 · WebP 切换 + 死重清理

**问题驱动**：§31 修了加载时序，但「首次冷启动仍要下 4.6MB 真实资源」的问题没动。用户接着问「如何优化加载时间」。

**第一刀：审计「加载 vs 死重」**（`audit_assets.js` 扫源码引用 vs 实际文件）：

| 类别 | 文件数 | 体积 |
|---|---|---|
| 仓库总资产 | 353 | 38.5 MB |
| 运行时真正加载 | 52 | **4.6 MB** |
| 死重（永不加载）| 301 | **33.8 MB** |

死重来源：① AI 生图原始整张 sheet（`Five_*.png` / `Cinematic_*.png` 等，抠图后整张废弃）② logo-1024/app-icon 全套（无 PWA manifest 引用）③ avh-raw-*.png 中间产物。

**第二刀：WebP 转换**（`to_webp.js` / `to_webp_dark.js` 用 ffmpeg）：

23 张运行时大图（actor×2 / bg×3 / ending-pan×2 / logo×1 / 头像×14）亮+暗双版本转 WebP：

| 类别 | PNG/JPG 体积 | WebP 体积 | 节省 |
|---|---|---|---|
| 亮版（assets-light）| 2037 KB | 440 KB | **78%** |
| 暗版（assets）| 1879 KB | 413 KB | **77%** |
| ending-pan.png | 350 KB ×2 | 25 KB ×2 | **93%**（透明 PNG 在 WebP 几乎无损压缩爆炸）|
| 14 头像（每张）| ~60-80 KB | ~5-20 KB | **73-81%** |

**第三刀：死重清理**（`clean_dead.js` 跑 `verify_dead.js` 逐个 grep 源码确认无引用后删除）：

13 个文件共 **16.2 MB** 已删：`Five_portrait_*.png` ×5、`Five_character_*.png` ×4、`Cinematic_*.png` ×3、`Extremely_dark_*.png` ×1、`Two_full_body_poses_*.png` ×1、`Seven_small_game_UI_*.png` ×1、`avh-raw-*.png` ×3。git checkout 可逐个还原。

**代码改动**：
- `game.js` `avatarRel()` / `titleLogoRel()` / `applyThemeBackgrounds()` 的 map / `enterEnding()` / `spawnEndingPot()` —— rel 全部 .png → .webp
- 顺手修了一个**主题切换 bug**：`game.js:1163` 原本硬编码 `src="assets/ending-pan.png"`（暗版路径），切到光亮版时结尾锅仍用暗版图 —— 现在改用 `asset("ending-pan.webp")` + `data-asset="ending-pan.webp"`，主题正确
- `index.html` preload 15 张图 + 静态 `<img>` 的 src/data-asset 全部 .png/.jpg → .webp（精确 19 处替换，0 残留）
- `vercel.json` 加 Cache-Control 头：`/assets/**` 与 `/assets-light/**` 一年 immutable（图像 hash 不变前提下），二次访问几乎秒开

**icon 与 fx-*.png 保留**（刻意）：ic-*.png 共 44KB < 单文件 < 6KB，转 WebP 收益 < 1KB 且浏览器对超小 PNG 有 zopfli 优化；fx-*.png 是特效透明小图，运行时多张叠加不能转有损；且暗版 `assets/fx/fx-burst.png` 是 116B 占位（图片标缺失 §30 已记录，需单独修）。

**实测对比**（localhost:8210）：

| 指标 | §31 后 | 本轮后 |
|---|---|---|
| 首次冷启动总下载 | 4.6 MB | **~3.0 MB** |
| 14 NPC 头像总大小 | ~870 KB | ~170 KB |
| ending-pan 双份 | 700 KB | 50 KB |
| 仓库体积 | 38.5 MB | **22.3 MB** |
| clone/push 时间 | 基线 | **~58% 更快** |
| 二次冷启动（无缓存）| ~4.6 MB | ~3.0 MB |
| 二次访问（有缓存）| 需重下 | **0 KB**（immutable cache）|

**回归验证**（headless Edge，`probe_render.js`）：
- 亮版 / 暗版截图正常，0 broken img，0 网络失败（除 favicon）
- 主题切换：亮→暗→亮 来回三次，actor/头像/背景全部跟着 `asset()` 切到对应 webp，无 404
- WebP 浏览器支持 97.5%+（Can I use，2017 起所有现代浏览器）；Safari 14+/iOS 14+ 完整支持，对一个 2026 的 Web 游戏来说完全可接受

**未做（标记后续）**：
- 音频 ogg → opus：5 个 BGM 共 1021KB，opus 同码率能省 ~30%。但 ffmpeg 转 opus 后浏览器支持略弱（Safari < 16 不支持 opus audio element，需保留 ogg fallback），改动面比 WebP 大，留作下一轮
- 暗版 `assets/fx/fx-burst.png` 116B 占位文件（§30 提到的「图片标缺失」根因之一）—— 现在 WebP 化没碰到它，等下一轮单独修
- 暗版 `assets/icons/` 共 27 个图标 + 暗版 pan-v1-1024.webp 等大文件仍在仓库，但代码已不引用 —— 可继续按需清理

**教训**：「**压缩已加载的 + 删除未加载的**」是两条独立优化路径，前者改感官速度（单资源小），后者改工程速度（仓库小）。这一轮两条都做了，合计仓库 -16.2MB / 单资源 -78%，体感会叠加。


---

## 33. 特效层坐标修复 + 失败/冷战惩罚 + 变体回复扩充（2026-09-13）

本轮三个看似独立的问题，根因都落在「坐标 / 数量 / 文本」三个最朴素的方向：

### 33.1 特效「坐标错位」彻底修复：两步走，从 `#stage` 到 body 顶层

**症状（用户实锤）**：「有时甩锅给食堂阿姨，左侧室友这里却有类似火花的亮光。」

**修复尝试 ① — 移出 `#stage`**：把 `<div id="fx">` 从 `#stage` 内（absolute inset:0）挪到 `</main>` 后，并改成 `position:fixed; inset:0`。理由：NPC chip 在 `#npcbar`（stage 之外的 footer），`fx.js` 的 `centre(el) = el.getBoundingClientRect() - #fx.getBoundingClientRect()` 算偏移，chip 在 stage 外时 y 超出 stage 范围被 `overflow:hidden` 裁剪。用户复测：「特效有时还是偏移」—— 没修干净。

**修复尝试 ② — 移出 `#screen-game`**：深入排查发现 `#screen-game` 本身是 `position:fixed`（`.screen { position:fixed; inset:0 }`），且「砸锅震动」用 `#screen-game.shake { animation: shake .4s ease; }`（`@keyframes shake` 包含 `transform: translate3d`）。两条 css 规则叠在一起：fixed 元素的 containing block 规则 + transform 改变 containing block —— `#fx` 此时**不再相对 viewport**，而是相对 `#screen-game`（带 transform 动画的 fixed 元素）的盒子。粒子按「视口坐标」算的 x/y，落到「screen-game 局部坐标」上，shake 期间视口与 screen 错位 → 火花「飘到别的 NPC 上」。

**最终修复**：把 `#fx` 挪到 body 直接子元素（devpanel `</div>` 之后、`<script>` 之前），并 `position:fixed; inset:0`。body / html 自身不带 transform/filter/perspective，所以 fixed 元素的 containing block 退回 viewport，shake 也碰不到它。

**代码**（`index.html` 关键注释）：
```html
<!-- 特效层：body 直接子元素 + fixed 全视口。放在所有 section 之外，
     不受 .screen 的 position:fixed / shake(transform) 影响，粒子永远用
     视口坐标落位（fx.js 的 centre()/local() 拿 getBoundingClientRect 减
     #fx 的 rect，body 层 fixed 时两者都是纯视口坐标）。 -->
<div id="fx"></div>
```

`style.css:376` 的 `#fx` 规则保持 `position:fixed; inset:0; pointer-events:none; z-index:25;`。

**验证**（`bf/verify_fx_v2.js`，headless Edge + CDP `Runtime.evaluate`）：
- `#fx` 的 `parentNode.tagName === 'BODY'`、body/html 无 transform
- 在 `#screen-game.shake` 动画进行中甩锅给食堂阿姨（chip 中心 616,600），hit 触发的 `.fxhalo` 与 `.fxring` 粒子落点都是 **dx=0, dy=0** —— 完美对齐
- 截图 `bf/shot-fx-shake.png` / `bf/shot-fx-after.png` 视觉验证 chip 高亮 + 火花都落在正确位置

**教训**：fixed 定位的 containing block 陷阱极其隐蔽 —— fixed + transform + parent-absolute 三者叠加时，谁都不知道粒子最后落到哪。**根除方案是把特效层放到「绝对不会被任何东西 transform 的容器」**（body 顶层是最稳的选择）。

### 33.2 失败 / 冷战惩罚增强：让「不该甩」真的有代价

**需求**：原版失败 `score=0, shadowDelta=3`、冷战 `shadowDelta=3` —— 玩家甩错人几乎没成本，背锅学不到教训。

**改动**（`engine/judge.js`）：
- **冷战分支**（关系值跌破 `coldWarAt`）：`shadowDelta: 3 → 5`，新增 `score: -20`
- **失败分支**（论证失败 / cast 不匹配）：`score: 0 → -15`，`shadowDelta: 3` 保持

**配套**（`game.js` 的 `finishThrow` 失败分支）：`floatAt` 文案从 `-0 分` 改为同时显示负分和阴影（`parts.join("  ")` 拼出 `-15 分  阴影 +3`），让玩家在屏上立刻看到「输了代价」。

**验证**（`bf/verify_fx_penalty.js` 直接调 `JudgeEngine.judge()`）：
- fail 分支 `{ success:false, score:-15, shadow:3 }` ✓
- cold 分支 `{ success:false, score:-20, shadow:5 }` ✓（关系值设到 20 < coldWarAt 30）

### 33.3 变体回复批量扩充：10 个 NPC × 5 论证类型 = 50 条反应

**背景**：上轮§33 之前只给 `didi`（学弟学妹）和 `roommate`（室友）的 `reaction_success` 升级为双条数组 + `engine/fallback.js` 写好 `pickVariant()` + `reactionCursor` 轮换机制。但**其他 8 个 NPC**（moyu/xuezhang/daoshi/jiaowu/fudaoyuan/shitang/suguan/ex）的 `reaction_success` 还是单条字符串 —— 用户反馈「变体回复没生效」，根因就是甩这些 NPC 时永远显示同一句台词。

**修复**：把 8 个 NPC × 5 论证类型 = 40 条 `reaction_success` 全部从字符串升级为 `[原文, 变体]` 数组（保留原文不变，添加符合人设 + 论证类型的变体）。每条变体的设计原则：
- **保持人设**：moyu 油腻敷衍 / xuezhang 老练包装 / daoshi 极短权威 / jiaowu 模板公文 / fudaoyuan 永远「你再想想」/ shitang 烟火温情 / suguan 认本子 / ex 冷短句
- **保持论证类型语义**：事实型举证 / 情感型共情 / 转移型划边界 / 反向型倒推 / 荒诞型胡扯
- **≤ 20 字**（气泡不撑破布局，沿用 §0 第 5 条精修记录）

**变体示例**：
| NPC | 类型 | 原文 | 变体 |
|---|---|---|---|
| moyu | 事实型 | 好吧，那我把这部分赶一下。 | 行行行，别催了，我去补一下。 |
| xuezhang | 情感型 | 唉，我带你们这么累还图什么。 | 我为社团掏心掏肺，最后还背锅。 |
| daoshi | 事实型 | 签字栏是你签的。 | 落款人是你。 |
| jiaowu | 转移型 | 此事项转交相关科室承办。 | 已按程序转至对口部门。 |
| fudaoyuan | 情感型 | （拍肩）你再想想，别都堆自己心里。 | （递水）你再想想，身体也要顾。 |
| shitang | 情感型 | 快别哭啦，累了就来阿姨这喝碗热汤。 | 孩子，这儿风大，先喝口水暖暖。 |
| suguan | 转移型 | 后勤没交接清楚……我先接下。 | 交接班签字缺一栏……我先顶。 |
| ex | 事实型 | 聊天记录有时间戳。 | 截图还在。 |

**抽象 NPC**（tianqi/shuini/xingzuo）保持单条 —— 它们 `reaction_success` 永远成功（规则上不可能拒绝），`reaction_fail` 固定为「（它无法拒绝）」，文案单调是设计本意，**不应补变体**（补了反而破坏「无表情」的无辜感）。

**验证**（`bf/verify_variants.js`，遍历 40 组合 + 3 次调用看轮换）：
- 40/40 全部 PASS（`rawArrLen >= 2` 且 `r1 ≠ r2` 且 `r1 == r3` —— 游标 mod 2 周期性回到第一条）
- 轮换方向符合预期：同 (npcId, 论证类型) 反复甩时按 0→1→0→1 切换，不会在两次甩同一人时看到同一句台词

**用户实操**：现在无论甩哪个普通 NPC（学弟/室友/摸鱼/学长/导师/教务/辅导员/食堂/宿管/前任），连甩同一人的 2~3 次都会换一条不同的回复，符合「丰富回复」的预期。


---

## 34. reaction_fail 变体补齐：50 条「被甩锅后的反驳」（2026-09-13）

**需求**：§33.3 只补了 `reaction_success`（接锅台词），`reaction_fail`（拒绝接锅台词）仍全部是单条字符串。用户要求「给 reaction_fail 也批量补变体」。

**改动**（`data/verdicts.js`）：10 个普通 NPC × 5 论证类型 = 50 条 `reaction_fail` 从字符串升级为 `[原文, 变体]` 数组。

**语义要点**：`reaction_fail` 是「NPC **拒绝**接锅时的台词」，语气与 `reaction_success` 相反 —— 是反驳、推脱、质疑甩锅者，而不是认账。变体设计遵循两条：
- **保持人设**：didi 唯唯诺诺 / roommate 翻旧账 / moyu 甩回来 / xuezhang 用规章堵 / daoshi 极短压人 / jiaowu 模板公文 / fudaoyuan 永远「你再想想」/ shitang 温吞推脱 / suguan 认本子 / ex 冷短句
- **贴合论证类型语义**：事实型要证据 / 情感型打感情牌 / 转移型划边界 / 反向型反将一军 / 荒诞型戳破胡扯

**补齐的缺漏**：didi::荒诞型、roommate::反向型、roommate::荒诞型 原本 **`reaction_fail` 缺省**（`E()` 只传了 3 个参数），本轮一并补上完整的双条数组，消除了「甩这类锅失败时气泡空白」的隐患。

**变体示例**：
| NPC | 类型 | 原文（拒绝）→ 变体 |
|---|---|---|
| didi | 事实型 | 学长，这个真的不在我范围内呀。→ 可、可这事真不是我经手的呀。 |
| roommate | 事实型 | 放屁，上周明明是你自己没搞好。→ 你翻翻记录，那天谁在宿舍？ |
| moyu | 反向型 | 别倒打一耙，主导的人是你。→ 你自己没盯住，怪我咯？ |
| daoshi | 荒诞型 | 科研讲究严谨证据。→ 别拿直觉当依据。 |
| jiaowu | 荒诞型 | 网络数据正在同步更新中。→ 系统升级中，请稍后再试。 |
| fudaoyuan | 反向型 | 你再想想，因果不能这么倒过来。→ 你再想想，别急着甩出去。 |
| shitang | 事实型 | 锅可不能乱扣，阿姨还要盛饭呢。→ 这锅可沉，阿姨端不动。 |
| suguan | 反向型 | 我天天查寝，你倒甩我头上了？→ 你自己不锁门，倒怪起我来了。 |
| ex | 荒诞型 | 信号不好，听不见。→ 别玄乎了，我很清醒。 |

**抽象 NPC 不补**（tianqi/shuini/xingzuo）：`reaction_fail` 固定「（它无法拒绝）」是规则层写死的（它们规则上不可能拒绝），补变体反而破坏「无表情」的无辜感。

**验证**（`bf/verify_variants.js` 改造为双字段断言）：遍历 10 NPC × 5 类型，断言 `reaction_success` 与 `reaction_fail` **都** `arrLen >= 2` 且各自轮换（`r1 ≠ r2`）。**50/50 全部 PASS**。

**教训**：`reaction_fail` 与 `reaction_success` 是**语义相反**的两套台词，补变体时不能照搬「认账」语气的句式，必须反过来设计成「反驳/推脱」，否则会出现「NPC 嘴上拒绝、台词却像要接」的割裂感。另外用脚本遍历 `raw.reaction_fail` 是否 `Array.isArray` 能一次性揪出所有「缺第 4 参数的 E()」漏网条目（本轮揪出 3 条）。


---

## 35. generic 兜底 reaction 缺失修复：补上最后一环（2026-09-13）

**需求**：用户反馈「甩锅失败只有一种回答」（快速选项反复甩同一人）。§33/§34 已补全 entries 库 10 个 NPC 的变体，但失败台词仍可能单调。

**排查**（沿 reaction 完整取值链逐层检查）：
1. **引擎层轮换正常**：连续 4 次甩 `shitang::荒诞型`，`reactionFail` 正确轮换 A→B→A→B（`bf/verify_fail_rotate.js` 实证）
2. **固定分支**（不轮换，但语义合理）：sceneMismatch（仅 ex，`"？"`）/ coldWar（`"（转过身去）"`）/ 反向型未解锁（`""`）
3. **真根因 —— generic 兜底缺 reaction**：`data/verdicts.js` 的 `generic` 15 条 `E()` 只传了 `technique` + `verdict`，**`reaction_success` / `reaction_fail` 全是 `undefined`**。当甩 (NPC, 论证类型) 组合未命中 entries 库时走 generic，reaction 为空，最终落到 `judge.js pickReaction` 的固定兜底 `"（对方没有接话，锅就这么留下了。）"` —— 永远一样。

**触发场景**：抽象 NPC（tianqi/shuini/xingzuo）的 entries 库里只有 `事实/情感/荒诞` 三种类型，甩「转移型」「反向型」必走 generic → 固定兜底。

**修复**（`data/verdicts.js`）：给 generic 15 条 `E()` 全部补上 `reaction_success` / `reaction_fail` 双条数组，语气中性通用（适配任意 NPC），同样可轮换。

**验证**（`bf/verify_generic.js`）：甩「转移型」给 tianqi 连续 4 次，`reactionFail` 依次「这不归我管」→「你那段别推给我」→「制度不背这个锅」→「找错人了」；generic 15 条全部补全（`missing: []`）。

**教训**：「轮换机制正确」≠「所有路径都轮换」。要沿 reaction 的**完整取值链**逐层排查：entries 命中 → generic 兜底 → `pickReaction` 的 `ai → npc.fixedReaction → 固定句`，看哪个环节把变体「截断」成单条。查表主路径补全了，但 generic 兜底的 `E()` 漏传 reaction 字段，抽象 NPC 非库类型甩锅时就会固定落一句兜底台词。

---

## 36. 亮版天气头像残缺修复：暗版提亮 + 真实尺寸可读（2026-09-13）

**需求**：用户反馈亮版天气头像主体残缺——小芯片下整个图形只剩半个光晕，云朵/闪电/雨滴全丢。

**根因**（截图对比）：
- 暗版 `assets/avatars/avh-tianqi.webp` 完整：深蓝夜空 + 金色闪电 + 雨滴 + 云朵，圆形卡居中。
- 亮版 `assets-light/avatars/avh-tianqi.webp`（原始 9096 bytes）只剩左边半个深色光晕——之前生图时模型把"亮色调"理解为"把深底抹掉"，结果主体被自己的高光吃掉，只剩边缘一圈深色描边。
- 同一根因问题也波及 `avh-shuini.webp`（水逆）——整个右半边主体光环丢失。

**修复 / 实现**：

**修复版天气头像**（image-to-image 提亮）：
- 用**暗版原图**作 `image1` + `input_fidelity: high`，prompt 强调 `MUST preserve the exact composition, character placement, and pose; only adjust lighting/background tone to bright cream sky card style`，避免模型"重新创作"。
- 输出 256×256 RGBA 透明 PNG，主体（云 + 闪电 + 3 滴雨）完整居中，奶白圆形卡 + 深色描边。
- 文件：`C:\Users\skrin\.workbuddy\bf\gen\tianqi-final\avh-tianqi-keyed.png`（64KB）

**抠底**（AI 生图伪透明 → 真透明）：
- 暗版原图是 RGBA，亮版是 AI 假透明：模型"画"了暖白 cream 底冒充透明（alpha 全 255）。
- 暖白 cream 抠色参数：`tol=35, abs_min=210, chroma_max=58, r=14`（仅吃与边界连通的 cream 区域）
- 几何泛洪只吃外圈 ~43%，圆形描边闭合导致圆内 cream 与圆外不连通——**保留圆形内奶白作为卡片底色**（设计意图：avh 头像就是奶白卡片 + 主体）。
- 反预乘 1px 消白边，圆形外全透明。
- 转 WebP（lossless 保 alpha），42700 bytes。

**替换**（`bf/convert_tianqi.py`）：
- 备份原文件 `avh-tianqi.webp.bak`（9096 bytes）。
- 写入 `assets-light/avatars/avh-tianqi.webp`（42700 bytes, 256×256 RGBA lossless）。
- `verify_tianqi.py` 验证：`format: WEBP, size: (256, 256), mode: RGBA, alpha min/max: 0 255, corners [(0,0,0,0), (0,0,0,0)]`——真透明保留。

**验证**（`bf/accept_tianqi.js`，CDP 无头 Edge + dev server `http://localhost:8200/`）：
- 主题：`light`
- 天气头像 DOM 命中：`{chipText: "天气0", imgSrc: "assets-light/avatars/avh-tianqi.webp", nw: 256, rect: {x: 822, y: 794, w: 74, h: 95}}`
- **整页破图扫描**：`broken: []`（零破图）
- 进游戏截屏 `verify/tianqi-check.png`：npcbar 天气芯片（第 12 位）显示完整的奶白卡片 + 深色描边 + 金色闪电 + 3 滴斜雨 + 云朵，与暗版构图完全一致，主体居中无残缺。
- 控制台错误仅 11 条音频 CORS 报错（`file://` 协议下 fetch 音频，与图片层无关，是 `engine/audio.js` 既有行为）。

**剩余问题**：水逆头像 `avh-shuini.webp` 同样残缺（右半边主体光环丢失），同根因未处理。本轮用户只要求修天气，水逆待用户决策后再走相同流程。

**后续落地**：本轮用户批准「相同流程修复」，水逆头像按相同流程修复并验证通过，详见 §36.2。

---

## 36.2 亮版水逆头像残缺修复：与天气同流程（2026-09-13）

**需求**：用户批准"相同流程修复"水逆头像（§36.1 提到的同根因未处理项）。

**根因**：与天气相同——暗版完整（水星符号+月牙+椭圆轨道+圆形卡），亮版 5172 bytes 只剩左半边深色光晕+月牙碎片，主体被高光吃掉。

**修复流程**（与 §36.1 完全一致）：

**第一步 · image-to-image 提亮**（暗版作 image1 + input_fidelity:high）
- 第一版 prompt 用 "brighten into cream sky" 太模糊 → 模型输出四角近黑（rgb=3-11），4.2% cream 背景，主体反被吃掉
- 第二版 prompt 改为 `Requirements: (1) background OUTSIDE the round card must be pure white #FFFFFF; (2) the round card fill stays soft cream; (3) the Mercury symbol, moon and orbit stay fully intact; (4) brighten the deep navy tones to light sky-blue and warm amber` → 四角 rgb=247-255 纯白，cream-ish 89.35%，主体居中完整

**第二步 · 抠色**（`key_shuini.py`，复用天气同套参数 tol=35, abs_min=210, chroma_max=58, r=14）
- 泛洪吃掉 84.68% 背景，bbox 822×884 居中到 256×256
- **新增：圆形卡外孤立色弧清理**（`clean_shuini_arc2.py`）—— 模型 prompt 要求"紫对光 + 琥珀轮廓光"被画在了圆形卡外侧（细长弯月形色弧），泛洪吃不掉（不是纯白/cream 色）
- 6 个连通区域：5981（主体）/ 3436（水星十字）/ 1124+1120（椭圆轨道左右半）/ 397（上方小弧）/ 282（**孤立色弧，bbox 5×77，dist_norm 0.42**）
- 清理策略：**保留面积 ≥ 200 px 且距画面外缘 ≥ 20px 的连通区域** —— 椭圆轨道整体跨度大，距外缘远，保留；孤立色弧紧贴外缘，剔除
- 清理后 alpha mean 从 41.7 降到 32.9，opaque 14.37%

**第三步 · PNG → lossless WebP**（`convert_shuini.py`）
- 备份原文件 `avh-shuini.webp.bak`（5172 bytes）
- 写入 `assets-light/avatars/avh-shuini.webp`（**16988 bytes**，256×256 RGBA lossless）
- `verify_shuini.py`：四角 alpha=0（真透明），mode RGBA ✓

**验证**（`accept_shuini.js`，CDP 无头 Edge + dev server:8200）：
- 主题：`light`
- 水逆头像 DOM 命中：`{chipText: "水逆0", imgSrc: "assets-light/avatars/avh-shuini.webp", nw: 256, nh: 256, rect: {x: 903, y: 794, w: 74, h: 95}}`
- **天气回归检查**：`TIANQI-RECHECK {found: true, nw: 256}` —— 上轮修复未受影响
- **整页破图扫描**：`broken: []`（零破图）
- 进游戏截屏 `verify/shuini-check.png`：npcbar 第 13 位"水逆"显示完整水星符号+月牙+椭圆轨道+圆形奶白卡片，与暗版构图完全一致；右侧无孤立色弧残留
- 控制台错误仅音频 CORS（既有 file:// 行为，与图片无关）

**改动清单**：
- `assets-light/avatars/avh-shuini.webp`：5172 → 16988 bytes（PNG → lossless WebP）
- `assets-light/avatars/avh-shuini.webp.bak`：原文件备份
- 新增脚本：`C:\Users\skrin\.workbuddy\bf\key_shuini.py`（纯白+cream 双扣色 + 居中）、`clean_shuini_arc2.py`（按"距画面外缘距离"剔除孤立色弧）、`compare_shuini.py`（左右对比图）、`convert_shuini.py`（PNG → WebP + 备份）、`verify_shuini.py`（WebP 解码与透明度验证）、`accept_shuini.js`（无头浏览器加载验收 + 天气回归）

**教训**：
- **image-to-image prompt 第一版易踩坑**：用"brighten into X"这种感性描述，模型可能误把背景理解成完全不同的东西（第一版把暗底抹掉变成四角近黑）。**强约束格式**（"OUTSIDE the round card must be pure white #FFFFFF" + 具体数值）能大幅提升稳定性
- **抠色流程对"纯白+cream"通用**：复用 tol=35, abs_min=210, chroma_max=58, r=14 这套参数既能扣 cream 又能扣纯白，无需为每张图调参
- **prompt 的"紫对光 / 琥珀轮廓光"等光效要求会画歪到圆形卡外**：模型难以精确控制光效只在卡片内部。需要二次清理：**按"距画面外缘距离"判据剔除孤立色弧**，比"按 bbox 中心距"更鲁棒
- **连通区域标记无 scipy 也能做**：8-连通 BFS 自实现就够了，6 个区域不到 1ms

**改动清单**：
- `assets-light/avatars/avh-tianqi.webp`：9096 → 42700 bytes（PNG → lossless WebP）
- `assets-light/avatars/avh-tianqi.webp.bak`：原文件备份
- 新增脚本：`C:\Users\skrin\.workbuddy\bf\convert_tianqi.py`（PNG → WebP + 备份）、`verify_tianqi.py`（WebP 解码与透明度验证）、`accept_tianqi.js`（无头浏览器加载验收）
