# Model Infra Kit — 架构、可靠性与数据契约整改方案

> **文档类型**：Architecture RFC / Technical Remediation Plan（可直接用于架构评审、GitHub Issues、开发 Agent 分工）\
> **审查基线**：`model-infra-kit` v1.7.0，架构提交 `267628e`，Archify v3.0.1 生成的五张架构图\
> **核心范围**：`ModelInfra`、请求执行、路由与 KeyPool、熔断、Token/成本账本、折叠与归档、HTTP API、权限、Webhook、Dashboard 服务边界\
> **优先级**：P0 = 不变量/安全/数据语义；P1 = 可观测性与工程可靠性；P2 = 可选扩展\
> **状态**：**基于设计文档的审查与整改规范，不等于已经逐行审计实际源码**。所有“需验证”项目在获取仓库后先取证，再决定是否修改。\
> **配套文档**：[`ui-ux-improvement-plan.md`](ui-ux-improvement-plan.md)（独立的 UI/UX 设计与实施文档）

---

## 0. 总体判断与边界

### 0.1 架构定位

Model Infra Kit 应是**以可嵌入模型运行时为核心**、可选择启动本地 OpenAI-compatible Gateway 与 Dashboard 的工具包，而不是完整的 Agent Harness 或云原生 AI 运维平台。

根据图示，现有架构具备值得保留的边界：

- 三种接入面：`ModelInfra.init()` 的嵌入式调用、`mik.fetch` 适配器、`mik serve` 的本地 HTTP `/v1` 服务；均经统一核心编排。
- 供应商协议与 Usage 归一交给 Vercel AI SDK；成本/模型标准化借助 `llm-pricing`；自研聚焦 Registry、凭据引用、路由、成本优先级与 Usage Recording。
- 事件账本以整数微美元记录成本，历史成本在写入时固化；以 SQLite（默认 `node:sqlite`，WAL + `busy_timeout`）承载，底层驱动可替换。
- 路由支持 KeyPool、候选故障切换以及被动熔断，流式输出已提交时限制重放。
- HTTP `/api/usage/*` 为 CLI 和 Dashboard 共享的读取出口；Dashboard 不应绕过服务层直接访问数据库。

**总体策略**：保留核心形态，补强语义契约、运行时不变量、观察与控制边界。避免直接引入 Redis、Kafka、独立控制平面服务或新数据存储。

### 0.2 不做什么

- 不未经证明就宣布项目存在双重扣费、授权泄漏、熔断错误或账本错账。
- 不为了仪表盘美观而重构主请求执行路径或重算历史已固化费用。
- 不把默认实例级状态改为强一致分布式状态。
- 不把 Agent 的任务规划、工具编排、记忆与会话决策纳入 MIK 核心。
- 不在掌握现有表结构前贸然创建第二套“审计账本”或要求迁移全部历史数据。

### 0.3 来源清单与证据等级

| 来源 | 从资料可以确认的关键契约 |
|---|---|
| `architecture-overview.html` | 接入面、ModelInfra 门面、依赖边界、精确金额与密钥政策、SQLite/Dashboard 边界 |
| `sequence-generate-request.html` | 主请求时序、计价优先级、流式传输、失败尝试记账 |
| `workflow-failover-decision.html` | 可重试分类、两级轮换、成功 fallback 标记、Attempt 落账 |
| `dataflow-usage-pipeline.html` | 微美元字段、准确账单、汇总、归档守恒、Webhook 最佳努力旁路 |
| `lifecycle-circuit-breaker.html` | 实例级内存状态机、默认阈值、单探针、不跨实例共享 |
| `index.html` | 文档版本、提交、定位与权威文档索引 |
| UI 截图与 UI `README.md` | 运行时与看板端口、页面功能、Provider 启动配置与 SQLite 的关系 |

正式修复与实现判断，应继续查阅架构索引引用的 `docs/SPEC.md`、`docs/interfaces.md`、`docs/decisions.md`（D1–D9），以及当前提交和后来版本的源代码。上传的资料没有包含上述三个正文文件及完整仓库，因此不能确认所有源码行为。

**证据标记**：`[确认/图示]` 说明图示明确给出的现有设计；`[待验证]` 说明源码/测试尚未核实；`[建议]` 是新提议，不能自动当成现有实现。

---

## 1. 结构基线：逻辑架构与核心不变量

```text
Host Application
  ├─ ModelInfra.init().generate / stream
  ├─ mik.fetch (OpenAI SDK 可复用)
  └─ mik serve /v1 兼容端点
            │
            ▼
       ModelInfra Core
  Auth / Scope / Router / Registry
  KeyPool / CircuitBreaker / AI SDK Bridge
  Usage normalization / Pricing / UsageRecorder
            │
            ▼
       SQLite Ledger
      usage_events + fold tables
            │
      HTTP Query/Admin API
            │
     CLI / Next.js Dashboard
```

**上图是逻辑角色，而非强制部署为多个独立进程。** 设计最重要的不变量：

- INV-01：每个实际上游 Attempt 最多有一次最终生效的记账效果；逻辑请求与 Attempt 不混淆。
- INV-02：任何价格缺失都不得被推导为精确零费用。
- INV-03：费用存储与聚合使用定义明确的整数计量单位；历史事件不因价格目录更新而自动重算。
- INV-04：机密值不写入持久账本、普通日志、错误响应及诊断 UI。
- INV-05：流式业务输出进入不可安全重放状态后，不会自动切换到另一个上游重复生成。
- INV-06：半开状态同一健康键下最多一条在途探针（实例内保证）。
- INV-07：归档/修剪前后在定义的时间区间、分组和费用单位下守恒；无法恢复的明细不可伪造。
- INV-08：管理员写操作不通过只读或运行时调用凭据获得权限。

---

## 2. P0：统一逻辑请求、上游 Attempt 与记账事件语义

### ARCH-001 / P0 / `[确认/源码] + [部分行为验证]`

**图示证据**：`sequence-generate-request.html` 规定三种接入面汇聚统一路径，“计量只发生一次”；`workflow-failover-decision.html` 规定“每次实际尝试各落一行 usage”，失败 Attempt 为 `status=error`，轮换成功有 `is_fallback=true`。

**矛盾点说明**：二者在语义上可以成立，但必须明确：“只发生一次”是**每个实际 Attempt 只记一次**，不是**每个用户请求只产生一条 usage_events**。一条逻辑请求可能包含多次 Attempt。

**G137 源码审计（基线 `267628e`；行为门禁结果见 [任务卡](../../tasks/EVO-G137-dashboard-ia-and-architecture-invariants.md)）**：

- **关联键**：`hub.ts:840,1032` 使用 `request.traceId ?? randomUUID()`；未提供 trace 时，各次尝试共享自动生成的 trace。调用方可让多个逻辑请求共享 trace，因此 `traceId` **不是可靠的逻辑请求唯一键**，不能对所有数据以 `COUNT(DISTINCT trace_id)` 推导逻辑请求数/最终成功率。`hub.ts:861,1081` 为生成/流式的每次候选或 Key 尝试分配独立 `requestId`；`store/schema.ts:59` 将 `request_id` 定义为事件主键。
- **落账与标记**：生成成功/失败在 `hub.ts:914,947` 记录；失败为 `status=error`。`is_fallback` 表示候选序号或 Key 尝试序号大于零，**失败尝试也可带此标签**（`hub.ts:930,961,1148`），不能解释为最终成功标记。
- **流式防重复与防重放是两项不同保障**：`runStreamAttempt` 的 `recordOnce`（`hub.ts:1204`）保护成功、catch、finally 路径；外层 `committed`（`hub.ts:1091-1120`）在文本或工具输出后禁止切换。生成的工具副作用通过 `replayUnsafe`（`hub.ts:863,883,885,968`）禁止重试。不能把防重放本身当成防重复落账证据。
- **统计口径边界**：事件/日汇总计数以落账事件为单位。事件还包括本地缓存命中与外部上报，不应将所有 `usage_events` 行直接等同于真实上游尝试。最终逻辑成功率需要独立关联契约；本卡不新增字段、不改 API、不宣称此契约已闭环。
- **可复现的既有行为测试**：`test/failover-routing.test.ts` 覆盖 HTTP 429/5xx 切换、永久 4xx、全部失败、输出后失败和取消；`test/cascading-router.test.ts` 覆盖多候选及共享 trace；`test/load-balancer-failover.test.ts` 覆盖 Key 429 轮换和失败/成功 trace 关联。G137 复跑这些测试；不据此宣称所有请求入口的逻辑实体契约或模型级健康 UI 已完成。

**建议规范的逻辑实体（概念模型，非强制新增数据库表）**：

| 实体 | 含义 | 推荐主键/关联 |
|---|---|---|
| Logical Request | 用户发起的完整一次生成行为 | 建议独立 `logicalRequestId`；现有 `traceId` 可跨请求复用 |
| Attempt | 针对一个候选、凭据及上游端点的一次真实尝试 | 现有 `requestId`（事件主键）；不重命名公共字段 |
| Usage Event | 特定真实尝试/上报对应的用量事实与成本 | 现有稳定事件 ID + 对应 Attempt 映射 |
| Trace / Span | 可跨请求或子过程聚合的上下文 | `traceId` + 可选 `spanId/parentSpanId` |

**数据约束**：

1. 同一个 Logical Request 可对应多条 Attempt；每条 Attempt 最多对应一次有效 Usage 记账效果。外部上报如果无法与真实 Attempt 对齐，需定义独立幂等键与来源类别。
2. `finalStatus`（逻辑请求最终状态）与 `attemptStatus`（每次上游尝试状态）独立。
3. 最终成功与 Attempt 失败可以同时成立，不应在请求成功率里把所有失败 Attempt 计入用户失败。
4. `is_fallback` 标识后续候选或 Key 尝试，与成功/失败状态独立；不可解释为逻辑请求最终成功。
5. 计量由统一服务写入，控制层不能绕过此服务直接写任意 Usage 事件。

**实施序列**：

1. 审计现有 Event Schema 与 `hub.generate`/`hub.stream`/HTTP/`mik.fetch` 的真实调用路径。
2. 建立一组最小测试：正常成功 1 次、同候选换 Key 2 次、换候选 3 次、全部失败、已输出流式失败、调用方取消。
3. 如有现成关联键，优先复用；如确实缺失，再设计向后兼容的可选字段迁移及旧数据降级规则。
4. API 展示“逻辑请求数、上游尝试数、最终成功率、Attempt 成功率”须基于明确的计算公式和分母。

**验收**：单次成功 `logicalRequests=1, attempts=1`；两次失败一次成功 `logicalRequests=1, attempts=3, finalSuccess=1, failedAttempts=2`；不会因流式/异常路径重复入账；失败 Attempt 的费用缺失不被当成已知零。

---

## 3. P0：熔断器状态规则收敛与模式一致性

### ARCH-002 / P0 / `[确认/源码] + [部分行为验证]`

**图示证据**：

- `lifecycle-circuit-breaker.html`：实例内 Map、无定时器/主动探测/跨实例共享；`failureThreshold=3`、`cooldownMs=30_000`（默认）；`now` 可注入假时钟；`acquire` 同步占位；取消探针执行 `release` 后回 `OPEN`。
- 同图说明 `adaptive_qos` 模式按**模型**粒度选择健康键，其他模式按**供应商**粒度。
- `workflow-failover-decision.html` 简写为按供应商粒度，未给出该模式差异。
- 生命周期图对 4xx（除 429）同时出现“视为成功（清除记录）”与“非 retryable 错误维持原状态”两种文字。

**审查结论与源码事实（2026-10-12 证实）**：

- **4xx 错误处理真相**：`packages/mik/src/router/circuit-breaker.ts:50-52` 明确实现 `if (!isRetryableRouteFailure(error)) { if (error.status !== undefined) this.success(providerId); return }`。当上游明确返回非 retryable 4xx（除 429）时，代码判定上游端点连通且存活，主动调用 `this.success` 清除历史被动失败计数。
- **健康键粒度真相**：`packages/mik/src/hub.ts:853,1067`（generate/stream）实现 `const healthKey = this.cascading[primary.requested] || this.loadBalancer?.routing === "adaptive_qos" ? candidate.modelRef : candidate.resolved.providerId`。**级联路由或 `adaptive_qos`** 采用模型引用粒度，其余模式采用供应商粒度；不能省略级联条件。
- **半开与取消**：`circuit-breaker.ts:36-43` 同步预占唯一探针；`release`（`:67-73`）释放探针回 OPEN，不声明上游成功。无 HTTP status 的非 retryable 错误保持记录；有 status 且不可重试的错误清除记录。HTTP 429 与 5xx 始终走失败分支。
- **证据边界**：已有 `test/failover-routing.test.ts` 与 `test/load-balancer-failover.test.ts` 覆盖冷却、恢复、取消、4xx 分类；G137 增补的临时假时钟探针验证 100 次同键 acquire 仅一次成功。源码粒度条件确认不等于完整 Dashboard 状态词汇与所有图示已整改；这些仍属于后续卡。

**状态转移规范（已对齐当前代码事实）**：

| 当前状态 | 输入 | 检查点与代码行为 | 目标状态/结果 |
|---|---|---|---|
| CLOSED | 成功 | `this.success(id)` 清除记录 | CLOSED |
| CLOSED | retryable 失败 | 失败次数未达 `threshold` | CLOSED，累计失败 +1 |
| CLOSED | 第 N 次 retryable 失败 | 达到 `threshold`（默认3） | OPEN，记录 `openedAt=now()` |
| OPEN | 冷却未过（默认30s） | `acquire()` 拒绝 | 拒绝/跳过该候选，不调用上游 |
| OPEN | 冷却结束 | 第一个 `acquire()` 成功 | HALF_OPEN，`probing=true` 独占占位 |
| HALF_OPEN | 探针成功 | `this.success(id)` 清除记录 | CLOSED |
| HALF_OPEN | 探针 retryable 失败 | 再次失败 | OPEN，重置冷却时间 |
| HALF_OPEN | 调用方取消 | `release(id)` | OPEN，释放探测位 |
| CLOSED/HALF_OPEN | 非 retryable 4xx（带 status） | `this.success(id)` 确认上游存活 | CLOSED，清除记录 |

**模式要求**：

- 健康键模式必须显式文档化，`adaptive_qos` 与默认路由有不同粒度时不得共用未经标注的同一 UI 状态。
- 不将单实例健康状态宣传为集群全局健康；可增加实例标识与观测时间字段（如果运行时暴露）。
- `now` 可注入时钟用于测试边界与冷却，不依赖真实睡眠。
- 已存在单探针机制时优先补并发测试，不重复设计另一套熔断器。

**验收**：状态矩阵有一份权威定义，源码、测试、工作流图、生命周期图与 Dashboard 词汇表一致；100 次并发 `acquire` 同一健康键在 HALF_OPEN 阶段最多只有一个真实探针（实例内）。

---

## 4. P0：成本计量、来源与账本精度

### ARCH-003 / P0 / `[确认/图示] + [待验证]`

**既有设计**：

- 存储列：`cost_micros`、`cost_low_micros`、`cost_high_micros`、`cache_savings_micros`，设计目标为整数微美元。
- 价格优先级：`pricing_overrides > llm-pricing overrides > 上游目录 > 内置 archive`。
- 未提供的字段必须保持 `undefined`，不能当作 `0`。
- 供应商回传准确账单 `source=provider` 时可将估算折叠为 `low=high=usd, basis=exact`；原值/状态以保留标签记录供对账。
- 入账时固化 `cost / pricing_source / pricing_basis`，不随目录更新重算历史。

**风险核查**：数据管线图一处描述 SQL 聚合使用 `CAST(ROUND(x*1000000) AS INTEGER)`；同时要求「整数微美元贯穿全链」「禁止浮点求和」。两者未必冲突：如果 `x` 只在入口转换一次，可以合理；如果在分组求和前后重复舍入，则可能导致不守恒。

**正确性原则**：应在**定义明确的归一化边界**把价格单位转换为整数微美元；之后所有可聚合金额只累加整数（需要上下界时分别累计）。不在分层折叠中用 `REAL` 求和。

反例：

```text
round(a) + round(b) 不一定等于 round(a + b)
```

**待验证字段/接口契约**：

1. `cost_micros` 是精确值、最佳估算值，还是可为空？区间上下界同时存在时语义为何？
2. 失败 Attempt 可能已有供应商侧实际费用但本地缺少用量，如何表示「未知」？
3. `pricing_source` 是事件时间的版本快照还是一个枚举标签？完整追溯是否还需要生效时间或价格版本？
4. Token 的 input/output 与 cached input/缓存写入是否互斥、包含还是独立，保证不会重复计费与图表双重堆叠。
5. 对于 batch、时段、长上下文、reasoning token 等计费因素，如何记录准确价格的适用前提与已知程度。

**建议成本状态模型（API 概念，不是现存 Schema 声明）**：

```ts
// 仅示意；须与当前 interfaces.md / Schema 和历史记录兼容
// MicroUSD：整数微美元；在 JS 安全整数边界内传 number，
// 超出范围则采用有精确定义的字符串序列化策略。
type CostDisplay =
  | { kind: 'exact'; amountMicros: string; source: string }
  | { kind: 'estimate'; lowMicros: string; highMicros: string; source?: string }
  | { kind: 'unknown'; reason: string };
```

**落库/聚合验收**：

- [ ] 使用大小不同、极小金额与大量行测试，`sum(event.micros) == sum(daily.micros) == sum(grouped.micros)`（口径和时间范围一致时）。
- [ ] 对 low/high 各自验证守恒；`low <= high`（当两者都可用）；金额字段不能为空时不得以零代替。
- [ ] 重启及价格目录更新后，历史事件的金额/价源/计价依据保持不变。
- [ ] 供应商准确账单覆盖目录估算后，审计字段保留原始值与来源，不能不可逆地丢失数据。
- [ ] CLI、Dashboard、HTTP `/api/usage/*` 全部使用相同 `costBound()` 或等价统一口径，不在前端重算价。

---

## 5. P0：重试、故障切换与流式响应安全

### ARCH-004 / P0 / `[确认/图示] + [建议]`

**图示确认的降级条件**：HTTP 429、超时、连接失败、上游 5xx；其他 4xx（除 429）判终局。优先同候选内轮换 Key，Key 用尽后切下一个候选；429 Key 冷却默认 30 秒（内存状态）；流式已输出文本或工具调用后禁止重放。

**建议补充：统一请求预算**

- 每个逻辑请求具有一个总截止时间 `deadline`，并有受约束的尝试上限 `maxAttempts`；应区分 `perAttemptTimeout` 与整体预算。
- 每次轮换之前检查剩余预算、已消耗尝试和调用方取消信号；达到上限应以有界错误终止。
- 同一候选内 KeyPool 轮换与跨模型级联共享同一预算，不能各自无限重置次数。
- 明确哪些操作属于安全重试。非幂等外部上报等路径不得直接复用生成请求的策略。

以上是**建议**，具体默认值必须结合真实负载与现有配置接口确定；此处不擅自规定例如“固定 3 次”之类的默认。

**流式提交点核查**：

| 时点 | 是否允许自动故障切换（建议核查的判断） |
|---|---|
| 尚未发送响应头、没有业务数据 | 可按既有错误分类与预算执行 |
| 已发送 SSE 响应头，但未发送业务内容 | 需验证运行时能否安全恢复或重建传输；不可单凭“无文本”判定 |
| 已输出文本、工具调用或其他不可重放业务事件 | 禁止自动切换重放 |
| 调用方 Abort/断开 | 中止上游、释放探针，不将调用方取消误计为供应商失败 |

图示提到首字过长可能通过 SSE 注释心跳保活。心跳注释是否构成传输层提交、是否影响恢复策略需单独确认；不能将“HTTP 头已提交”和“业务结果已提交”视作同一事件。

**成本边界**：失败 Attempt 可能已在上游消耗 Token 但无法获得完整 Usage。记账应记录已知事实与未知费用，不应因为本地失败自动得出供应商未计费。

**验收**：

- [ ] 针对 429 / timeout / connection / 5xx / 400 / 401 / 403 / 404 / 422 编写错误分类表测试。
- [ ] 注入上游连续失败，验证总 Attempts 不超过预算，取消信号可及时传播。
- [ ] 使用模拟 SSE 测试：头已写、心跳已写、首文本已写、首工具调用已写、流式中途断开。
- [ ] 终局错误保留明确错误原因，且不会用后续候选偷偷补发重复输出。
- [ ] 每次实际 Attempt 的结果与 Usage 事件保持一致或明确标记未知。

---

## 6. P0：接口职责、权限与配置所有权

### ARCH-005 / P0 / `[确认/图示] + [待验证]`

**冲突来源**：架构图强调 Dashboard 不直连 SQLite、使用服务层 HTTP API，数据管线图将 Dashboard 标记为“只读”；但 UI 截图展示 Pricing 的 `PUT /api/pricing/:modelId` 和供应商启停等管理动作。它们未必发生在同一个后端服务中，但应明确接口所有权与权限，而非用“只读看板”概括全部控制台能力。

**建议逻辑接口域（仍可共用单服务/端口）**：

| 接口域 | 功能 | 权限建议 | 示例（概念） |
|---|---|---|---|
| Runtime | OpenAI-compatible generate/stream | 独立 Runtime 凭据+作用域 | `/v1/*` |
| Query | 用量、日志、Trace、价格来源、运行状态 | Reader | `GET /api/usage/*` |
| Admin | 覆盖价、供应商配置/启停、配额规则 | Admin + CSRF/来源防护（适用时） | `PUT /api/pricing/:modelId`（UI 已展示） |
| Health | 进程/连接诊断 | 受限或去敏感化公开 | 具体路径待现有契约核对 |

**核查与整改**：

1. 检查 Runtime、Query、Admin 是否共用 Bearer Token；若共用，评估最小权限和攻击面。
2. 检查 `appId`、组织作用域和授权主体在查询过滤器与管理写操作中是否由可信上下文派生；不能仅依赖客户端传来的 `appId`。
3. 检查浏览器端密钥管理和代理层：不得在客户端持有上游 Provider 原始 API Key。
4. 检查是否支持跨域访问、嵌入反代、CSRF、CORS、Origin 校验；属于部署配置审查，不等于已存在漏洞。
5. 明确 Admin 操作是否持久化、何时生效、是否需要热重载、重启后状态是否保留。
6. 检查 Pricing 编辑是否具备审计信息和并发冲突处理；高影响操作应有责任主体/时间。

**Provider 配置所有权特别说明**：UI README 明确 `mik serve` 的默认 `isolatedProviders: true`，Provider 来源于启动配置 `mik.config.json`，不会从共享账本 providers 表直接读取。这是已说明的设计行为。不能因为 Dashboard 提供 Provider 列表就假设“写 providers 表会使当前 serve 热更新”。

**验收**：只读凭据无法发起管理变更；Admin 操作对跨租户资源无法越权；重启与热加载语义有单一文档；无明文密钥通过日志/前端/API 泄漏。

---

## 7. P1：日志、路由决策与 Trace 的可观测契约

### ARCH-006 / P1 / `[建议]`

**目标**：能回答“为什么选择这个 Provider/Model、发生了什么轮换、为什么变慢、为什么费用不同”。

**最小原则**：先检查已有 `usage_events`、tags、Trace/Span 头及请求日志是否足够；优先复用现成 ID 和结构。只有必须重建路由决策且当前没有记录时，才考虑**可选、去敏感化**的 attempt/routing 诊断数据结构。

建议从服务层衍生一个稳定的诊断结果（示意，并非现有 API）：

```ts
interface RequestDiagnosticView {
  requestId: string;
  finalStatus: 'success' | 'error' | 'cancelled' | 'unknown';
  traceId?: string;
  attemptedModels?: Array<{
    attemptNumber: number;
    providerId: string;
    modelId: string;
    outcome: 'success' | 'error' | 'cancelled';
    failureClass?: 'rate_limit' | 'timeout' | 'connection' | 'provider_5xx' | 'terminal_4xx' | 'other';
    durationMs?: number;
    fallbackReason?: string;
    // No secret, no raw credential value, no prompts by default.
  }>;
  diagnosticCompleteness: 'complete' | 'partial' | 'aggregate_only';
}
```

**补充建议**：

- 错误分类使用稳定枚举与必要的 `HTTP status`，不要依赖 SDK 文案字符串匹配（图示已有 HTTP 状态优先原则）。
- 若已记录 `traceId` 与 span-type（UI README 列出 `root/reasoning/tool_call/generation`），检查是否具有真实父子关系；没有 `parentSpanId` 不应导出伪层级。
- 采样/保留策略应说明哪些请求保留明细，哪些只有聚合；不能让 Dashboard 推断“数据不存在 = 未发生”。
- 机密脱敏：CredentialStore 仅存/传引用，日志不可记录完整 Authorization、环境变量密钥、上游敏感请求体；日志级别可控制并默认安全。
- 运行时状态查询不得产生主动健康请求或修改熔断计数，除非显式操作并审计。

**验收**：基于一个“三次尝试最终成功”的模拟请求，可追踪全部真实尝试，包含准确失败类别和终局状态；诊断不能反推出上游凭据；缺失 Span 关系时 UI 标识“调用序列”。

---

## 8. P1：SQLite 事务、归档守恒与数据生命周期

### ARCH-007 / P1 / `[确认/图示] + [待验证]`

**已确认原则**：`usage_events` 为事实表，按日/标签/Trace 聚合折叠；归档包含 gzip + SHA-256 信息；修剪前在 `IMMEDIATE` 事务内验证摘要与账本，**差 1 微美元也拒绝修剪**；折叠表不保留部分明细字段，例如 `pricing_source`，无法从聚合恢复单次调用详情。

**建议审计点**：

- [ ] `record(event)` 是否具备明确幂等边界；并发、多次重试、进程崩溃后重启是否可能写入重复事件？
- [ ] `BEGIN IMMEDIATE` 归档的读写时间范围和并发事务交互是否正确，WAL 中读者是否观察到一致快照？
- [ ] 归档分片对账是否同时覆盖 event count、token totals、cost micros low/high、checksum 和时间范围。
- [ ] 归档后 Query API 如何表示“仅可提供聚合”；按 Trace 查不到明细时如何区分“不存在”与“已归档”。
- [ ] 压缩归档的恢复流程是否可演练；SHA-256 校验失败时保持数据库原始数据不删除。
- [ ] 若 `pricing_source` 不进入折叠，历史“未定价占比”仅限保留明细的事实是否在 API / CLI / UI 中明确标识。

**建议的保留等级契约**：

| `detailAvailability`（概念名） | API/UI 允许表示的内容 | 不允许 |
|---|---|---|
| `raw` | 单次 Attempt、价源、详细 Trace、成本、错误 | 无 |
| `aggregate_only` | 历史日/月/标签/Trace 聚合 | 重建单次 Span/价源 |
| `archived_unavailable` | 明确告知归档位置/恢复指引（若有） | 把 404 一概解释为未发生 |

**验收**：将同一事件集折叠、归档、重启后重新查询，定义的金额与 Token 不变量仍成立；若无法恢复明细，API 不声明其存在；不因摘要校验失败删除原始账本。

---

## 9. P1：Provider 状态、KeyPool 与实例边界

### ARCH-008 / P1 / `[确认/图示] + [建议]`

**已确认**：默认熔断器为实例级内存 Map，无定时器、无主动探测、无跨实例共享。429 触发 Key 冷却，凭据池状态不进数据库和普通日志；密钥通过 `api_key_ref` 及 `CredentialStore` 引用解析（图示列出 `env:/file:/keychain:`）。

**建议进一步定义状态视图（不要求建立集中式缓存）**：

| 状态来源 | 建议可观测字段 | 生命周期 |
|---|---|---|
| 配置 | `providerId`、协议、启用、配置是否完整 | 启动/热加载 |
| 主动连接测试 | `lastTestAt`、`lastTestOutcome` | 用户触发测试 |
| 被动熔断 | 健康键粒度、`CLOSED/OPEN/HALF_OPEN`、时间、阈值 | 实例内存 |
| KeyPool | 可尝试/冷却凭据数量（不含具体秘密） | 实例内存 |
| 模型可用性 | 标准目录资料与实际可调用端点 | 目录+本地配置 |

**风险边界**：多实例部署可能对同一 Provider 分别持有不同熔断状态；这是现有部署选择，不应自动认定为 bug。若未来要求跨实例协调，先定义可插拔 `HealthStateStore` 的一致性与 TTL 契约，再讨论共享存储实现。默认单进程仍保持零额外服务依赖。

**验收**：状态接口只读取不会改变内存熔断状态；无明文凭据泄漏；运行时实例标识与最后更新时间可用于解释状态；多实例部署说明准确。

---

## 10. P1/P2：Webhook 可靠性分层

### ARCH-009 / P1：对现有 Best-effort 语义诚实描述

数据管线确认：Webhook 是事务完成后的旁路，使用 HMAC 签名、有界重试，但重启时队列丢失，**不能替代账本**。

**立即整改建议**：

- 给出明确的投递语义：不保证重启后未发送事件仍能发送，不声明 exactly-once。
- 区分“账本已提交”与“Webhook 已投递”，回调失败不应回滚已生效账本。
- 规定签名字段、重放保护窗口（若协议需要）、错误处理与重试上限（按现有接口为准）。
- 日志/管理页面对成功、待重试、重试耗尽、丢弃各有明确状态（只有存在对应数据时才能展示）。

### ARCH-010 / P2：可选 Durable Outbox（按需求启用）

如果有真实的高可靠通知需求，再增加数据库持久化 Outbox：

1. 在与事实事件相同的事务或可靠关联边界中写入 Outbox 事件。
2. 采用稳定 Event ID / Delivery ID，接收方按 ID 幂等；不要承诺网络环境下的 exactly-once 端到端效果。
3. 记录尝试次数、下次重试时间、终局失败及清理策略。
4. 通过后台 worker 恢复待发送工作，同时设置批次、速率和最大队列规模。
5. 对已部署的默认 Best-effort 模式保持向后兼容，避免要求所有嵌入式用户都运行独立常驻任务。

**P2 不应提前阻塞 P0 账本语义与 P1 诊断闭环。**

---

## 11. P1：性能、生命周期与可测试性边界

### ARCH-011 / P1

**启动/依赖降级**：架构图规定目录或上游价格服务失败时 `init()` 应降级、通过 `onWarn` 通知，而不是直接抛错。需要核查警告是否可观察、是否有更新时间与过期状态；缓存降级不应把未知价格伪装成价格为零。

**SQLite 默认栈**：已经选用 WAL + `busy_timeout` 与可替换驱动，建议先做基准测试，不为未来规模假设贸然拆成服务：

- 多写入并发、读写混合、长范围汇总、归档/修剪期间延迟与错误分布。
- 账本积累从 10^3 到 10^6+ 行时的索引/查询计划（样本量按真实使用情况调整），长期聚合查询是否优先走 fold tables。
- 重启时是否丢失内存健康和 Key 冷却状态（符合既定契约时需要文档说明）。
- 日志/Trace 的检索字段是否有合适索引，避免无界扫描和返回过量数据。

**安全与配置**：

- `CredentialStore` 的 env/file/keychain 引用应在解析失败时产生去敏感化诊断，不暴露文件内容、Token 或机密位置的多余信息。
- 若热重载配置生效，验证配置更新原子性：新旧请求是否基于一致的配置快照，旧密钥对象是否正确释放。
- 导出的日志和诊断信息应经过敏感字段白名单或可靠的脱敏策略，而不是只替换字符串 `sk-`。

**验收**：重载、降级、数据库忙等待、进程退出/重启、断网场景均有可确定的响应/错误；性能回归基线与环境记录在仓库，未达标才做更大架构改造。

---

## 12. API 与文档同步机制

### ARCH-012 / P1

建议建立一张**契约追溯矩阵**，避免出现熔断 4xx 和健康键粒度等图文漂移：

| 契约主题 | 权威规范 | 实现位置（核对后填写） | 自动验证 | UI 消费 |
|---|---|---|---|---|
| Retryable 分类 | `docs/SPEC.md` / `docs/interfaces.md` | Router/错误分类器 | 分类表测试 | Logs/Routing |
| Breaker 状态转移 | `docs/decisions.md` + 生命周期契约 | CircuitBreaker | 假时钟+并发测试 | Providers |
| Request vs Attempt | 统一语义规范 | Hub/Recorder/Repository | 幂等与聚合测试 | Overview/Logs |
| 成本 microUSD | SPEC / Pricing contract | Pricing/Recorder/Repository | 数值性质测试 | 全部成本页 |
| Provider 配置 | CLI Context / config schema | `mik serve` | 重启/热加载测试 | Providers |
| 授权与隔离 | Query/Runtime/Admin 接口规范 | HTTP handlers | 越权测试 | 管理页 |
| Archive retention | 数据保留规范 | Ledger/Archive | 守恒/恢复测试 | Traces/Logs |
| Webhook delivery | 通知契约 | Dispatcher | 失败/重启测试 | Webhooks |

**规程**：每次改变核心行为，提交 PR 必须同时提交规范差异、测试、受影响图示与 Dashboard 文案。架构图中的代码行号应由生成脚本以当前提交重新校验，避免用旧版本行号误导读者。

**文档级推荐的统一术语**：

```text
Logical Request   逻辑请求
Attempt           上游尝试
Usage Event       用量事件
Final Status      最终结果
Attempt Status    单次尝试结果
Fallback          故障切换/回退策略成功路径（详定语义）
Active Probe      主动连接测试（非熔断被动观测）
Circuit State     被动熔断状态（实例内）
Exact Cost        已确认成本
Estimated Cost    估算成本
Unknown Cost      未知成本
Archived Detail   已归档/详情不可在线获取
```

---

## 13. 任务优先级与推荐 PR 切片

### 13.1 任务清单

| Issue | 级别 | 目标 | 先验证什么 | 交付物 |
|---|---|---|---|---|
| ARCH-001 | P0 | Request/Attempt/Usage 语义 | 当前 Schema 与去重键 | ADR + 测试 + 必要兼容字段 |
| ARCH-002 | P0 | 熔断状态机唯一规则 | 4xx 转换/健康键粒度 | 转移表 + 代码/图一致性 |
| ARCH-003 | P0 | 微美元与价源一致性 | 舍入位置/缺失费用 | 不变量性质测试 + API 语义 |
| ARCH-004 | P0 | 轮换预算和流式提交点 | 当前超时/中止逻辑 | 有界重试、SSE 故障用例 |
| ARCH-005 | P0 | Admin/Query/Runtime 权限边界 | Token 与配置持久化 | 权限矩阵 + 越权测试 |
| ARCH-006 | P1 | 请求路由诊断 | 已有 ID/Trace 关系 | 最小只读诊断契约 |
| ARCH-007 | P1 | 归档守恒与详情保留 | 原始/折叠/归档机制 | 守恒、恢复与降级测试 |
| ARCH-008 | P1 | Provider 状态来源 | 配置/实例内存 Map | 不泄密的状态读接口 |
| ARCH-009 | P1 | Webhook Best-effort 契约 | 重试/重启实际行为 | 可靠性声明 + 回归测试 |
| ARCH-010 | P2 | 可选 Outbox | 产品是否真的需要 | 可插拔设计提案（先不实现） |
| ARCH-011 | P1 | 启动/存储/性能 | 现有基准与瓶颈 | 性能基线、故障测试 |
| ARCH-012 | P1 | 规范/图/测试同步 | 文档漂移范围 | 追溯矩阵 + CI 检查 |

### 13.2 推荐顺序（避免高风险大爆炸式重构）

**Phase A — 只读审计与证据固定**

- [ ] 锁定当前 Git Commit/Tag，收集 `SPEC.md`、`interfaces.md`、`decisions.md`。
- [ ] 阅读 Hub、Router、CircuitBreaker、KeyPool、Pricing、UsageRecorder/Repository、数据库 Schema、HTTP/CLI 和 Dashboard 路由。
- [ ] 追踪三种接入路径及错误/流式/归档分支的真实调用关系。
- [ ] 将每个 Issue 标记为 `verified defect`、`contract mismatch`、`missing capability` 或 `not needed`；允许零问题结论。
- [ ] 禁止在此阶段顺手改接口、重命名或迁移表。

**Phase B — P0 契约修订与最小补丁**

- [ ] 先定稿 Request/Attempt、状态机和 Cost 语义。
- [ ] 若测试未通过，做最小局部修复；每项变更保留老数据/API 的兼容行为。
- [ ] 针对 Auth/Admin、SSE 重放和幂等新增负面测试。
- [ ] 更新两张存在粒度/非 retryable 歧义的架构图，并重新校验证据行号。

**Phase C — 诊断与数据生命周期**

- [ ] 根据现有 Schema 增加必要的只读诊断投影，不把 Dashboard 直接耦合数据库。
- [ ] 保证归档前后统计守恒、明细不可用有明确状态。
- [ ] 暴露去敏感化 Provider / Circuit 只读状态和最后更新时间（如实际必要）。
- [ ] 用 UI PRD 完成 Logs / Traces / Pricing / Providers 交互联动。

**Phase D — 工程健壮性和可选扩展**

- [ ] 做 SQLite 读写/归档压力基准、启动离线降级和多实例说明。
- [ ] 完善 Webhook Best-effort 监控。
- [ ] Durable Outbox / 全局协调只在有明确需求时启动独立 RFC。

---

## 14. 自动化测试规范（接近可执行的场景表）

### 14.1 请求计数与失败路径

| Case | 上游模拟 | 期望逻辑请求 | 期望 Attempts | 期望结果 |
|---|---|---:|---:|---|
| T-001 | 直接成功 | 1 | 1 | 最终成功、一次有效计量 |
| T-002 | 同候选第一 Key 429，第二 Key 成功 | 1 | 2 | 最终成功，失败 Attempt 可追踪 |
| T-003 | 第一候选 5xx、第二候选成功 | 1 | 2 | 最终成功，fallback 语义准确 |
| T-004 | 401（非 429 的 4xx） | 1 | 1 | 不做模型级重试（按既定分类） |
| T-005 | 多候选均超时 | 1 | ≤ 配置上限 | 有界终止，未完成费用未知 |
| T-006 | 流式已发业务内容后上游断连 | 1 | 不可自动重放 | 最终错误/部分响应明确 |
| T-007 | HALF_OPEN 探针中途 Abort | 1 | 实际尝试数 | release，回 OPEN，不计成败 |

实际 Attempt 数会受候选池和配置约束，上表为测试场景的特定模拟配置，不代表默认运行时次数。

### 14.2 成本与归档性质测试

- [ ] `0`、`undefined`、`null`、无 Usage、准确零费用、估算缺失语义严格区分。
- [ ] 多个极小价格相加，与微美元事件总和在规范定义下完全一致。
- [ ] 单条事件写入一次；重复事件 ID 幂等、断电重试、并发提交不产生双重费用。
- [ ] Provider `exact` 成本覆盖优先级正确，不改变既有历史事件。
- [ ] 分层折叠验证请求数、Token、金额上下界保持一致。
- [ ] gzip 归档校验错误拒绝修剪；修剪成功后聚合一致且明细缺失被正确表达。

### 14.3 并发/时钟测试

- [ ] `failureThreshold` 边界：2→3 次失败状态变化、冷却 29,999→30,000ms（按图示默认）。
- [ ] `now` 假时钟注入，无真实等待；`acquire` 100 个并发同健康键最多一探针。
- [ ] `adaptive_qos` 与默认模式按各自健康键粒度运行。
- [ ] `release` 不清除历史失败且不会使供应商被误判为健康。
- [ ] 跨实例各自独立的状态不被 API 标成全局协调结果。

### 14.4 安全与权限测试

- [ ] 只读凭据调用 Admin API 拒绝；跨 appId/组织查询与写入拒绝越权。
- [ ] 明文 API Key 不出现在 SQLite、请求日志、异常堆栈、浏览器响应和下载报表。
- [ ] Webhook 签名成功/失败/重放（按已采用协议）得到一致结果。
- [ ] Embed/跨域/反代部署下的 Origin、CORS、Cookie/Token 行为符合最终威胁模型。

---

## 15. 发布门禁与回滚策略

建议把发布门禁与**测试/规范是否通过**绑定，而不是与 PR 数量、代码行数或是否引入新组件绑定：

- **Gate 0 — Evidence**：每个 Issue 都有源码路径、真实调用链、失败用例或明确的改进理由；不存在因图示推断而随意修改的行为。
- **Gate 1 — Correctness**：计费整数不变量、Request/Attempt 语义、SSE 安全、Circuit 状态机测试通过。
- **Gate 2 — Security**：鉴权隔离、秘密脱敏、只读/管理权限边界通过。
- **Gate 3 — Compatibility**：三种接入面、旧配置、已有 SQLite 数据、CLI 和 `/v1` 兼容端点回归通过。
- **Gate 4 — Observability**：HTTP/CLI/Dashboard 数字一致；未知与归档边界没有误导呈现。
- **Gate 5 — Delivery**：架构图、SPEC、接口契约、迁移说明和 E2E/性能基线同步更新。

**数据迁移约束**：所有可能修改事件结构、金额字段或 Provider 持久配置的 PR，必须附：向后兼容规则、空值/旧记录行为、迁移幂等测试、恢复/回滚步骤。对于不可逆迁移，要有备份与恢复演练；不得靠“升级后重新 Seed”替代真实数据迁移策略。

---

## 16. 关键架构决策（建议 ADR 清单）

建议如仓库尚无对应已批准 ADR，再补以下决策，不要重复或覆盖 D1–D9：

1. **ADR-A：Logical Request / Attempt / Usage Event** 的 ID、计数与幂等语义。
2. **ADR-B：CircuitBreaker** 非重试 4xx 的状态转换与按模式健康键。
3. **ADR-C：MicroUSD** 归一边界、上下界、准确账单与 Unknown 成本。
4. **ADR-D：Streaming Commit Point**、取消传播与请求级重试预算。
5. **ADR-E：Runtime / Query / Admin API** 令牌、权限与配置所有权。
6. **ADR-F：Retention / Archive Visibility** 原始明细与聚合保留契约。
7. **ADR-G：Webhook Delivery Guarantees** 现状 Best-effort 与未来可选 Outbox。

每份 ADR 最少包含：上下文、候选方案、选择、放弃方案、代价、兼容性、测试不变量与 UI 可见语义。

---

## 17. 整改完成定义（DoD）

- [ ] 所有 P0 **已验证**问题修复，且「待验证」不再被误列为已确认缺陷。
- [ ] Request/Attempt/Usage、失败分类、健康状态和成本价源有明确单一契约。
- [ ] 三种接入面汇入统一计量实现，正常与失败路径幂等且统计口径一致。
- [ ] 重要金额汇总可在原始事件、折叠与 CLI/API 中精确对账；未知不算零。
- [ ] 所有 HTTP Admin 操作符合权限策略与实际配置持久化规则。
- [ ] SSE 已输出业务内容后不会自动重放；总尝试数与总预算有界。
- [ ] 单探针、默认阈值、模式粒度与取消语义通过确定性测试。
- [ ] 数据保留限制通过 API 显式可见；归档不丢失应该保留的聚合事实。
- [ ] Webhook 当前可靠性承诺与代码/界面一致；可选扩展不破坏零依赖默认路径。
- [ ] 规范、架构图、代码、测试和 Dashboard 的术语同步更新。

**最终要求**：对 Model Infra Kit 的每次模型调用，在「接入 → 鉴权 → 路由 → 实际尝试 → 重试/熔断 → 计量/计价 → 落账 → 聚合/归档 → API/UI」链路上，必须能依据真实记录解释其最终状态、成本与可用的诊断信息。产品界面绝不能表达比底层系统实际掌握的事实更确定的结论。
