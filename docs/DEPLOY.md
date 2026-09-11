# 部署指南

> 目标：把《锅从天降》部署成一个**活的**演示链接 —— 评委点开就能玩，
> 自由输入走真 AI 判定，能当场打字给他们看。

---

## 0. 先说结论：走哪条路

| 路径 | 可行性 | 说明 |
|---|---|---|
| **GitHub 公开仓库 + Vercel Git 集成** | ✅ **推荐** | 开发机有 git 2.55，不需要装任何东西；顺便满足黑客松「公开仓库含 README」的交付要求 |
| Vercel CLI（`vercel deploy`） | ❌ | 开发机**没有 Node/npm/npx**，CLI 跑不了 |
| Vercel 拖拽上传 | ⚠️ 不推荐 | 拖拽部署对 `api/` 目录的 serverless 函数支持不稳定，且环境变量配完要重新部署一次 |
| Gitee 作为部署源 | ❌ | Vercel 只支持 GitHub / GitLab / Bitbucket。若必须交 Gitee，请把它当**镜像**，部署源仍用 GitHub |

**一石二鸟**：GitHub 公开仓库既是部署源，也是提交材料里要求的那个公开仓库。

---

## 1. 六步部署

### ① 初始化仓库

在 `blamefall/` 目录里（它就是仓库根，不要在上层目录 init）：

```powershell
cd blamefall
git init -b main
git add -A
```

**提交前必须扫一遍密钥**（公开仓库的硬性要求）：

```powershell
git diff --cached | Select-String -Pattern 'sk-[A-Za-z0-9]{8,}','Bearer\s+[A-Za-z0-9]','api[_-]?key\s*[:=]'
```

三条正则的期望不一样，别一律当「必须为空」：

| 正则 | 期望 | 命中了怎么办 |
|---|---|---|
| `sk-[A-Za-z0-9]{8,}` | **0 条** | 真密钥形状。立刻移出暂存区并轮换密钥 |
| `Bearer\s+[A-Za-z0-9]` | **0 条** | 同上 |
| `api[_-]?key\s*[:=]` | 若干条 | **逐条看等号右边**：空值 / `'sk-...'` / `<网关密钥>` 这类占位符才放行；出现任何长随机串就是泄露 |

实测本仓库第三条命中 7 处，全部是 `.env.example` 的空值、README/DEPLOY 的占位示例、
以及 `$ApiKey = $env:BLAMEFALL_API_KEY` 这种「从环境变量读」的写法；前两条正则 0 命中。

`.gitignore` 已经拦了 `.env` / `.env.*` / `*.pem` / `*.key`，
但那条 `.env.*` 规则会连模板一起吃掉，所以里面专门开了 `!.env.example` 例外。

```powershell
git commit -m "锅从天降：60 秒校园甩锅游戏"
```

### ② 推到 GitHub

先在 GitHub 网页上建一个 **Public** 空仓库（不要勾选自动生成的 README/.gitignore，
本地已经有了，勾了会制造一次无谓的合并），然后：

```powershell
git remote add origin https://github.com/<你的用户名>/blamefall.git
git push -u origin main
```

### ③ Vercel 导入

[vercel.com/new](https://vercel.com/new) → 授权 GitHub → 选中 `blamefall` 仓库。

### ④ 构建设置（**关键，全部留空**）

| 项 | 值 |
|---|---|
| Framework Preset | **Other** |
| Root Directory | 留空（仓库根就是项目根） |
| Build Command | **留空**（覆盖掉默认值） |
| Output Directory | **留空** |
| Install Command | **留空** |
| Node.js Version | **20.x**（与 `api/*.mjs` 里 `runtime: "nodejs20.x"` 对应） |

本项目没有 `package.json`、没有构建步骤、没有依赖。
任何一处填了东西都可能让 Vercel 去跑一个不存在的 `npm install` 然后失败。

### ⑤ 环境变量

Project → Settings → Environment Variables，按 [`.env.example`](../.env.example) 逐项填。
最少只要两项：

```
BLAMEFALL_API_BASE = https://<你的网关>/v1      ← 到 /v1 为止，不要带 /chat/completions
BLAMEFALL_API_KEY  = <网关密钥>
```

三个环境（Production / Preview / Development）都勾上。

> ⚠️ **密钥只存在 Vercel 的环境变量面板里**，绝不写进任何提交的文件。
> `.env.example` 里 `BLAMEFALL_API_KEY=` 后面是空的，这是刻意的 ——
> 连 `sk-xxx` 这种占位符都不要写，免得污染密钥扫描结果。

### ⑥ Deploy，然后**必须验证**

部署成功 ≠ AI 通了。见下一节。

---

## 2. 部署后验证（这一步不能省）

在线链路有个极其讨厌的性质：**它坏了也完全看不出来**。

`/api/judge` 返回 500 / 502 / 503 / 超时，客户端 `engine/api.js` 一律
`resolve(null)` 然后静默切本地兜底引擎，玩家侧画面完全正常，只是文案换了一套。
你站在评委面前演示，AI 根本没通，而你不会发现。

所以按顺序跑这三条：

### ① 健康检查

```powershell
Invoke-RestMethod 'https://<你的域名>/api/health?probe=3&budget=1350' | ConvertTo-Json -Depth 6
```

看四个字段：

```
ok                                  必须是 true
prompt.loaded                       必须是 true（false = includeFiles 没生效）
gateway.configured                  必须是 true（false = 环境变量没配上）
probe.latencyMs.median              与 budget 比，决定要不要调前端超时
probe.errorCodes                    非空就是上游出问题了，见故障对照表
```

`?probe=3` 会真调三次网关，给出 min / median / max。
单次数字没有意义 —— 「预算够不够」的答案是一个分布，不是一个点。

### ② 冒烟测试（29 条断言）

同一套断言对本地和生产都能跑：

```powershell
cd blamefall/scripts
.\smoke-test.ps1 -BaseUrl https://<你的域名>
```

期望 `全部通过：29/29`，退出码 0。
它覆盖静态资源编码、路径穿越防护、health/judge 端点、
以及**复现 `engine/api.js` 的 validate() 全字段契约**。

> 生产环境下 `4.2.9 中文编码链路完好` 这条会跳过 —— 它依赖 dev-server 的
> mock 公式（`S = 55 + min(35, reason.Length)`），真模型的 S 值不由此决定。

### ③ 人肉验证

打开演示链接 → 标题页应当显示 **「在线裁判 · https://...」**（不是「离线模式」）→
开始游戏 → 抓锅 → 点 NPC → 选「自己写」→ 打一句理由 →
按 <kbd>`</kbd> 打开开发者面板，应当看到：

```
AI 裁判返回 S=xx · <手法名>
```

如果看到 `兜底引擎 · 判为xx型 · S=xx [...]`，说明 AI 没通，回到 ① 查原因。

---

## 3. 故障对照表

| 症状 | health 里的信号 | 原因 | 处置 |
|---|---|---|---|
| 标题页显示「离线模式」 | — | 页面不是通过 http(s) 打开的 | `autoSameOrigin()` 只在 http(s) 下生效；`file://` 双击永远是离线模式，这是设计 |
| 面板显示「兜底引擎」 | `gateway.configured: false` | 环境变量没配上 / 没重新部署 | 检查 Settings → Environment Variables，改完**必须重新部署** |
| 同上 | `prompt.loaded: false` | `vercel.json` 的 `includeFiles` 没生效 | 确认 `vercel.json` 在仓库根，且 `prompts/judge-v3.txt` 已提交 |
| 同上 | `probe.errorCodes: ["http_402"]` | 网关余额不足 | 充值或换网关。本项目在 `aiping` 网关上实测吃过 402 |
| 同上 | `probe.errorCodes: ["http_401"]` | 密钥错 / `base_url` 少了或多了一段 | `BLAMEFALL_API_BASE` 要到 `/v1` 为止，代码会自己拼 `/chat/completions` |
| 同上 | `probe.errorCodes: ["empty_content"]` | 用了**思考型模型** | 换 `gemini-2.5-flash`。`step-3.7-flash` 实测烧 4409 completion_tokens 却只回吐思维链、正文为空 |
| 同上 | `probe.errorCodes: ["timeout"]` | 上游超过 6s | 调大 `BLAMEFALL_UPSTREAM_TIMEOUT`，同时检查 `maxDuration` 是否还够 |
| 同上，但 health 全绿 | `latencyMs.median > 1350` | 网关比预算慢 | 见下一节调预算 |
| 部署直接失败 | — | `maxDuration` 超出计划上限 | Hobby 计划下调 `api/health.mjs` 的 `maxDuration`，并同步改 `vercel.json` |

---

## 4. 如果网关比预算慢：怎么调

前端的时间关系是**硬约束**，改之前先理解它：

```
game.js 自由输入： Promise.all([ AI判定, delay(flightMs) ])
总时长           = max(AI判定耗时, flightMs)
```

飞行动画本来就要播满 `flightMs`，所以判定在这之前的**任何**时刻回来
都是**零感知成本**的。这就是为什么 `timeout` 应该紧贴 `flightMs`，
而不是越小越好 —— 早期版本设 800ms，白白扔掉了 700ms 的免费窗口，
AI 只慢一点点就被丢弃、退化成兜底文案，而玩家根本感觉不到那 700ms。

调整规则（三个数必须一起改，在 `engine/api.js` 的 `CFG` 里）：

```
timeout  <  flightMs          ← 硬约束。反了的话锅飞到 NPC 头上还要干等，肉眼可见的卡顿
timeout ≈  flightMs - 150     ← 留余量给 Promise.all 调度与 finishThrow 的 DOM 渲染
flightMs ≥  p50 延迟 + 200    ← 让典型情况落在动画窗口内
```

例如 health 报 `median = 2100`：

```js
var CFG = { apiBase: "", timeout: 2650, flightMs: 2800 };
```

代价是自由输入的反馈变慢 1.3 秒。60 秒一局里这很明显，
所以**优先换更快的模型或网关**，调预算是最后手段。

> 锅起飞后 `S.held = null`，所以等待期间不占 12 秒握持预算，
> 但 `S.busy = true` 会让玩家无法操作 —— 这才是真正的代价。

---

## 5. 本地验证（不需要部署，也不需要密钥）

开发机上没有 Node，所以 `vercel dev` 跑不了；而 `file://` 双击打开的页面
永远是离线模式。结果是「在线裁判」这条链路在本地根本没法验证 ——
而它恰恰是演示时要给评委看的部分。

[`scripts/dev-server.ps1`](../scripts/dev-server.ps1) 用 `TcpListener` 手写 HTTP
解决这件事（不用 `HttpListener` 是因为它走 HTTP.sys，非管理员绑定端口
通常需要 `netsh http add urlacl` 授权）：

```powershell
cd blamefall/scripts

# 终端 A：起服务器（MOCK 模式，不需要任何密钥）
.\dev-server.ps1

# 终端 B：跑冒烟测试
.\smoke-test.ps1
```

浏览器打开 `http://127.0.0.1:8200/`，标题页会显示「在线裁判」，
自由输入会拿到 mock 判定（`technique_name` 形如「本地模拟判定3」，
带递增序号，这样一眼就能区分「mock 在应答」和「兜底引擎碰巧返回了同样文案」）。

### 两种模式

| 模式 | 触发条件 | 用途 |
|---|---|---|
| **MOCK** | 默认 | 不需要密钥，验证客户端整条链路（fetch → validate → finishThrow） |
| **PROXY** | 设了 `BLAMEFALL_API_BASE` + `BLAMEFALL_API_KEY` | 真转发到网关，部署前就能端到端测真模型并掐表实测延迟 |

```powershell
# PROXY 模式
$env:BLAMEFALL_API_BASE = 'https://<你的网关>/v1'
$env:BLAMEFALL_API_KEY  = '<密钥>'
.\dev-server.ps1

# 验证超时降级：mock 延迟 1500ms > timeout 1350ms，应当看到面板打印「兜底引擎」
.\dev-server.ps1 -MockLatencyMs 1500
```

> ⚠️ `dev-server.ps1` 没有任何鉴权，**只用于本地开发**，绝不要暴露到公网。
> 端口默认 8200 —— 最初的 8123 在本机正好落在系统 TCP 端口排除表里
> （`netsh int ipv4 show excludedportrange protocol=tcp`），绑定报 WSAEACCES。

---

## 6. 安全清单（公开仓库 + 公网端点）

- [ ] 仓库里没有任何密钥：`git log -p | Select-String 'sk-[A-Za-z0-9]{8,}'` 输出为空
- [ ] `.env` / `.env.local` 在 `.gitignore` 里，且**从未被提交过**（`git log --all -- .env` 为空）
- [ ] `BLAMEFALL_API_KEY` 只存在部署平台的环境变量面板里
- [ ] `/api/health` 不返回任何配置值，只返回「配没配」的布尔
- [ ] `/api/judge` 的错误响应不含上游原文（网关地址、请求头碎片一律只进服务端日志）
- [ ] 路径穿越被挡：`smoke-test.ps1` 的 `..%2f` 断言返回 403
- [ ] （可选）配 `BLAMEFALL_ALLOW_ORIGIN` 挡住扫端点的脚本

> ⚠️ `BLAMEFALL_ALLOW_ORIGIN` **不是安全边界**。Origin 头可以被非浏览器客户端伪造。
> 它挡住的只是无脑扫公开端点的那批脚本 —— 而那批脚本恰好是
> 「演示链接挂三天就被刷爆 token 余额」的主要来源。
> 真正的防线是网关侧的配额与告警。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| [`api/judge.mjs`](../api/judge.mjs) | 主裁判端点，刻意做薄 |
| [`api/health.mjs`](../api/health.mjs) | 健康检查 + 延迟实测 |
| [`api/_gateway.mjs`](../api/_gateway.mjs) | 共享层。两个端点走同一条上游路径，所以 health 报的延迟就是 judge 的真实延迟 |
| [`vercel.json`](../vercel.json) | `includeFiles` 把 `prompts/` 打进 lambda bundle |
| [`prompts/judge-v3.txt`](../prompts/judge-v3.txt) | system prompt 的**唯一权威副本**，服务端运行时读取 |
| [`.env.example`](../.env.example) | 环境变量模板（不含真值，必须提交） |
| [`scripts/dev-server.ps1`](../scripts/dev-server.ps1) | 本地开发服务器（MOCK / PROXY） |
| [`scripts/smoke-test.ps1`](../scripts/smoke-test.ps1) | 29 条断言，本地与生产通用 |
