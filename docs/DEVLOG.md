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
