# 关键取舍（Decision Records）

> 记录**已经定下来的技术决策与理由**，供后续维护者、评审者和宿主项目判断「哪些能改、改了会付出什么代价」。
> 这里只写取舍，不写接口细节——接口以 [`interfaces.md`](interfaces.md) 为准，需求以 [`SPEC.md`](SPEC.md) 为准。

编号规则：`D<n>`。状态：`已生效` / `已收窄`（评审后修改过）。

---

## D1 — 协议层用 Vercel AI SDK，不自研

**状态**：已生效
**落地**：`packages/mik/src/ai/protocols.ts`、`packages/mik/src/registry/presets.ts`（`PROTOCOL_PACKAGES`）
**依赖**：`ai@7` + `@ai-sdk/{openai,anthropic,google,deepseek,moonshotai,xai,openai-compatible}`（可选 peer）

**背景**：模型层要同时满足「多供应商、多协议、流式、工具调用、usage 归一」。自研意味着自己解析每个厂商的 SSE 帧、工具调用增量、错误码、重试与超时。

**决策**：协议实现全部交给 AI SDK，自研只保留四块——`ProviderRegistry` / `CredentialStore` / `UsageRecorder` / `UsageRepository`（`SPEC.md` §1）。

**理由**：

1. **协议差异是数据，不是分支**。项目硬性规则 3 要求「禁止 `if (providerId === "deepseek")`」。做法是「协议 → 包 → 工厂选项」三张查表（`presets.ts:10-18`、`ai/protocols.ts` 的 `SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS`），新增供应商 = 加一行预设，不动任何调用点。这条约束只有在协议实现被封装成可替换对象时才成立。
2. **usage 形状才是真难点**。本机实测（`verified-facts.md` §1）AI SDK 给出的 `inputTokens` 含缓存、`cacheWriteTokens` 可能缺失、`reasoningTokens` 已含在 `outputTokens` 内——这些映射规则每家厂商都不同，自研等于永久维护一张易碎的兼容表。
3. **工具循环 / 流式 / 重试**已由 SDK 提供（`generateText`、`streamText`、`stepCountIs`、`maxRetries`），自研这几百行只增加缺陷面。
4. **可测性**：`@ai-sdk/test-server`（msw）让全部协议路径离线可测，`test/` 里没有一条依赖真实网络的用例。

**代价**：

- 版本耦合：`ai@7` 的大版本升级可能带来破坏性变更。
- 依赖体积：每个协议一个包，但它们是**可选 peer**，只装用到的那个；缺包时 `loadProviderFactory()` 给出「装哪个包」的可读错误。
- 不覆盖的协议（如某些自建网关）走 `openai-compatible` 兜底，而不是写适配器。

**替代方案与否决理由**：自研协议层——7 个协议 × （认证 / SSE 解析 / 工具增量 / usage 形状 / 重试 / 超时）持续维护成本远高于封装成本，且与本项目「模型层而非网关」的定位冲突。

---

## D2 — 计价用 `llm-pricing`，不自研归一化

**状态**：已生效
**落地**：`packages/mik/src/pricing/service.ts`
**依赖**：`llm-pricing@0.17`（MIT）

**背景**：计价不是「乘一下单价」：模型名需要跨厂商归一（`deepseek-chat` vs `deepseek/deepseek-chat`），价格会随时间变（时间敏感价），还分长上下文档位与思考模式，目录源也会变。

**决策**：模型名归一化与成本计算全部交给 `llm-pricing`；本项目只负责「AI SDK usage → llm-pricing 入参」的映射（口径见 `SPEC.md` §4）与价格优先级编排。

**理由**：

1. **归一化是数据问题，不是算法问题**。模型名每周在变，自研等于把一张持续过期的别名表焊进代码。`llm-pricing` 的 `pricingCandidates()` 还让我们能把匹配候选展示给用户，而不是只给一个「查不到」。
2. **时间敏感计价**：`estimate({ model, at, usage })` 的 `at` 用**请求发起时刻**，长上下文分档与思考模式靠 `perRequest: true` + `RequestFacts` 生效（`priceFor(model, at, facts)` 返回里带 `contextTierAbove` / `reasoningMode`）。
3. **离线兜底**：目录拉取失败时退到内置 archive，仍能出价并把状态标 `stale`（e2e AC6 实测：目录不可达 → `status=stale`、`source=fallback`、`deepseek-chat` 仍报 $0.42/M）。自研要么没兜底，要么自己维护一份价格快照。
4. **映射正确性可验证**：`test/pricing.test.ts` 断言了完整映射与「缺失字段不得当作 0」两个方向；评审独立复核了「`cacheReadInputTokens` 优先、不会重复计费」。

**代价**：

- 价格口径受上游目录质量影响；缺失时金额为 0 且 `source: "missing"`（不静默假装算过）。
- 上游库的 API 变动需要跟进（已把 `catalog` / `fetch` 做成注入口，离线可测）。

**替代方案与否决理由**：自研归一化——需要自己维护 models.dev / OpenRouter 的价格快照与别名表，收益为零、维护成本持续。

---

## D3 — 金额一律用整数微美元累加

**状态**：已生效
**落地**：`packages/mik/src/store/money.ts`（`toMicroUsd` / `fromMicroUsd`）、`packages/mik/src/store/usage-repository.ts`、`packages/mik/src/store/schema.ts`（金额列 `INTEGER`）

**背景**：单次调用成本常在 $1e-4 ~ $1e-6 量级。SQLite 没有 DECIMAL，`REAL` 是 IEEE754 双精度。

**决策**：**落库与聚合全程整数微美元**；只在最后展示时转回美元。SQL 聚合统一写 `SUM(CAST(ROUND(cost * 1000000) AS INTEGER))`，禁止 `SUM(CAST(cost AS REAL))`（`AGENTS.md` 硬性规则 2）。

**理由**：

1. **误差会累积**：明细、按供应商/模型分组、按天趋势、rollup 四层聚合，任何一层用浮点求和，长时间运行后「明细加起来 ≠ 汇总」。
2. **可精确对账**：整数加法满足结合律，分页、增量、重建 rollup 的结果一致。
3. **rollup 表金额列是 `INTEGER`**，rollup 累加也是整数加法，保证「明细 → 汇总」不会因为精度变化而对不上。
4. **单笔计价允许浮点**：`llm-pricing` 返回的是浮点美元，这是**输入**，进入存储层立刻量化成微美元；误差只存在于单笔，不会跨行累积。

**代价**：

- 展示需要一次除法（`fromMicroUsd`），且四舍五入到微美元（$0.000001）——对个人/团队成本核算足够。
- 代码里要时刻区分「微美元整数」与「美元浮点」，类型上靠命名与 `money.ts` 的两个函数约束。

**替代方案与否决理由**：存浮点美元——简单，但违背「汇总必须可对账」的要求；存 `TEXT` 十进制——SQLite 聚合退化，性能与可读性都更差。

---

## D4 — 默认驱动用 `node:sqlite`，但驱动可换

**状态**：已生效
**落地**：`packages/mik/src/store/driver.ts`（`SqlDriver` / `nodeSqliteDriver`）、`packages/mik/src/store/database.ts`（`Store.open({ path, driver })`）

**背景**：用量存储需要一个嵌入式数据库。候选：`better-sqlite3`（成熟、需原生编译）、`node:sqlite`（Node 内置、实验特性）、`sql.js`（WASM，无文件锁）。

**决策**：默认 `node:sqlite`；持久层只依赖一个很窄的 `SqlDriver` 接口（`exec` / `prepare` / `close`），宿主可注入 `better-sqlite3` 或 `bun:sqlite`。

**理由**：

1. **零原生编译**。`better-sqlite3` 在 Windows 上要装构建工具链；`node:sqlite` 跟着 Node ≥ 22.13 一起来（22.13.0 起不再需要 `--experimental-sqlite`），`npm i model-infra-kit` 后立刻可用。
2. **依赖面最小**。唯一的核心依赖是 `ai` 与 `llm-pricing`；数据库不进 `dependencies`。
3. **接口窄，换得起**。`SqlStatement` 只需要 `run/get/all`，`better-sqlite3` 的形状天然兼容；换驱动不用改仓储代码。本机已实测：注入一个包着 `node:sqlite` 的 marker driver，工厂被调用、语句正常 prepare、供应商/价格/用量三个子服务全部跑通。
4. **并发设定**：驱动启动即 `PRAGMA journal_mode = WAL`、`busy_timeout = 5000`、`foreign_keys = ON`，适配「一库多 app」的多进程读写。

**代价**：

- Node 首次 import `node:sqlite` 会打一行 `ExperimentalWarning`（消除方式见根 README 常见问题 1）。
- Node 版本下限被抬到 22。
- `ModelInfra.init()` 目前**不暴露** `driver` 开关：要换驱动得用 `Store.open({ driver })` 自组子服务（根 README 常见问题 2 给了可运行代码）。

**替代方案与否决理由**：直接把 `better-sqlite3` 作为默认——给所有用户加一次原生编译，收益不足；`sql.js`——无文件锁、并发写语义不符。

---

## D5 — 不拆 CC Switch 相关能力

**状态**：已生效
**依据**：`SPEC.md` §5（非目标）、`AGENTS.md` 硬性规则 1

**背景**：CC Switch 一类工具会跨 agent 导入会话与用量、按各家特殊的 cache 计费口径去重与合并。曾有把这块抽进模型层的想法。

**决策**：**不做**。V0.1 明确排除「跨 agent 导入 / 特殊 cache 计费 / 去重」。

**理由**：

1. **定位冲突**。本模块的用量数据**由自己产生**（`generate` / `stream` / `fetch` 三条路径）。读别人的数据文件会把它变成「数据搬运工具」。
2. **违反硬性规则 1**：禁止扫描 `~/.codex`、`~/.claude`、`~/.local/share/opencode` 等目录。跨 agent 导入必然要读这些目录。
3. **没有稳定契约**。这些目录的格式随上游版本漂移，没有版本化 schema，也没有兼容承诺；维护成本会压过模型层本身。
4. **计费口径无法统一**。各家的 cache 计费/去重语义不同，强行归一化会污染本模块「一份 usage → 一份 cost」的干净口径（`SPEC.md` §4 不可自行更改）。
5. **宿主可自行接入**。真要导入，宿主解析完直接调 `usage.record()`——`request_id` 幂等，重复导入不会翻倍。

**代价**：功能面比「大而全的网关」窄；对想迁移历史数据的用户，需要自己写一段导入脚本。

**替代方案与否决理由**：做成可选插件包——V0.1 不引入未被验收场景覆盖的代码路径，先保持边界干净。

---

## D6 — 评审后收窄 `get()` 的 app 隔离与 `resolve()` 的密钥语义

**状态**：已收窄（评审 R01 的 B1 / B2，已由 F03 / F01 修复并回归）
**依据**：`docs/reviews/T02-T04-review.md`、`interfaces.md` 的「指挥裁决（R01 评审后）」表

### D6.1 `UsageService.get()` 默认按 appId 隔离（B1）

**收窄前**：`get(requestId)` 直接查库，不按 `appId` 过滤；测试甚至把「app A 能读到 app B 的明细」写成期望。

**为什么必须改**：

1. 用量明细含 `sessionId`、`tags`、模型名与成本。多 app 共库是 `ModelInfraConfig.appId` 的设计前提（「一库多 app」），明细不该互相可见——只要知道/猜到 `request_id` 就能读到别人的记录。
2. 隔离原本是**单向**的：`clear()` 是 app 级、`get()` 是全局级，语义不自洽。
3. HTTP 面 `GET /api/usage/logs/:id` 会把它放大成跨 app 泄漏。

**收窄后**：`get(requestId, options?: { appId?: string })`，默认用实例 `appId` 过滤；`{ appId: "" }` 显式关闭（仅调试），语义与 `scoped()` 一致。**同时改掉了反向断言**——测试现在断言「读不到返回 `null`」，并另有一条断言 `{appId:""}` 能读到。

### D6.2 `ProviderRegistry.resolve()` 的密钥语义（B2）

**收窄前**：没有 `apiKeyRef` 就返回 `apiKey: null`，根本不问 `CredentialStore`；preset 里声明的 `envKey` 是**死数据**。后果是「同一份配置，`provider test` 因无认证失败、`generate` 却靠 SDK 读环境变量成功」——错误码从 `CREDENTIAL` 漂移成 `AUTH`，宿主无法区分「这个供应商不需要密钥」和「你忘了配密钥」。

**收窄后**：

1. 无 `apiKeyRef` 时回退 `preset.envKey`（`credentials.tryResolve("env:" + envKey)`）。
2. 回退仍拿不到、且 preset 声明了 `envKey` → 抛 `CREDENTIAL`，文案说明「设置 `<ENV>` 或配置 `apiKeyRef`」。
3. `ResolvedProvider.apiKeySource` 显式标注来源：`"ref"` / `"env"` / `"none"`，让宿主能区分「不需要密钥」与「忘了配密钥」。

**为什么这两条要一起收口**：它们是同一类缺陷——**契约语义含糊，调用点用「恰好能跑」掩盖过去**（`AGENTS.md` 复盘第一条：契约缺陷会以强转的形式暴露）。收窄的原则是：**把「缺失」表达出来，而不是猜一个默认值**。同一个原则也解释了 `SPEC.md` §4 的「字段缺失一律降级为 `undefined`，不得当作 0」。

**代价**：破坏性变更（`get()` 增加可选参数、`resolve()` 可能新抛 `CREDENTIAL`），但发生在 0.1.0 内部迭代期，且已同步进 `interfaces.md`。

---

## D7 — 多 app 共库的边界：改行为的两处、只文档化的两处

**状态**：已生效（S6 / S7 为「保持现状 + 写明」）

评审提出的四条隔离问题里，两条改行为、两条只写进契约：

| 项 | 处理 | 理由 |
|---|---|---|
| B1 `get()` | **改行为**：默认按 appId 隔离 | 明细泄漏，见 D6.1 |
| B2 `resolve()` | **改行为**：env 兜底 + `CREDENTIAL` | 语义歧义，见 D6.2 |
| S6 `rollupAndPrune()` | **只文档化**：明确是**全局维护操作**（所有 app 的过期明细都会被折叠并删除），与 app 级的 `clear()` 不同 | 它是维护动作，按 app 切分会让「清理过期数据」变成每个 app 各自跑一遍；真正需要的是调用者知道这件事 |
| S7 `providers.list()` | **只文档化**：`providers` / `models` / `pricing_overrides` 三张表全局共享，不按 appId 过滤 | 供应商 id 全局唯一，同一个 `deepseek` 配置被多个 app 复用是常态；按 app 切分会让「配一次、到处能用」失效。记录里只存 `api_key_ref`，不存密钥本体 |

**代价**：宿主需要知道「哪些表是共享的、哪些是隔离的」。这三条都已写进 `interfaces.md`、根 README 常见问题 3 与本节，属于「显式契约」而不是隐式行为。

---

## D8 — 其它已定取舍（简记）

| 取舍 | 决定 | 理由 |
|---|---|---|
| 发布形态 | **单包** `model-infra-kit` + 两个子路径 `./server`、`./cli` | 三个入口共用同一份核心类型；拆成多包会让版本对齐与 peer 依赖变复杂 |
| 看板数据源 | 只走 `mik serve` 的 HTTP API，**不直接打开 SQLite** | 看板与数据写入方解耦；app 隔离、脱敏、鉴权只在服务层实现一次（见 `apps/dashboard/README.md`） |
| 历史成本 | **永不重算**，事件落库即固化 `cost` / `pricing_source` / `pricing_basis` | 改价只影响后续请求，账目可审计（e2e AC7 实测：历史 $0.0018 不变，新请求按新价 $0.0081） |
| 启动阻塞 | `init()` 不因目录/价格/模型同步失败而抛错，只降级 + `onWarn` | 宿主进程不该因为上游抖动起不来（硬性规则 6） |
| 密钥 | 只存引用（`env:` / `file:` / `keychain:`），日志与响应统一走 `redact()` | 硬性规则 4；上游 401/403 时不再把响应体拼进错误文案（S9） |
| 删除语义 | 删除文件必须进回收站（`~/.model-infra-kit/trash/`），禁止 `rm -rf` | 本机铁律；凭据文件删除同理（S15 → F04） |
| 并行开发 | 一张卡一个隔离 Worker，只拥有卡里写明的文件；Worker 只跑自己的测试 | 并行 Worker 的半成品会污染彼此的验证（见 `AGENTS.md` 复盘） |
