# 接口契约（跨 Worker 唯一真相）

> 多个 Worker 并行时，**签名以此文件为准**。要改先改这里，并在交证里写明。

已存在（T01，勿改签名）：

```ts
// src/types.ts
ProviderConfig, ProviderRecord, ProviderPreset, ProviderStatus
ModelInfo, ModelCapabilities, ModelPricing, ModelSource
TokenUsage { input; output; cacheRead; cacheWrite; reasoning }
CostInfo { usd; low; high; basis; source; pricingModel?; providerId? }
ProviderConfig.apiKeyRef?: string | string[] // one ref, comma-separated refs, or ref array; only references are stored
ModelRequest { model?; messages: ModelMessage[]; system?; tools?: ToolSet; temperature?; maxTokens?; headers?; tags?; sessionId?; traceId?; fallbackChain?: string[] | false; reasoningTimeoutMs?: number; media?: MultimodalUsage; signal? }
  // EVO-G75：`tags?: Record<string, string>` 是宿主自定义的**归属标签**（如
  // `{ feature: "quant-backtest" }`）。值入库前经 `sanitizeTags()` 归一化 + `redactDeep()`
  // 脱敏；非对象/异常值一律按既定策略处理，**绝不抛错**（见「EVO-G75」节）。
  // 它是成本归属维度，**不是身份**：不做权限、配额、多租户、访问控制。
ModelResponse { text; toolCalls; finishReason; usage; cost; provider; model{requested,actual}; latencyMs; firstTokenMs?; steps? }
StreamEvent（text_delta | tool_call_delta | tool_call_complete | step_finish | usage | finish | error）
UsageEvent, UsageSummary, UsageBucket, UsageTrendPoint, UsageQuery, UsagePage
UsageTraceGroup, UsageTraceGroupBy
ModelInfraConfig, BudgetConfig, BudgetStatus, BudgetPeriod
checkBudgetStatus(usage, config, now?)

// src/catalog/
ModelMetadata, ProviderModelBinding, ModelFilter, CatalogModelCapabilities
ModelInfra.catalog.list(filter?) / get(modelId) / assertCapability(modelId, capability)
ModelInfra.catalog.resolveEndpoint(modelId, providerId) / listBindings(filter?)

// src/errors.ts
ModelInfraError, isModelInfraError, toModelInfraError, ModelInfraErrorCode

// src/credential/store.ts
CredentialStore { parse; resolve; tryResolve; set; delete; list; describe }

// src/store/database.ts
Store.open({ path?, driver?, onWarn?, trashDir?, maxIntegrityCheckBytes? }) → Store { providers; models; pricing; pricingCache; usage; settings; driver; close() }
```

---

## T02 — `src/registry/` + `src/ai/`

```ts
// src/registry/presets.ts
export const PROVIDER_PRESETS: readonly ProviderPreset[]
export function getPreset(id: string): ProviderPreset | undefined

// src/registry/registry.ts
export interface ResolvedProvider {
  record: ProviderRecord
  /** 解析到的密钥；`null` 只在 `apiKeySource === "none"` 时出现。 */
  apiKey: string | null
  /** F01 新增：密钥来源，让宿主能区分「不需要密钥」与「忘了配密钥」。 */
  apiKeySource: "ref" | "env" | "none"
  baseUrl?: string
  protocol: Protocol
  npmPackage: string
}
export interface ProviderRegistryDeps {
  store: Store
  credentials: CredentialStore
  appId: string
  onWarn?: (message: string, error?: unknown) => void
}
export class ProviderRegistry {
  constructor(deps: ProviderRegistryDeps)
  list(): ProviderRecord[]
  get(id: string): ProviderRecord | null
  add(config: ProviderConfig): ProviderRecord        // 未给 protocol 时按 preset 补全
  remove(id: string): boolean
  setEnabled(id: string, enabled: boolean): void
  resolve(id: string): ResolvedProvider              // 缺失抛 PROVIDER_NOT_FOUND / CREDENTIAL
  defaultModel(): string | null                      // 形如 "deepseek:deepseek-chat"
  setDefaultModel(ref: string): void
  seed(configs: ProviderConfig[]): void              // 幂等，已存在则跳过
}

// src/ai/bridge.ts
export interface AiBridgeDeps { registry: ProviderRegistry; onWarn?: (m: string, e?: unknown) => void }
export interface AiBridge {
  /** 解析成 AI SDK 的 LanguageModel，协议由 provider.protocol 数据映射决定 */
  languageModel(providerId: string, modelId: string): Promise<LanguageModel>
  /** 连接测试：一次最小调用或模型列表探测 */
  test(providerId: string): Promise<ProviderStatus>
  /** 模型发现，成功时返回 provider_api 来源的 ModelInfo[] */
  discoverModels(providerId: string): Promise<ModelInfo[]>
}
export function createAiBridge(deps: AiBridgeDeps): AiBridge
```

## T03 — `src/pricing/`

```ts
// src/pricing/service.ts
export interface PricingDeps { store: Store; cacheDir?: string; onWarn?: (m: string, e?: unknown) => void }
/**
 * T03 追加的注入口（可选，向后兼容）：用于离线测试与多实例。
 * 指挥已批准——没有它们就无法在断网条件下证明 archive 兜底与 cacheDir 不重复下载。
 */
export interface PricingServiceDeps extends PricingDeps {
  catalog?: import("llm-pricing").PricingCatalog
  fetch?: typeof globalThis.fetch
  autoSync?: boolean
}
export interface PricingState {
  status: "fresh" | "stale" | "error"
  loadedAt?: number
  source?: string
  lastError?: string
}
export interface EstimateInput { model: string; providerId?: string; at?: number; usage: Partial<TokenUsage> }
export interface PricingSyncOptions { force?: boolean; dryRun?: boolean }
export interface PricingSyncResult extends PricingState { syncedModels: number; updatedModels: number; dryRun: boolean }
export class PricingService {
  constructor(deps: PricingServiceDeps)
  /** 先读 SQLite 价格缓存，再在后台刷新上游；不会等待网络。 */
  init(): Promise<PricingState>
  refresh(): Promise<PricingSyncResult>
  sync(options?: PricingSyncOptions): Promise<PricingSyncResult>
  state(): PricingState
  estimate(input: EstimateInput): CostInfo
  /** `facts` 透传给 llm-pricing，用于取到长上下文分档 / 思考模式的卡（F02 增量）。 */
  priceFor(model: string, at?: number, facts?: import("llm-pricing").RequestFacts): ModelPricing | null
  setOverride(o: { modelId: string; inputPerM?: number; outputPerM?: number; cacheReadPerM?: number; cacheWritePerM?: number; displayName?: string }): void
  removeOverride(modelId: string): boolean
  listOverrides(): PricingOverride[]
  /** llm-pricing 的 pricingCandidates 透传，供 UI 展示匹配候选 */
  candidates(model: string): string[]
}

export interface ModelPricingTier {
  modelId: string
  providerId: string
  source: "builtin" | "synced" | "manual"
  version: number
  updatedAt: string
  rates: {
    inputMicrosPerMillion: number
    cachedInputMicrosPerMillion?: number
    cacheWriteMicrosPerMillion?: number
    outputMicrosPerMillion: number
    reasoningOutputMicrosPerMillion?: number
    longContextThresholdTokens?: number
    longContextInputMultiplier?: number
    longContextOutputMultiplier?: number
  }
}
```

## T04 — `src/usage/service.ts`

```ts
export interface UsageServiceDeps {
  store: Store
  appId: string
  enabled: boolean
  onEvent?: (event: UsageEvent) => void
}
export class UsageService {
  constructor(deps: UsageServiceDeps)
  record(event: Omit<UsageEvent, "appId"> & { appId?: string }): boolean
  summary(query?: UsageQuery): UsageSummary
  /** G101：读取一个 UTC `[from, to)` 窗口的整数微美元总额；只读。 */
  budgetTotals(from: number, to: number): import("./usage/budget.js").BudgetUsageTotals
  /**
   * G74 追加（展示用）：区间内**没有解析到价格**的请求/token 占比与按模型明细。
   * 只读 `usage_events`（rollup 表不存 `pricing_source`，故 ratio 的分子分母都只
   * 覆盖明细行）；不参与任何成本合计，不改变 `summary()` 的任何数字。
   * `Provider` 回传的账单真值（`pricing_source="provider"`）**已定价**，不计入。
   */
  unpricedCoverage(query?: UsageQuery): UnpricedCoverage
  /**
   * G78 追加（纯函数，无查询、无状态）：由一个 `summary()` 与同一区间的
   * `unpricedCoverage()` 推出**成本总额的确定性**。
   * `costUsd/low/high` 只是**已记录的**金额之和，未定价请求按 0 入账、不会撑开区间，
   * 于是 16.7% 未定价时仍打印 `0.0175 – 0.0175`——把"未知"呈现成"精确"（R232-F2）。
   * 该函数不改任何数字、也不插值，只返回 `costLowerBoundOnly`（读作"至少"）、
   * `unpricedRequests`、`unmeasuredRequests`（已折叠进 rollup、价格来源不可考的请求数）。
   * CLI 与 HTTP 出口共用它，两边口径不得各写一套。
   */
  costBound(summary: Pick<UsageSummary, "requests">, coverage: UnpricedCoverage): CostBound
  trends(query?: UsageQuery, bucket?: "day" | "hour"): UsageTrendPoint[]
  byProvider(query?: UsageQuery): UsageBucket[]
  byModel(query?: UsageQuery): UsageBucket[]
  /**
   * G75 追加：按**宿主归属标签**切分成本（一桶 = 一个 `key=value` 对，按成本降序）。
   * 明细行 + 已折叠的 `usage_tag_rollups`（按天汇总的标签维度，随明细同一事务写入）。
   * 机器写入的键不计入桶：G73 的两个真实对账键 `provider_cost_raw` /
   * `provider_cost_status`（**没有前缀**）与预留的 `_mik_` 前缀约定
   * （`RESERVED_TAG_KEYS` / `isReservedTagKey`）。**只读展示**，不改任何既有数字。
   * 语义见「EVO-G75」节；它**不是**身份，绝不用于权限/配额/隔离判断。
   */
  byTag(query?: UsageQuery): UsageBucket[]
  /** G96：按 traceId 或 sessionId 聚合；成本与 token 总数包含保留期内已折叠的每日归档。 */
  traces(query?: UsageQuery, groupBy?: "trace" | "session"): UsageTraceGroup[]
  /**
   * G64 追加：返回**该库里所有写过量用的 `app_id`**（升序）。本类唯一不经
   * `scoped()` 的读取——它问的就是「还有谁在写这个文件」，加 appId 过滤会把答案抹掉。
   * 同时读 `usage_events` 与 `usage_daily_rollups`（否则历史已折叠的 app 会凭空消失）。
   * **只返回 id**，不含计数/成本/明细，故不披露 `usage summary --app <other>` 之外的信息；
   * 属**只读提示**，绝不作为权限、配额或隔离判据（见「EVO-G64」节）。
   */
  appsInDatabase(): string[]
  query(filter?: UsageQuery): UsagePage
  /**
   * F03 收紧：默认只返回本实例 appId 的事件（多 app 共库时不得互相读到明细）；
   * 传 `{ appId: "" }` 显式关闭过滤（调试用）。
   */
  get(requestId: string, options?: { appId?: string }): UsageEvent | null
  /** 全局维护操作：会把**所有 app** 的过期明细折进 rollup 并删除，不受 appId 限制。 */
  rollupAndPrune(now?: number, retentionDays?: number): number
  clear(): number
}
```

## T05 — `src/hub.ts` + `src/fetch.ts`

```ts
export class ModelInfra {
  /**
   * F10：目录加载是有界等待（5s 上限），超时后照常启动并 `onWarn` 一次，
   * `pricing.state().status` 自然降级为 stale/error。绝不无限阻塞（规则 6）。
   */
  static init(config?: ModelInfraConfig): Promise<ModelInfra>
  readonly appId: string
  /** 供 OpenAI 兼容客户端使用；T07 起服务后由 setBaseUrl() 注入真实端口。 */
  readonly baseUrl: string
  readonly fetch: typeof fetch
  /** T05 追加并经指挥批准：T07 的 provider test 端点需要它。 */
  readonly ai: AiBridge
  readonly providers: ProviderRegistry
  readonly pricing: PricingService
  readonly usage: UsageService
  /** G101：读取 UTC 日/月软预算状态；只读 advisory，不会阻断请求。 */
  budgetStatus(now?: number): import("./usage/budget.js").BudgetStatus
  /** Bundled model facts and explicit provider endpoint bindings; no network sync. */
  readonly catalog: ModelCatalogService
  readonly models: {
    list(providerId?: string): ModelInfo[]
    get(ref: string): ModelInfo | null
    refresh(providerId: string): Promise<ModelInfo[]>
  }
  /** 把 baseUrl 指向真实监听端口（T07 起服务后调用）。 */
  setBaseUrl(url: string): void
  /** 解析 `provider:model` / 裸名 → 具体 provider 与模型。 */
  resolveModel(ref?: string): { providerId: string; modelId: string; ref: string }
  /** 后台目录同步的 promise；init 不等它。 */
  readonly catalogSync: Promise<void>
  generate(request: ModelRequest): Promise<ModelResponse>
  stream(request: ModelRequest): AsyncIterable<StreamEvent>
  /** F08：等待在途目录同步（上限 5s）后再关闭 store，可重复调用。
   *  F10：close() 之后调用任何其它公开成员，一律抛 `ModelInfraError`（code `STORAGE`），不再冒裸 `ERR_INVALID_STATE`。 */
  close(): Promise<void>
}

/** T05 追加（指挥批准）：全部可选，向后兼容。 */
export interface ModelInfraOptions extends ModelInfraConfig {
  baseUrl?: string
  maxRetries?: number
  fallbackChain?: string[]
  reasoningTimeoutMs?: number
  keyCooldownMs?: number
  pricingCatalog?: import("llm-pricing").PricingCatalog
  pricingFetch?: typeof globalThis.fetch
  /** G01 追加：显式价格目录源；HTTP 面 sync 前用 SSRF guard 校验（经 `pricing.outboundUrls()`）。 */
  pricingSources?: import("llm-pricing").PricingSource[]
  /** 设为 false 禁止本次实例启动时自动异步刷新价格；默认 true。 */
  pricingAutoSync?: boolean
  onUsage?: (event: UsageEvent) => void
}
```

`ModelRequest.model` 解析规则：`"provider:model"` 直接拆；裸模型名用 `providers.defaultModel()` 的 provider；都缺失抛 `INVALID_REQUEST`。

### EVO-G95 — 弹性路由与凭据池

- `ModelRequest.fallbackChain: false` disables both request and host fallback chains; an empty array still inherits the host chain. `ModelRequest.fallbackChain` 先于 `ModelInfraOptions.fallbackChain` 尝试；主模型失败后依序尝试显式 `provider:model` 备选。仅 429、超时、连接与上游 5xx 可触发模型降级；流式调用只有在尚未输出文本或工具调用时才切换，避免重复内容。
- `reasoningTimeoutMs`（请求字段优先，其次实例配置）限制流式首个可见输出等待；非流式请求将其作为单次调用超时。OpenAI 兼容端点接受 `reasoning_timeout_ms` 或 `x-mik-reasoning-timeout-ms`。SSE 若首事件超过 heartbeat 周期，会先发 `: thinking` 注释并继续按间隔发送注释心跳。
- Provider `apiKeyRef` 支持单引用、逗号分隔引用或引用数组。每次解析按轮询选择一个可用引用；429 后该引用在内存冷却（默认 30 秒，`keyCooldownMs` 可改）。数据库仍只保存 credential reference，解析出的 secret 不进入池状态、日志或用量标签。
- 每次实际尝试各记录一条用量行；通过模型或 Key 轮换成功的行以 `tags.is_fallback = "true"` 标记。失败尝试保持 `status="error"` 与缺失成本状态。

## T06/T07 — `src/cli/` 与 `src/server/`

CLI 子命令：`init` / `serve` / `dashboard` / `provider add|list|remove|test` / `models` / `pricing sync|set|list` / `usage summary|trends|logs|export`。

`mik models catalog [--json]` 列出内置的标准模型事实与供应商端点映射；`mik models` / `mik models list` 仍查询本地发现的供应商模型。

`mik serve` 标志（T14）：`--port <n>` / `--host <h>` / `--token <t>` / `--cors <origin>`。`--cors` 接受 `'*'`（任意源）或 `https://...`（固定源，映射到 `createServer({ cors: { origin } })`），非法值直接报错；默认关闭。T14 同时也暴露了 `createServer({ cors })` 已是既有能力（`boolean | CorsOptions`）。

HTTP API（全部挂在 `/api`，OpenAI 兼容端点挂 `/v1`）：

```
GET  /api/health
GET  /api/budget/status       （G101：整数微美元日/月软预算状态；只读、绝不阻断请求）
GET  /api/providers            POST /api/providers
PATCH/DELETE /api/providers/:id
POST /api/providers/:id/test
GET  /api/providers/:id/models   POST /api/providers/:id/models/refresh
GET  /api/catalog              （内置标准模型事实 + 供应商端点绑定，不访问上游）
GET  /api/models               GET /api/models/:ref
POST /api/models/:ref/ping      PUT /api/models/:ref/default
GET  /api/pricing              PUT /api/pricing/:modelId   POST /api/pricing/sync
DELETE /api/pricing/:modelId   （T07 追加并经指挥批准：看板需要撤销手动价）
GET  /api/usage/summary|trends|by-provider|by-model|traces|logs|logs/:id
       （G78：`/api/usage/summary` 的响应在 `summary` 上**追加**三个字段，
         `costLowerBoundOnly` / `unpricedRequests` / `unmeasuredRequests`，
         由 `costBound()` 推出。既有字段与数字一个都没变；加了它们之后，
         `costLowUsd === costHighUsd` 才不再被机器读者当成"精确值"。）
       （G89：`summary.costUsd` 已标注 `@deprecated`——它是点估计，
         有未定价/已折叠请求时两侧都不是界。替代写法与迁移样例见文末
         **EVO-G89** 节；字段**继续填充**，本 HTTP 面的字段与数值一个都没改。）
       （G92：趋势点与按供应商/模型分桶**追加** `costLowUsd` / `costHighUsd`；
         `costUsd` 保留原值兼容旧消费者，三种金额都按整数微美元聚合。）
GET  /api/events               （SSE：usage.recorded / catalog.updated / pricing.updated）
POST /api/usage/events         （F19 新增：宿主自己调模型，把用量上报进来）
GET  /openapi.json
POST /v1/chat/completions      GET /v1/models
```

**EVO-G103（1.1.0）开发与鉴权默认**：无 Token 时仅本地回环请求放行，CLI 明确告警；非回环请求要求配置 Token。配置 Master Token 或作用域 Token 时，除 `GET /api/health` 与 CORS 预检外需要 Bearer。越权返回精确的 403 `{"error":{"message":"insufficient_scope","code":"FORBIDDEN"}}`，无效凭据返回 401。供应商管理/配置/探测要求 admin；作用域详情见文末 EVO-G103。该用户授权策略取代 G01 的无 Token 写入一律 401。另：`readJsonBody` 只接受 `application/json`（含 `+json`、charset），否则 415；`provider test` / `models refresh` / `pricing sync` 出站前校验 URL（仅 http(s)，禁链路本地/云元数据地址如 169.254.0.0/16、fe80::/10、0.0.0.0、`[::]`，loopback 127.0.0.0/8、`::1` 放行），违规 400「INVALID_REQUEST」。

### `POST /api/usage/events`（F19）

宿主不想改调用链、只想统一记账时用。**鉴权**与其它端点一致（设了 token 就要求 `Bearer`）。**计量防伪造**：绑定 Token 时 appId 缺省取绑定值，单条/批量越界整单 403；未绑定 Token 时缺省取 hub.appId，保留原有上报伪造 400 行为。

请求体：单条，或 `{ events: [...] }` 批量（单次上限 500 条）。

```ts
{
  requestId: string            // 必填，幂等键
  ts?: number                  // 毫秒时间戳，缺省取服务端当前时间
  providerId: string           // 必填
  modelRequested?: string
  modelActual?: string         // 计价用它
  usage: {                     // 必填；非负整数，缺省字段按 0
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  }
  cost?: { usd: number }       // 可选；给了就用你的，不给则服务端按 pricing 估算
  latencyMs?: number
  firstTokenMs?: number
  status?: "ok" | "error"      // 默认 "ok"
  errorCode?: string
  isStreaming?: boolean
  sessionId?: string
  traceId?: string
  appId?: string               // 只能等于有效 appId；绑定 Token 时越界整单 403，未绑定时单条越界 400
  tags?: Record<string, string> // 值经 redactDeep 脱敏后入库
}
```

响应：`{ accepted: number, duplicates: number, rejected: Array<{ index: number; reason: string }> }`

规则：`requestId` 重复 → 计入 `duplicates` 且不覆盖已有行；未给 `cost` 时服务端用 `pricing.estimate({ model: modelActual, at: ts, usage })` 计价并落 `pricingSource`；落库 `source` 固定为 `"report"`。

---

## F16 — 附加公共面（additive）

> 来源：R02 的 S8（契约漂移）。以下成员**已经由 `src/index.ts` 或公开 HTTP 面导出**，此前没写进本文件。
> 本卡只补文档与测试、**不改任何 `src/**`**，所以「稳定 / `@internal`」标签记在本节；`src/` 内目前没有 `@internal` JSDoc（R02 已确认零命中），要把标签落进代码需另开卡。
>
> 约定：**稳定**＝公共契约，改签名/语义必须先改本文件（规则 5）；**`@internal` 风格**＝为宿主便利而存在，不承诺 semver，可在次版本调整。

### 稳定 — 模型引用与协议表

```ts
// src/registry/registry.ts（ProviderRegistry 的模块级导出）
export const MODEL_REF_SEPARATOR = ":"                 // 稳定
export const DEFAULT_MODEL_SETTING = "default_model"   // 稳定：settings 表里存默认 `provider:model` 的键
/** 稳定。按**第一个** `:` 切分并 trim；任一侧为空（`:x` / `x:` / 无分隔符）→ null。 */
export function splitModelRef(ref: string): { providerId: string; modelId: string } | null
// hub.resolveModel()、server 的 /v1/chat/completions、ai/bridge 都走它——不要在调用点另写解析。

// src/registry/presets.ts
export const PROTOCOL_PACKAGES: Record<Protocol, string>  // 稳定：protocol → `@ai-sdk/*` 包名，唯一真相（预设表与 bridge 共用）
export function packageForProtocol(protocol: Protocol): string | undefined  // 稳定：上表的读取器

// src/ai/protocols.ts
export const SDK_PROTOCOLS: Record<Protocol, SdkProtocol>          // 稳定：由 PROTOCOLS 派生的视图（勿单独编辑），已公开导出
export const MODEL_LIST_PROTOCOLS: Record<Protocol, ModelListProtocol>  // 稳定：由 PROTOCOLS 派生的视图（勿单独编辑），已公开导出

// src/ai/protocols.ts — 模块级导出，**未进公共面**（`src/index.ts` 不 re-export，`dist` 导出数仍为 30）
export const PROTOCOLS: Record<Protocol, ProtocolSpec>             // **唯一源表**（protocol → { sdk, list }），G10a 起
export interface ProtocolSpec { sdk: SdkProtocol; list: ModelListProtocol }
export interface DiscoveredModel {
  modelId: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Partial<ModelCapabilities>
}
// 稳定：供应商自身列表端点的归一化结果，ai.discoverModels() 的元素类型。
/** 稳定签名；行为依赖可选 peer：调用时才 `import(npmPackage)`。 */
export function loadProviderFactory(protocol: Protocol): Promise<ProviderFactory>
```

- `loadProviderFactory()` 失败面：未知 protocol → `PROVIDER`；peer 未安装 → `PROVIDER`，文案含 `npm i <pkg>`；包在但没有期望导出 → `PROVIDER`。三种都不抛裸 `ERR_MODULE_NOT_FOUND`。
- `PROTOCOLS` 是「协议是一等公民」（规则 3）的落点：每个协议一行；`SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS` 都是它的派生视图（`Object.fromEntries` 投影），**不要直接编辑这两张派生表**——改了会在下次投影时被覆盖。它们不是不可变对象（例如 `test/ai-bridge.test.ts` 会临时改写 `SDK_PROTOCOLS.openai` 来模拟 peer 缺失，随后还原），「勿编辑」是约定而非类型约束。任何 provider 差异只能进 `provider.meta`。

### 新增内置协议配方（EVO-G11 / G10a）

加一个内置协议要改 **4 处编译期落点**，按下表顺序走完即可（顺序重要：类型先行，后面几处的 `Record<Protocol, …>` 才会立刻报缺项，漏一处 `tsc` 就红）：

> **另有两处「镜像/文案」落点不会被 `tsc` 抓住**（EVO-G11 评估 B2），加协议时记得顺手同步，否则帮助文案与看板类型会**静默过期**：
> - `src/cli/args.ts` 的 `FLAG_PROTOCOL.description` 把协议名单**写死在字符串里**（`mik provider add --help` 会展示）；
> - 跨包镜像 `apps/dashboard/lib/types.ts` 的协议字面量。

1. **协议类型联合** — `src/types.ts` 的 `Protocol` 加成员（如 `"mistral"`）。这是唯一的类型真相，其余三处都挂在它下面。
2. **协议源表** — `src/ai/protocols.ts` 的 `PROTOCOLS` 加**一行**：`{ sdk: { npmPackage, factoryExports, factoryOptions }, list: { url, headers, parse, defaultCapabilities } }`。`SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS` 会自动派生，**不需要动**。
3. **包名表** — `src/registry/presets.ts` 的 `PROTOCOL_PACKAGES` 加同一包名（第 2 步的 `npmPackage` 通常就取它）；`packageForProtocol()` 与 `registry` 的 npmPackage 兜底共用此表。
4. **预设表（可选，仅当要发默认预设）** — `src/registry/presets.ts` 的 `PROVIDER_PRESETS` 加预设条目（`id` / `protocol` / `baseUrl` / `envKey`）。如果只允许用户自带 `baseUrl`，这步可跳过。

补完后跑：`pnpm --filter model-infra-kit typecheck`（`Record<Protocol, …>` 会替你抓漏项）→ `pnpm --filter model-infra-kit test`（`test/registry.test.ts`、`test/ai-bridge.test.ts`、`test/module-graph.test.ts` 会覆盖协议表一致性与目录无环）。可选 peer 记得同时加进 `packages/mik/package.json` 的 `peerDependencies` + `peerDependenciesMeta`（optional）。

### 稳定 — fetch 适配器

```ts
// src/fetch.ts
export interface ForwardedCall { requestId; at; providerId; modelRequested; modelActual; usage; latencyMs; firstTokenMs?; status: "ok" | "error"; errorCode?; isStreaming; providerCost?: ProviderCostReading }
export interface FetchTarget { providerId: string; modelId: string; requested: string }
export interface MikFetchOptions {
  resolveProvider(providerId: string): ResolvedProvider   // 必需；缺失抛 PROVIDER_NOT_FOUND / CREDENTIAL
  resolveModel(model?: string): FetchTarget               // 必需；裸模型名走默认 provider
  onCall(call: ForwardedCall): void                       // 必需；**必须不抛错**（hub 侧已包）
  baseUrl(): string                                       // 必需；每次调用时读取
  fetch?: typeof globalThis.fetch                         // 可选：传输覆盖（测试）
  now?: () => number                                      // 可选
  requestId?: () => string                                // 可选
}
export function createMikFetch(options: MikFetchOptions): typeof fetch
export function readOpenAiUsage(payload: Record<string, unknown> | null): { usage: TokenUsage; model?: string; cost?: ProviderCostReading } | null

// EVO-G73（新增，`src/index.ts` 已 re-export）：端点回传计费额的读数
// 判别联合；`absent` 表「没报」，与「报了 0」不同（SPEC §4）。见本文件 EVO-G73 节。
export type ProviderCostReading =
  | { kind: "absent" }
  | { kind: "accepted"; micros: number; raw: string }
  | { kind: "rejected"; raw: string; reason: string }
```

- `createMikFetch()` 让现有 OpenAI 兼容客户端带计量：`new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })`。请求体的 `model` 决定路由，凭据由 provider 协议附加；**调用方自带的密钥不转发**；响应按字节原样返回（只读 clone）。
- `readOpenAiUsage()` 兼容 `prompt_tokens`/`input_tokens`、`cached_tokens`/`prompt_cache_hit_tokens`/`cache_read_tokens`、`cache_creation_tokens`/`cache_write_tokens`、`reasoning_tokens`；**一个字段都读不到时返回 `null`**（而不是全 0 的 `TokenUsage`），调用方据此区分「上游没报 usage」与「确实为 0」。
- EVO-G73：`ForwardedCall.providerCost`（也就是 `readOpenAiUsage().cost` 的来源）是端点回传计费额的读数。`kind: "absent"` 表示端点**没报**——此时 hub 仍走既有目录估算，`tags` **不写任何键**，行为与 G73 之前逐字一致；`accepted` 才按端点账单记账。类型与保留键的定义在下文「EVO-G73」节，两处不重复定义。

### 稳定 — `X-ModelHub-Provider` 请求头（HTTP 面）

```
POST /v1/chat/completions
X-ModelHub-Provider: <providerId>
```

- 只在 `POST /v1/chat/completions` 生效（`server/openai.ts:381`）；`GET /v1/models` 不读它。
- `model` 已是 `provider:model` → 以 `model` 为准；裸模型名 → 用该头拼成 `provider:model`。
- 给了头但 `model` 为空：取 `providers.defaultModel()` 的模型 id + 该 provider；**没有默认模型时 400 `INVALID_REQUEST`**（文案点名 `X-ModelHub-Provider`）。
- 它不是凭据通道：provider 密钥仍只来自 credential store，头里放什么都不参与鉴权。

### `@internal` 风格 — 不承诺 semver

```ts
// src/usage/service.ts — UsageService.currentAppId / UsageService.isEnabled
get currentAppId(): string   // 本实例 appId；usage 查询默认按它过滤，`{ appId: "" }` 才放开
get isEnabled(): boolean     // 与构造入参 `enabled` 同值；false 时 record() 直接返回 false
```

- 两个只读 getter 是宿主便利（源码注释即写明 "Additive convenience, not part of the contract"），用于日志/自检/看板展示。
- **不要**用它们做权限或隔离判断：多 app 隔离由 `UsageService` 内部保证（见上文 `get()` 语义）。

```ts
// src/cli/i18n.ts — dictFor / hasKey（EVO-G10 裁定：保留 + 标 @internal 风格）
export function dictFor(lang: Lang): Record<string, string>  // @internal 风格
export function hasKey(key: string): boolean                 // @internal 风格
```

- 裁定（EVO-G10 / G30）：**保留，不删**。理由：EVO-G08 已把「11 个导出齐全（只增不减）」写进契约，删除会与既有公开面契约冲突；且二者是宿主做自检/自建管线的便利出口。
- 标签：**`@internal` 风格** — 为宿主便利而存在，**不承诺 semver**，可在次版本调整（含返回值形状）。
- 事实：**`src/` 内无调用方，仅测试与宿主使用**（`i18nKeys()` / `tr()` / `trBoth()` 才是内部实际使用的入口）。
- 未删的替代方案（若未来要删）：需同步改 `docs/interfaces.md` F16 的导出清单、G08 的「11 个导出」计数断言，以及可能的 `src/cli/index.ts` 再导出——成本明确，收益不足，本轮不动。

### 小设置持久化（v0.1.6 新增）— 稳定

CLI 的首次运行向导与 REPL 需要把「界面语言」这类**小设置**落库，故 `ModelInfra` 公开两个薄封装（等价于直读 `settings` 表，但不暴露 Store）：

```ts
/** 稳定。读一个小设置（如 CLI 语言 `cli.lang`）；不存在返回 null。 */
readSetting(key: string): string | null
/** 稳定。写一个小设置；此接口只读不保证语义（键名由调用方约定）。 */
writeSetting(key: string, value: string): void
```

- 仅限「小设置」：界面语言、UX 偏好等；**不要**用它们存密钥（密钥仍走 `api_key_ref`）或大对象。
- 现有约定键：`cli.lang` = `"zh" | "en"`（`src/cli/i18n.ts` 的 `Lang`）。
- CLI 侧读取顺序（EVO-G08 更新）：`MIK_LANG` 环境变量 → `cli.lang` 设置 → **OS locale** → `en`（兜底，不再是 `zh`）。
  - OS locale 探测顺序：`LC_ALL` → `LC_MESSAGES` → `LANG` → （Windows）`Intl.DateTimeFormat().resolvedOptions().locale`。
  - 映射：`zh*` → `zh`；其余（含 `en_*`、`fr_FR`）→ `en`；畸形值（`C` / `POSIX` / 空串）视为无线索 → `en`。
  - 不支持的 `MIK_LANG`（如 `xx`）视为**未设置**，继续按 stored → locale → `en` 解析，不抛错、不落到 `zh`。
  - 显式 `MIK_LANG=zh` 或已存 `cli.lang=zh` 时结果恒为 `zh`（行为与旧版完全一致）。
- 实现与接线：`src/cli/i18n.ts` 提供 `resolveLang(envValue, storedValue, options?)`（`options.locale` 可注入，测试不依赖真实环境）与 `resolveCliLang(env, stored)`（= `resolveLang` + `{ env, platform: process.platform }`）；`init.ts`、`repl.ts` 统一调用后者，**无硬编码默认语言**。
- 分文件：每语言一个文件（`src/cli/i18n/zh.ts`、`src/cli/i18n/en.ts`，扁平 `Record<string, string>`），`i18n.ts` 合成 catalog；键集合对等由 `test/i18n.test.ts` 强制。某语言缺键时 `tr` 回退另一语言（优先 `en`），**绝不回显 key**。

---

## 配置真相（EVO-G05 补充）

> 目的：把「配置从哪来、谁压过谁」写成契约唯一真相。此前只存在于 `cli/context.ts:140-143` 与 `hub.ts:317` 的注释里，且两条路径的优先序**不同**。

### 配置优先级总表

| 层 | CLI 用法（`mik <cmd>`） | 库用法（`ModelInfra.init()`） |
|---|---|---|
| 1（最高） | 命令行 flag（`--db`/`--app-id`/`--config`/`--cache-dir`） | 显式入参 `config.*` |
| 2 | 环境变量（`MIK_*`） | 环境变量（`MIK_APP_ID`） |
| 3 | `mik.config.json` | ——（库不读该文件） |
| 4（最低） | 内置默认（`~/.model-infra-kit/usage.db`、`appId="default"`） | 内置默认 |

- 代码位置：CLI 见 `src/cli/context.ts:140-143`；库见 `src/hub.ts:317`（`config.appId ?? process.env.MIK_APP_ID ?? DEFAULT_APP_ID`）。
- **差异是有意设计**：库宿主显式传参应压过环境变量（显式 > 隐式）；CLI 的 flag 同样压过 env。两条路径的「env vs 文件/默认」不可比，因为库不读 `mik.config.json`。
- **settings 表**（`cli.lang` 等小设置）只由 CLI 的 REPL/向导读写（`hub.readSetting`/`writeSetting`），优先级低于环境变量、高于系统语言：`MIK_LANG` → `cli.lang` → `OS locale` → `en`（见上文「小设置持久化」节）。
- **`budget`（EVO-G07/G101）**：库调用时属 config 入参层，即**最高优先级**；CLI 也可从 `mik.config.json` 读取同一结构（没有独立环境变量）。显式库入参仍只有「显式入参 → 不配置」两种状态，不存在被覆盖的情形。
- `mik.config.json` 承载 `appId` / `db` / `cacheDir` / `budget` / `initialProviders`（`src/cli/context.ts`）——改文件**不会**重新播种供应商，`initialProviders` 仅 `mik init` 首次消费；`budget` 每次 CLI 打开上下文时作为只告警配置传给 `ModelInfra.init()`。
  - **`cacheDir`（EVO-G84 / F11 新增）**：`mik init` 在命令行传了 `--cache-dir`（或环境里有 `MIK_CACHE_DIR`）时把该值写进文件；**未传时不写该字段**（既有文件的形状不变，非破坏性）。解析链与 `db`/`appId` 完全一致：`--cache-dir` → `MIK_CACHE_DIR` → `mik.config.json` 的 `cacheDir` → 库内置默认 `~/.model-infra-kit/cache`。此前该 flag 被**静默丢弃**（R232/F11 实测：传了 `--cache-dir` 后文件里只有 `appId`/`db`/`initialProviders`），后续命令仍落回主目录缓存。
  - 已由测试锁定：`packages/mik/test/config-precedence.test.ts`（`appId` 链）、`packages/mik/test/g84-init-guidance.test.ts`（`cacheDir` 落盘 + 读取链 + 收尾指引）。

### 环境变量清单（源码实测，逐个 grep 确认；含 CLI 与库两条路径）

| 变量 | 读取位置 | 语义 |
|---|---|---|
| `MIK_DB` | `cli/context.ts:140`、`cli/commands/init.ts:56` | SQLite 路径（CLI；`--db` 优先） |
| `MIK_APP_ID` | `cli/context.ts:141`、`cli/commands/init.ts:55`、`hub.ts:317` | 账本所属应用 id；多宿主共用一库时用于隔离 |
| `MIK_CONFIG` | `cli/context.ts:75` | `mik.config.json` 的替代路径（`--config` 优先） |
| `MIK_CACHE_DIR` | `cli/context.ts` | 价格目录缓存目录（`--cache-dir` 优先，其次本值，再次 `mik.config.json` 的 `cacheDir`；EVO-G84/F11） |
| `MIK_OFFLINE` | `cli/context.ts:143`（`"1"` 为真） | 完全离线：禁用目录同步与在线价格拉取（flag `--offline` 为 `||` 关系，不是覆盖） |
| `MIK_LANG` | `cli/commands/init.ts:54`、`cli/repl.ts:169`（非 TTY 分支 `cli/repl.ts:162`；解析统一在 `cli/i18n.ts` 的 `resolveCliLang`/`resolveLang`） | CLI/REPL 界面语言 `zh`/`en`；优先于 `cli.lang` 设置。不支持的值（如 `xx`）视为未设置，继续按 `cli.lang` → OS locale（`LC_ALL` → `LC_MESSAGES` → `LANG` → Windows `Intl`）→ `en` 解析 |
| `MIK_SERVER_TOKEN` | `cli/commands/serve.ts:119` | `mik serve` 写端点 token（`--token` 优先）；未设置时写端点默认 401 |
| `MIK_PROVIDER_TIMEOUT_MS` | `ai/bridge.ts:31` | 供应商连接测试 / 模型发现的超时毫秒数（`provider.meta.timeoutMs` 优先） |
| `MIK_BASE_URL` | `hub.ts:408` | 库路径：默认服务基址（供 `hub.baseUrl` 使用） |
| `MIK_DASHBOARD_DIR` | `cli/commands/dashboard.ts:72` | `mik dashboard` 定位看板目录的覆盖点 |

> `MIK_TOKEN` 只出现在 `src/server/index.ts` 的用法示例注释里（宿主自行传给 `createServer({ token })`），**CLI 不读取**。

### `ModelInfraConfig` 字段清单（`src/types.ts`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | `string` | `"default"` | 写入每条用量事件；一库多应用 |
| `db` | `string` | `~/.model-infra-kit/usage.db` | SQLite 路径，或 `:memory:` |
| `providers` | `ProviderConfig[]` | `[]` | 首次运行时注册的供应商（库中已有同 id 时不覆盖） |
| `defaultModel` | `string` | 无 | 请求省略 `model` 时使用的 `provider:model` |
| `syncCatalog` | `boolean` | `true` | 启动时后台同步模型目录（离线 / `--offline` 时关闭） |
| `recordUsage` | `boolean` | `true` | 是否持久化用量事件 |
| `cacheDir` | `string` | `~/.model-infra-kit/cache` | 价格目录缓存目录 |
| `onWarn` | `(message, error?) => void` | 无 | 非致命问题回调（目录同步失败、缺价等） |
| `budget` | `{ usd?: number; window?: "day" \| "month"; onExceed?: "warn"; dailyMicros?: number; monthlyMicros?: number; currency?: "USD" }` | 不配置（= 关闭） | 软预算：**只告警、绝不硬拒绝**；微美元日/月状态可经 `budgetStatus()` 与 HTTP 读取。见下文「EVO-G07 / EVO-G101」 |

该接口与 F16 记录的 `ModelInfraOptions`（`baseUrl`/`maxRetries`/`pricingCatalog`/`pricingFetch`/`onUsage`）共同构成 `ModelInfra.init()` 的入参。

#### `budget`（EVO-G07 / EVO-G101，契约）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `usd` | `number` | 无（兼容旧配置） | 旧版单窗口阈值（美元），必须为**正有限数**；`0`/负数/`NaN`/`Infinity` 视为非法配置 |
| `window` | `"day" \| "month"` | `"day"` | 统计窗口，边界为 **UTC** 日界/月界（`Date.UTC(...)`），不是本地时区 |
| `onExceed` | `"warn"` | `"warn"` | 目前**只支持** `"warn"`；其它取值视为非法配置 |
| `dailyMicros` | `number` | 无 | UTC 自然日配额，必须是正的安全整数微美元；可单独启用只读状态 |
| `monthlyMicros` | `number` | 无 | UTC 自然月配额，必须是正的安全整数微美元；可单独启用只读状态 |
| `currency` | `"USD"` | `"USD"` | 当前只支持 USD；其它值不启用状态计算 |

语义（不可放宽）：

- **只告警，绝不硬拒绝**：不阻断、不排队、不返回 429、不做 RPM/TPM 限流；越阈只经 `onWarn` 发一条消息。
- **每实例每窗口每 appId 最多一次**：同一 `UsageService` 实例内，同一窗口的后续越阈写入不再告警；跨窗口（UTC 日/月界）后累计值归零，可再告警一次。（多实例各自计数、互不知晓。）
- 累计口径为**整数微美元**（`Math.round(usd * 1e6)`，与 SQL 的 `CAST(ROUND(cost_usd * 1000000) AS INTEGER)` 同语义），不做浮点求和。
- 基数：`ModelInfra.init()` 时**一次性**从库汇总「本窗口内本 appId 成本」（`UsageRepository.costMicros()`，detail 行、`[windowStart, now)`），之后靠内存运行值累加；**每次 `record()` 不做全表 SUM**。
- 计数范围：只累计 `event.appId` **严格等于**本实例 `appId` 的事件（不等则整行跳过；init 基数同样只覆盖该 appId）。
- **失败静默（不影响调用与记录）**：未配置 → 零查询零告警；配置非法 → 忽略该配置并经 `onWarn` 提示一次；init 基数汇总失败 → 基数按 0 计（一次 `onWarn`），不抛错；运行期累计异常 → 静默。
- 告警消息含阈值、当前累计、窗口与 appId，且整体过 `redact()`（`packages/mik/src/util/redact.ts`）。

G101 的只读状态计算由 `checkBudgetStatus(usage, config, now?)` 提供，`ModelInfra.budgetStatus(now?)` 直接暴露同一结果。返回结构固定为 `{ currency: "USD", advisory: true, daily, monthly }`；未配置对应配额的周期为 `null`。每个周期的金额字段都是整数微美元：`spentMicros`、`limitMicros`、`remainingMicros` 与 `overageMicros`（超出部分，未超出时为 0），`percent` 是向下取整的整数百分比，状态为 `<80%` 的 `ok`、`80%–99%` 的 `warning` 或 `>=100%` 的 `exceeded`。`advisory: true` 是协议不变式：状态读取不改变记录流程，也不会返回 429 或阻断任何 API 请求。

周期总额读取明细行并加上保留的 `usage_daily_rollups`。明细按 `[from, to)` 的 UTC 毫秒范围过滤；rollup 只保存本地日键，所以当它被纳入 UTC 周期时返回 `historicalAllocationLimited: true`，并报告 `archivedRequests`。`unpricedRequests` 只计仍保留明细的缺价请求；未知的归档价格不猜测、不插值。HTTP `GET /api/budget/status` 返回上述 `BudgetStatus`，沿用服务端既有的鉴权规则（配置 token 时需要 Bearer；未配置 token 时 GET 可读）。

相关实现：`packages/mik/src/types.ts`（`BudgetConfig`）、`packages/mik/src/usage/service.ts`（累计与一次性告警、`windowStart()`/`toMicroUsd()`/`isUsableBudget()`/`budgetBaseMicros()`）、`packages/mik/src/hub.ts`（init 时汇总基数）、`packages/mik/src/store/usage-repository.ts`（`costMicros()`）。口径与排查见 `docs/cost-reconciliation.md`。

## 指挥裁决（R01 评审后，2026-09-09）

| 编号 | 裁决 | 落到哪张卡 |
|---|---|---|
| B1 | `UsageService.get()` **必须**默认按 appId 隔离，`{appId:""}` 才放开 | F03 |
| B2 | `resolve()` 无 `apiKeyRef` 时回退 `preset.envKey`；仍拿不到且 preset 声明了 envKey → 抛 `CREDENTIAL`；`ResolvedProvider.apiKeySource` 标明来源 | F01 |
| S1 | 手动价判定提到 `warm()` 之前 | F02 |
| S2 | `EstimateInput.usage` 改为 `Partial<TokenUsage>`，消除强转 | F02 + 指挥改 types |
| S3 | `setOverride()` 至少给 `inputPerM` 或 `outputPerM`，否则抛 `INVALID_REQUEST` | F02 |
| S4 | `priceFor()` 也 `warm()`；返回里带 `contextTierAbove` / `reasoningMode` | F02 |
| S5 | `record()` 内部 try/catch 包住 `onEvent`，异常交 `onWarn` | F03 |
| S6 | `rollupAndPrune()` 保持全局，但**必须在契约与卡片写明** | F03（仅文档+注释） |
| S7 | providers 表全局共享，`list()` 不过滤 appId —— **保持现状并写明** | F01（仅注释/文档） |
| S8 | `add()` 校验 id（`/^[A-Za-z0-9._-]{1,64}$/`，禁 `:`）；`setDefaultModel()` 校验 provider 存在 | F01 |
| S9 | 401/403 时不把上游 body 拼进 message | F01 |
| S10 | 删掉恒真断言；守卫测试保留但不夸大其强度 | F01/F02 |
| S11 | 补漏测：缺包错误分支、其余 6 个协议 factoryOptions、`CostInfo.providerId` | 各修复卡 |
| S12 | 删除已过时的注释与多余 `as unknown as` | F01 |
| S13 | 新增公共成员补进本文件 | 各修复卡 |
| S14 | `warnedMissing` 加上限 | F02 |
| S15 | `credential/store.ts` 的 `rmSync` 改为移入 `~/.model-infra-kit/trash/` | F04 |

## EVO-G06（G11）— SQLite 损坏自愈

`Store.open()` 新增三个可选入参（**仅新增**，既有调用零变化）：

```ts
export interface StoreOptions {
  path?: string
  driver?: SqlDriverFactory
  /** 非致命通知：跳过大库完整性检查、损坏库被隔离。默认静默。 */
  onWarn?: (message: string, error?: unknown) => void
  /** 损坏库的隔离根目录。默认 `~/.model-infra-kit/trash`（与 F04 同一 trash 根）。 */
  trashDir?: string
  /** 完整性检查的体积预算（字节）。默认 64 MiB；仅供测试注入。 */
  maxIntegrityCheckBytes?: number
}

// src/store/trash.ts（新增）
export function defaultTrashDir(): string
export function trashStamp(now?: Date): string
export function quarantineFile(path: string, targetDir: string): string
export function quarantineDatabase(
  dbPath: string,
  options?: { trashDir?: string; now?: Date },
): { dir: string; files: string[] }
```

打开顺序变为：建目录 → `assertWritableFile` → 打开驱动 → 写探针 → **`PRAGMA quick_check`** → `migrate`。

- 仅**文件型**库检查；`:memory:` 完全跳过。
- 只有明确损坏签名（`quick_check` 返回非 `ok` 行，或 `SQLITE_CORRUPT` / `SQLITE_NOTADB` / `database disk image is malformed` / `file is not a database`）才判定损坏；权限/锁/路径错误仍抛 `STORAGE`。
- 库文件 > 64 MiB 跳过检查（规则 6 启动不阻塞），并通过 `onWarn` 说明跳过原因。
- 判定损坏 → 主库与同级 `-wal`/`-shm` **移动**到 `~/.model-infra-kit/trash/db-corrupt-<UTC 时间戳>/`（绝不删除）；隔离失败仍抛 `STORAGE` 且原文件留在原地。
- 隔离成功后以同路径建空库（正常 `migrate`）并 `onWarn` 一条醒目告警，含隔离目录完整路径、账本已重置、SQLite 抢救指引。
- 告警文案是公共行为约定：必须含隔离目录路径、`reset` 语义与恢复指引。
- `ModelInfra.init()` 把自身的 `onWarn` 透传给 `Store.open`，因此宿主无需额外接线即可看到告警。

## EVO-G73 — 供应商回传成本（第六种价格来源）

`PriceSource`（`src/types.ts`，经 `src/index.ts` 从公共 API 导出）**新增一个取值**：`"provider"`。既有取值语义**不变**。

```ts
export type PriceSource =
  | "override"   // pricing_overrides 里的人工价（source 读作 "manual"）
  | "modelsdev"  // models.dev 目录价
  | "openrouter" // OpenRouter **目录**（价目表）里的价格
  | "fallback"   // 目录未命中时的兜底价
  | "provider"   // ★ 新增：端点自己回传的**实际计费额**（账单，不是估算）
  | "missing"    // 显式「没有价格」，绝不冒充免费
```

### `"openrouter"` 与 `"provider"` 的区别（同名不同义，务必分清）

| 取值 | 说的是什么 | 钱从哪来 | 性质 |
|---|---|---|---|
| `"openrouter"` | 价格取自 **OpenRouter 的价格目录**（per-token 价目表） | 用 token 数 × 费率**算**出来 | **估算** |
| `"provider"` | 端点**回传了这次调用实际被计费的金额** | 供应商/中转端自己给的数 | **账单** |

两者都「和 OpenRouter 有关」，但一个是价目表、一个是账单。看到 `"openrouter"` **不等于**对账已闭合；只有 `"provider"` 才是账单口径。

### 形状、单位与保留原始值（实测确定，勿照抄文档）

- 载体是 AI SDK 的 **`usage.raw`**（"raw usage information from the provider"），**不是** `providerMetadata`：
  实测（`.tmp/probe-g73.mjs`，`@ai-sdk/openai-compatible` + `ai` v7）`generateText` 的 `result.providerMetadata` 为 `{ mock: {} }`、`result.usage.raw` 为 `undefined`，而 **`result.steps[i].usage.raw`** 与流式 **`finish-step` part `.usage.raw`** 里带着 OpenAI 兼容体的 `usage` 对象（含 `cost`）。
  本模块自己的 `mik.fetch` 适配器直接解析响应体，非流式与 SSE 两条路径都能读到同一个字段。
- 单位**一律是美元**：`{"usage":{"cost":"0.000123"}}` 与 `{"usage":{"cost":0.000123}}` 都是 **123 微美元**。整数值同样是美元（`1` → $1 → 1_000_000 µ$）。
  **不做**「整数即 ticks / 微美元」的猜测——猜错就是 10^6 倍的静默错账，比不用更糟；回传 ticks 的端点应在自己的边界换算。
- 归一化后的**整数微美元**参与累加（硬性规则 2），落库仍走既有 `cost_usd` REAL 列 + `CAST(ROUND(cost_usd * 1000000) AS INTEGER)`；`usd = micros / 1e6` 可精确往返。
- **原始回传值必须保留**（可查、可对账）：写入既有 JSON 列 `usage_events.tags_json`，**不加表、不加列**，两个保留键：
  - `provider_cost_raw` — 供应商回传的原值文本（多步调用为 JSON 数组）；
  - `provider_cost_status` — `"accepted"`，或 `"rejected: <原因>"`。
  未回传计费额时**不写任何键**，`tags` 与改动前逐字一致。
- `CostInfo`：`low === high === usd`、`basis: "exact"`（账单没有估算区间），`source: "provider"`；`pricingModel`/`providerId` 沿用同次目录估算的值，便于对账时比对「本该按哪张卡计费」。
- 异常值（缺失 / `null` / 非有限 / 负数 / 无法解析 / 溢出 int / 正数却四舍五入到 0）**一律回落**到目录估算（含人工价），**不写 0 冒充免费**，**不抛异常**。显式 `0` 例外：那是供应商在说「这次免费」，照收并标 `provider`。
- 多步调用**原子采纳**：只要有一个 step 没报（或报得不可用），整行回落到目录估算——部分求和会静默少计，与写 0 同类。
- 失败的调用**永不**按回传值计费（与「失败不按价目表计费」同一不变式）。
- **公共签名同步**（规则 5）：`ForwardedCall` 新增可选 `providerCost?: ProviderCostReading`；`readOpenAiUsage()` 的返回新增可选 `cost`。`ProviderCostReading` 是宿主可直接命名的公共类型，已由 `src/index.ts` re-export（纯类型导出，运行时导出集合不变），签名见上文「稳定 — fetch 适配器」节。
- 口径可见：`usage export` 的 `pricing_source` 列、`usage logs` 的 `SOURCE`（zh：价格来源）列、HTTP 的 `cost_source` 都会显示 `provider`。

## EVO-G75 — 宿主归属标签（按业务维度切分成本）

宿主在同一进程里往往有多套业务共用一套模型层。本卡让宿主给每次调用打**自己的字符串标签**，并据此切分成本。标签只是**字符串归属**，**不是身份**：本模块不做权限、不做多租户、不做配额，**任何基于标签的访问控制都超出契约**。

### 请求面（库 + HTTP）

```ts
// 库：ModelRequest.tags（自 T01 起就存在，本卡首次给它定义语义并接上脱敏）
generate(request: { ..., tags?: Record<string, string> }): Promise<ModelResponse>
stream(request:   { ..., tags?: Record<string, string> }): AsyncIterable<StreamEvent>
// HTTP：POST /api/usage/events 的 body.tags?: Record<string, string>（F19，值经 redactDeep 入库）
```

- **完全可选**：不传 `tags`（或传 `undefined` / `{}` / 非对象）时，既有行为**逐字不变**——`usage_events.tags_json` 仍是 `'{}'`，`usage summary` / `usage logs` / `usage export` 的既有行与列一字不动。
- **不解释语义**：键值均由宿主定义，本模块不校验、不枚举、不映射。键名与既有列（`app_id`、`session_id` 等）**不冲突**：它们是 JSON 内的一层，不参与 SQL 列名解析。
- **入库前脱敏（规则 4 的延伸）**：宿主完全可能把 token 放进标签，而标签会进 CSV。库路径在 `ModelInfra.record()` 统一经 `sanitizeTags()` 处理，`redactDeep()` 是最后一步——`Bearer sk-live-…` → `Bearer [REDACTED]`，`api_key`/`authorization` 这类键的**值整体置为 `[REDACTED]`**，`sk-` 前缀值 → `sk-****`。HTTP 的 `POST /api/usage/events` 仍由 `readReportedTags()` 脱敏（F19，行为不变）。
- **异常值绝不抛错（规则 6，不阻塞宿主）**，归一化策略固定如下：

| 宿主传入 | 落库为 |
|---|---|
| `string` | 原值，超过 **256 个码点**截断 |
| `null` / `undefined` | `""`（显式的空值） |
| `number` / `boolean` / `bigint` | `String(value)`（`3` → `"3"`、`NaN` → `"NaN"`、`10n` → `"10"`） |
| 对象 / 数组 | `JSON.stringify`，超 **512 字符**截断；循环引用或 `toJSON` 抛错 → `"[unserializable]"` |
| 函数 / symbol | `""` |
| 键为空串、去掉首尾空白后为空、超过 **64 字符**，或为 `__proto__` | 整个键值对**丢弃**（长键不截断，避免两个不同长键截断后合并成一个成本桶） |
| `tags` 本身不是普通对象（字符串 / 数组 / `null`） | 视为**没有标签** |

- **机器写入的键不出现在任何归属渲染面，但照旧落库、照旧可读**。判据是**两个**（`RESERVED_TAG_KEYS` / `isReservedTagKey`，键名从属主模块 `pricing/reported-cost.ts` 取，**不在别处重打一遍字面量**）：
  - **EVO-G73 的两个真实键**：`provider_cost_raw`（单次调用的回传原值文本，逐调用变值）与 `provider_cost_status`（`"accepted"` / `"rejected: <原因>"`）——**它们没有 `_mik_` 前缀**；
  - `_mik_` **前缀**：本模块给将来的机器键预留的约定，**目前没有任何代码写它**。

  > 只判前缀等于**什么都没排除**（`provider_cost_raw` 匹配不上 `_mik_`）。本卡第一版正是这个错误：`byTag()` 会给每次上游回传成本的调用产出一个逐调用变值的 `provider_cost_raw=` 垃圾桶。已修正，并由「真实常量」用例（正反各一条）锁住。

  它们的**可见范围**（与代码一致，三句都是可核对的）：
  - **保留在** `usage_events.tags_json`，并由 `UsageEvent.tags` 与 HTTP 的 `usage` 响应返回（HTTP 只脱敏值、**不删键**），G73 对账因此照旧可查；
  - **不出现**在 `byTag()` 的桶里，也不出现在 `usage summary --by-tag` 的表里；
  - **不出现**在 `usage export` 的 `tags` 列里——该列经 `redactTagsForDisplay()` 渲染，它先做 `attributionTags()`（按 `isReservedTagKey` 滤键）再做 `redactDeep()`。**「CSV 从不丢列」说的是表头，不是这两个键**；键本身仍然可从 API 读到。
- **脱敏在写入与渲染两侧都做**：写入路径（本模块的 `generate`/`stream`/`fetch`）经 `sanitizeTags()` → `redactDeep()`；**渲染路径**（`usage export` 的 `tags` 列、`usage summary --by-tag` 的表）另经 `redactTagsForDisplay()` / `tagLabelForDisplay()` 再脱敏一次。后者不是多余动作：**旧版本写下的行没有脱敏**，而这两个面是本卡新开的通道，不能让它们把明文 token 打印出来。因此读取**不重写任何已存字节、不新增迁移**，`UsageEvent.tags` 仍返回原值（G73 对账依赖原始文本）。
- **HTTP 出口的脱敏（本卡补齐一处漏洞）**：`GET /api/usage/logs` 与 `GET /api/usage/logs/:id` 早已走 `api.ts` 的 `sanitize()`（= `redactDeep`），故标签值在响应里已脱敏、键保留；`GET /api/usage/summary|trends|by-provider|by-model` 只回聚合，**不含标签**（本卡**没有**新增 `by-tag` 路由）。唯一没被覆盖的是 `GET /api/events` 的 SSE 帧——它原样广播调用方交给 `UsageService.record()` 的事件，而宿主**直接调用**该方法时其标签不过写入侧脱敏。现已在该出口套用同一个 `sanitize()`（`api.ts` 的订阅回调），**键保留、只遮蔽值**。看板 `logs` 抽屉渲染的 `event.tags` 来自 `GET /api/usage/logs`（`apps/dashboard/lib/server-data.ts` → 代理 → `mik serve`），因此拿到的是已脱敏数据。

### 查询面

```ts
// src/types.ts —— UsageQuery 新增两个可选字段（纯追加，既有调用零变化）
interface UsageQuery {
  tag?: string        // 只保留带该键的行（明细行；折叠日无标签，不参与）
  tagValue?: string   // 且该键的值精确等于它；不给则只要键存在即可
}
// UsageService（与 UsageRepository 同名方法）
byTag(query?: UsageQuery): UsageBucket[]   // 见上文 T04 块；key 形如 "feature=quant-backtest"
```

`byTag()` 的桶是**同一笔钱的分解而非切分**：一次调用带 3 个标签，其全部成本计入 3 个桶，故各桶之和可大于总额。按成本降序，成本相同再按请求数、最后按 `key` 字典序。

### 存储与迁移（向后兼容）

- `usage_events.tags_json TEXT NOT NULL DEFAULT '{}'` 自 T01 就在 v1 建表语句里，**本卡不加列**。
- 迁移新增 **v2**：① 仅当 `PRAGMA table_info(usage_events)` 里没有 `tags_json` 时才 `ALTER TABLE … ADD COLUMN`（SQLite 没有 `ADD COLUMN IF NOT EXISTS`；对既有库是补列，对 T01 建的库是 no-op）；② 新建 `usage_tag_rollups(date, app_id, tag_key, tag_value, request_count, cost_microusd)`，主键 `(date, app_id, tag_key, tag_value)`。
- **旧库升级不丢数据**：v2 只做「补列 + 建新表」，不改写任何既有行。实测：用改前 schema 建库（含单条明细）→ `Store.open()` 升级 → 迁移版本变 `[1, 2]`、旧行按原值读出（`tags` 为空）、新行可写可查（`test/attribution-tags.test.ts` A4）。
- `usage_daily_rollups` 承载不了标签（一行的维度是 日/app/source/provider/model），而 `rollup()` 在**同一事务内**先插汇总再删明细；因此 v2 另建 `usage_tag_rollups`，`rollup()` 在同一事务里把该区间的标签成本也折进去——否则折叠过的日子会从标签切分里**静默消失**，而 `summary()` 仍在数它（G74/G77 同款「不该沉默时沉默」）。
- `usage_tag_rollups` 存**标签原文**而不是哈希：写入前已脱敏（渲染时再脱敏一次），故它不构成第二处泄露；哈希会让按值查询与人工核对都得先反查明细。

### CLI

```
mik usage summary [--from <date>] [--to <date>] [--app <appId>] [--tag <key[=value]>] [--by-tag]
mik usage export  --format csv [...]        # 表头 = 固定 15 列 + EVO-G81 追加 7 列（共 22 列）
mik usage logs    [--limit 20] [--offset <n>] [--with-id] [...]   # --with-id 表尾追加 REQUEST ID 列（EVO-G86）
```

- `--tag <键>` / `--tag <键>=<值>`：只统计带该标签的调用（在 `usage summary|trends|logs|export` 全部可用，属 `QUERY_FLAGS`）。只按**第一个** `=` 切分，标签值本身可含 `=`。
- `--by-tag`：**opt-in**，在 `usage summary` 末尾追加「按标签归属的成本」表（最多 10 行，单元格 48 码点后加 `…`；**只裁剪展示，CSV 与 API 保留全文**）+ 一行说明（多标签行会计入每个标签；未打标签的调用不在表内；机器写入的键已排除；展示值均已脱敏）。**不加这个 flag 时输出与改前逐字一致**。
- `usage export` 的 CSV 表头（**G75 当时的状态，历史记录**）：既有 14 列的名字与顺序一字不变，`tags` 追加为**第 15 列**（值为按字典序稳定的 `键=值` 空格连接；值内含逗号/引号时按 RFC 4180 加引号）。机器写入的键（G73 的两个真实键与 `_mik_` 前缀）**不出现**在该列——它们仍可从 `UsageEvent.tags` / HTTP 响应读到。**EVO-G81 之后 `tags` 不再是末列**，列表现状见下文「EVO-G81」节。


## EVO-G64 —— 共用数据库的可见性（`usage summary` 末尾的两条提示）

**本卡不新增身份、不新增维度。** `app_id` 早已是既有设计：`store/schema.ts` 的 `usage_events` / `usage_daily_rollups` 都有该列，每条用量都写它，也已可按它过滤（`UsageQuery.appId`）与切分（`UsageRepository.groupBy`）。缺的不是能力，而是**可见性**。

**默认库是机器级的**：解析链 `--db` → `MIK_DB` → `mik.config.json` → `~/.model-infra-kit/usage.db`（`cli/context.ts`）。同机各项目若不传 `--db` 就写进**同一个文件**——这是既有设计（多 app 合计总花费），**本卡不改**。但输出里原先没有任何一处说明「你读到的数字来自一个被共用的文件」。

### 两个信号（语义必须分清，**不得合并成一句**）

`usage summary` 在输出**末尾追加**，两条**互相独立**、各自只讲一件事实：

| | 触发条件 | 说的是 | 文案键 |
| --- | --- | --- | --- |
| **A. 已知共用**（证据） | 该库存在 **≥ 2 个 `app_id`** | app 个数 + app 名（最多 5 个，超出补 `…`；**计数永不裁剪**） | `usage.summary.sharedDb` |
| **B. 可能共用**（可能性） | `dbDefaulted` —— 即 `--db` / `MIK_DB` / `config.db` **都没给**，`dbPath` 落到内置默认 | 解析后的**库路径**，并指明「同机其它项目若也用默认设置会写进同一文件」 | `usage.summary.implicitDb` |

- **A 是证据，B 是可能性**：B **绝不**报告 app 个数或名字——两个项目都用默认 `app_id` 时，库内只有**一个** `app_id`，任何计数都是编造的。反过来 A 不再重复 B 的路径：**路径全输出只出现一次**（在 B 里），因为 B 恰好在读者**没有**自己指定路径时触发。
- **B 与 app 个数无关**（含 0 与 1）：风险来自路径是机器级的，而不是来自文件里此刻有什么。
- **显式指定库即静默**：`--db`、`MIK_DB`、`config.db` 任一存在 → B 不出现（用户自己选的库，他知道在共享什么）。**单 app + 显式 `--db` → 两条都不出现**（本卡的「不喧哗」边界）。
- **两条都在时**：先 B（身份）后 A（证据），共两行；A 不含路径、B 不含计数 → 不重复啰嗦（`test/shared-database-notice.test.ts` 的 ④ 用例断言路径**恰好出现一次**）。

### 接口与契约

- 新增只读 API `UsageService.appsInDatabase(): string[]`（`UsageRepository.apps()`）：升序返回该库写入过用量的全部 `app_id`，**不经 `scoped()`**，且同时读 `usage_events` 与 `usage_daily_rollups`（否则历史已折叠的 app 会凭空消失）。**只返回 id**，不含计数/成本/明细；属**只读提示**，绝不作为权限、配额或隔离判据。
- `CliContext` 新增 `dbDefaulted: boolean`：**关于路径如何解析**的事实（是否落到内置默认），不是关于文件的事实；供命令在调用点判断而无需重算解析链。
- **EVO-G84（F11）**：`CliContext` 新增可选 `cacheDir?: string`，值与交给 `ModelInfra.init()` 的 `cacheDir` 同源（与 `dbPath` 同性质，仅供调用点/测试读取，不改变任何输出）。
- **不传 `--db` 的解析行为逐字未变**（默认仍是全局库，**未**改为按项目隔离）。
- 两条提示都**不经 `scoped()`**：不受 `--app` / `--from` / `--to` 影响——它们讲的是**文件**。上面的统计数字仍按原样 scope 到当前 app；**既有行与顺序一字未动，新增内容只在末尾追加**。
- **`usage export` 的 CSV 表头一字未变**（本卡不加列，仍 15 列）。
- **已知边界（诚实声明）**：两个项目都用默认 `app_id`（`default`）时，从库内**无法区分**它们，A **永不触发**；该场景只由 B 覆盖——B 陈述的是路径与可能性，**不是**「有 3 个应用」这类具体主张。改 `app_id` 缺省值是破坏性变更，不在本卡范围。
- **本卡未改动** `mik serve` 的 HTTP 面与看板：那两面仍没有这两条提示。它们各自的 app 作用域**本卡未取证**，故此处不作断言。


## EVO-G81 —— 导出物可对账、可追溯、不可注入

来源：对已发布产物 0.2.23 的独立再审计（audit-R232 的 F4 / F5 / F6）。三条缺陷都只在**产物**上可见，故本节的每条结论都在 `usage export` 的真实字节上验证（`test/export-reconcilable.test.ts`）。

### 金额列：精度与真相源

- **真相源仍是整数微美元**（硬性规则 2）：每行的 `cost_microusd` 是 `Math.round(cost_usd * 1e6)`，与 SQL 的 `CAST(ROUND(cost_usd * 1000000) AS INTEGER)` 同语义；`cost_usd` 是它的 **6 位小数**渲染（`(micro / 1e6).toFixed(6)`）。
- **对账精度声明**：CSV 的对账精度是 **微美元（1e-6）**。逐行 `cost_microusd` 求和 == `usage summary` 所用的同一批整数之和（同一个查询范围、同一批行）；逐行 `cost_usd` 求和后与 `usage summary` 打印的成本值比对，**两侧都不需要取整**——显示侧自 EVO-G85 起按微美元渲染（见下文「EVO-G85」节；未定价存在时比的是它打印的**下界** `at least …`，见 EVO-G78）。
- **改了什么**：逐行曾是 4 位小数（`toFixed(4)`），于是 340 + 180 + 0 + 0 + 134 = **654 µ$（0.000654）** 的行和被打成 `0.0003+0.0002+0+0+0.0001 = 0.0006`，而 `usage summary` 打印 `0.0007` —— 对账必然失败（F4）。**禁止** `SUM(CAST(cost AS REAL))` 一类浮点求和仍是硬性规则。

### CSV 列（`USAGE_CSV_COLUMNS`，共 22 列）

前 15 列**名字与顺序逐字不变**。源码里的两个冻结常量（`USAGE_CSV_FROZEN_COLUMNS` / `USAGE_CSV_FROZEN_HEADER`，`src/cli/csv.ts`）只供测试与源码内断言使用：**它们与 `USAGE_CSV_LEGACY_COLUMNS` 一样不在 `mik/cli` 的公开导出里**（用 `dist/cli.d.mts` 核过；公开的是 `USAGE_CSV_COLUMNS` 与 `USAGE_CSV_HEADER`）。

| # | 列名 | 类型 | 语义 |
| --- | --- | --- | --- |
| 1–15 | `ts, app_id, provider, model, status, input, output, cache_read, cache_write, reasoning, cost_usd, pricing_source, pricing_basis, latency_ms, tags` | 同 G75 | 见上文 G75 节；**`cost_usd` 自 G81 起是 6 位小数的微美元渲染** |

EVO-G81 **追加**（顺序固定）：

| # | 列名 | 类型 | 语义 |
| --- | --- | --- | --- |
| 16 | `request_id` | string（非空） | 该次调用的身份。与 `usage_events.request_id`、`UsageEvent.requestId`、`GET /api/usage/logs/:id`（`src/server/api.ts:454`）**同一个值**；`POST /api/usage/events` 按它幂等（同 id 重复只计数、不重写）。用于把一行 CSV 定位回一条记录/按幂等键回灌。 |
| 17 | `session_id` | string（可空 → 空串） | 宿主传入的会话标识（`ModelRequest.sessionId` / 事件的 `sessionId`）。可空，缺失写空字段（不写 `null`）。 |
| 18 | `first_token_ms` | integer（可空） | 首 token 延迟（毫秒）。**与 `latency_ms` 同规则**：没有测量时写空，**不写 0**（0 是「测到 0 ms」）。 |
| 19 | `is_streaming` | `true` / `false` | 该次调用是否走流式（`UsageEvent.isStreaming`）。 |
| 20 | `error_code` | string（可空） | 失败原因码；仅在 `status=error` 时有值。 |
| 21 | `pricing_model` | string（可空） | 实际用于定价的模型 id（`CostInfo.pricingModel`）。落库时缺省取 `model_actual`（`usage-repository.ts:231`），故通常是模型名。 |
| 22 | `cost_microusd` | **integer** | 该行金额的**整数微美元**（真相源）。与同行 `cost_usd` 满足 `cost_microusd == round(cost_usd * 1e6)`；逐行求和即对账合计。 |

- 追加是**唯一**兼容的加列方式：按索引或按表头读取的宿主脚本不受影响；`usage summary` / `logs` / `trends` 的行与顺序本卡未改。
- **用户如何把一行 CSV 与一条 log 对上**：`request_id` 是两侧共用的身份——HTTP 面用 `GET /api/usage/logs/:id` 直接取该条；**CLI 面用 `usage logs --with-id`**（见「EVO-G86」节）在表尾打印同一个 id；`usage logs` 的表按 `TS/app/provider/model/status` 展示，可与 `request_id` 一起用于人眼核对。

### 行结构不变量（不可注入）

- **单条记录恰好一行**：任何单元格都不得含能结束一行的字符（CR / LF / U+2028 / U+2029）。G82 已在 `tags` 单元格做过（`tagsToText` → `redactTagsForDisplay` → `sanitizeTagForDisplay`）；**EVO-G81 把它提升为整行的性质**：`csvField()` 对每个文本单元格套用同一个 `sanitizeTagForDisplay()`（`\n`/`\r`/`\t` → 两字符转义，其余 C0/C1 → `?`），因此宿主/上游可控的 `model`、`session_id`、`error_code` 等列同样不会把记录拆成多个物理行。**这是「一个不变式、一处实现」，不是第二份策略。**
- 逗号与双引号仍按 RFC 4180 加引号；加引号后**不会**再出现换行（换行已在渲染前被转义），故「加引号 = 跨行」这一读法在本产物上不成立。
- 空库导出 = 一行表头，无数据行（`--out` 文件内容恰为 `表头 + "\n"`）。


## EVO-G86 —— CLI 面把一行 CSV 对到一条 log（`usage logs --with-id`）

**本卡只新增一个开关，不改任何既有列、不改默认输出。**

```
mik usage logs [--limit 20] [--offset <n>] [--with-id] [...QUERY_FLAGS]
```

- `--with-id`：**opt-in**，在 `usage logs` 的表**尾追加一列** `REQUEST ID`（zh：`请求 ID`），值为该事件的 `request_id`——与 `usage export` 的第 16 列、`UsageEvent.requestId`、`GET /api/usage/logs/:id` 是**同一个值**。列**追加而非插入**，故既有 10 列的索引不变（与 CSV 追加列同一策略）。
- **不加这个 flag 时输出与改前逐字一致**（同 EVO-G75 `--by-tag` 的取法）：默认表仍是 10 列，空库仍只打印 `usage.empty` 那一行、不出现空表头。
- 为什么必须有一个真实标识：`TS/app/provider/model/status` 组合键**对同一毫秒的两次调用不唯一**（`test/cli-traceability.test.ts` 的 A2 用例断言这两行除 id 外**逐格相同**），CLI 又不能依赖 `mik serve`（它不是默认运行的东西）。因此「一行 CSV ↔ 一条 log」在 CLI 首选项下**需要这个开关**。
- `usage logs` **没有** `--json` 分支（本卡未新增），故不存在 JSON 侧的一致性问题。
- `--limit` 截断、`--offset` 分页时 id 与该行其余单元格同源渲染，不会错位。


## EVO-G85 —— 用量面的金额精度与导出对齐（不再需要取整规则）

来源：G81 的独立评审对 D1 的「有条件认同」。G81 解决了审计 F4 的**第一层**（逐行 4 位小数使行和 `0.0006` 在任何精度上都不是真值）；**第二层当时未解决**：`usage summary` 仍按 4 位小数打印 `0.0007`，而导出各行之和是 `0.000654` —— 两个数**肉眼不一致**，用户仍须自己套一条取整规则才能对上。

- **规则（用户可见）**：用量面（`usage summary`、`usage logs`、`usage trends`、`usage summary --by-tag`）的**金额**改由 `formatUsageMoney()`（`src/cli/format.ts`）渲染：金额的整数微美元**没有低于 1e-4 的位**时仍是 **4 位小数**（与改前逐字相同）；**有位可显示时打印 6 位小数**（微美元单位本身）。于是 `0.000654` 与导出行之和 `0.000654` **逐字相同**——用户直接相加比对即可，**不需要取整规则**。
- **未定价下界（EVO-G78）**：`at least …` 里的那个数走**同一个**渲染器，故下界与行和也逐字一致（例：`Cost (USD)      at least 0.000654`）。措辞、出现条件、`Cost range` 的括注**均未改**。
- **零值钳位**：改前 `formatMoney` 把 `|usd| < 0.00005` 一律打成 `0.0000`，一个 30 µ$ 的真实合计会显示成 0 —— 这是同一处不一致的缩小版。`formatUsageMoney` 的钳位是**半个微美元**，30 µ$ 如实打印 `0.000030`。
- **`usage trends` 的合计**：改前是逐日 `costUsd` **浮点相加**再渲染；现改为先按**整数微美元**累加（`toMicroUsd(point.costUsd)` 求和）再渲染，故合计 == 逐日金额**打印值之和**（与硬性规则 2 的口径一致）。
- **改前/改后对照（真实产物，同一批 5 行：340/180/0/0/134 µ$）**：

  | 表面 | 改前 | 改后 |
  | --- | --- | --- |
  | `usage summary` 的 `Cost (USD)`（存在未定价 → 下界） | `at least 0.0007` | `at least 0.000654` |
  | `usage export` 逐行 `cost_usd` 之和 | `0.000654` | `0.000654`（未改） |
  | `usage logs` 一行 340 µ$ | `0.0003` | `0.000340` |
  | `usage trends` 合计 | `0.0007` | `0.000654` |
  | 已定价且无余数（如 10 000 µ$） | `0.0100` | `0.0100`（**未改**） |

- **未改**：CSV 的 22 列与前 15 列字面量锁、`cost_microusd` 的整数语义、`usage export` 的 6 位小数逐行渲染、`usage summary` 的行序与标签、EVO-G77/G78/G79 的三处表达；**目录价格**仍走 `formatMoney`（`mik models` / `mik pricing`，4 位小数），故帮助文案里「价格为每百万 token 的美元数（4 位小数）」仍然成立。
- **JSON/HTTP 面未改**：`/api/usage/*` 返回的 `costUsd` 一直是精确数值，本卡未动。
- **真相源仍是整数微美元**：禁止 `SUM(CAST(cost AS REAL))` 一类浮点求和（硬性规则 2）未变。
- **已知未解决（不在本卡范围，登记）**：看板 `apps/dashboard` 有**自己的一套**金额渲染（`lib/format.ts` 的 `formatUsd`），本卡未改；看板上的成本与导出行之和同样会不一致。→ **已在 EVO-G88 处理**（见下节；同节的记录里「`value < 1 ? 3 : 2` / `overview.tsx` 的 `toFixed(4)`」是当时的源码描述：**前者（`formatRate`）的描述属实但属性写错，后者（`overview.tsx:74` 有 `toFixed(4)`）属实却是本卡漏改的那一处**；两处均已在下节更正）。


## EVO-G88 —— 收口：看板/REPL 精度对齐、`init` 不再丢 `cacheDir`、`trends --to` 的下沿可见

三处**同类残留**：同一件事在**两处口径不同**，或工具**静默替用户做了决定**。

### A. 金额精度：CLI / REPL / 看板同一条规则（用户可见）

- **规则不变，覆盖面扩大**：EVO-G85 的 `formatUsageMoney()` 规则（整数微美元没有低于 1e-4 的位 → 4 位小数；有余数 → 6 位小数；钳位为**半个微美元**）现在是**用量面金额的唯一口径**。
- **REPL（`mik repl` 的 `/chat` 与自由文本回复）**：改前走目录价渲染 `formatMoney`（4 位、钳位 `|<0.00005|→0`），故一条 340 µ$ 的回复在终端里印 `cost 0.0003 · …`，而同一笔开销在 `usage logs` 里是 `0.000340`。改后走 `formatUsageMoney`：`cost 0.000340 · model <实际模型> · source <原始枚举>`。
- **看板（`apps/dashboard/lib/format.ts` 的 `formatUsd`）**：**不引用 CLI 代码**，而是实现**同一条规则**——先 `Math.round(usd * 1e6)` 得到微美元，余数为 0（`micros % 100 === 0`）时 4 位小数，否则 6 位；零值钳位同样改为**半个微美元**（改前 `< 1e-4` 一律印 `<$0.0001`）。看板自己的 `$` 前缀与**尾零裁剪**保留（图表轴仍显式传 `2`，日志详情面板显式传 `6`，显式 `digits` 优先）。
- **因此三面「位数规则一致」，但字面量不逐字相同**：CLI/REPL 印 `0.000340`，看板印 `$0.00034`（`$` + 去尾零是看板既有风格，e2e 的 DASH 检查按同一函数取期望值）。**这是刻意的**：本卡要统一的是**精度规则**，不是把 CLI 的字符串塞进看板。

  | 金额（µ$） | CLI `usage summary`/`logs`/`trends` | REPL `/chat` | 看板 `formatUsd` 改前 → 改后 |
  | --- | --- | --- | --- |
  | 654 | `0.000654` | `0.000654` | `$0.0007` → `$0.000654` |
  | 340 | `0.000340` | `0.000340` | `$0.0003` → `$0.00034` |
  | 30 | `0.000030` | `0.000030` | `<$0.0001` → `$0.00003` |
  | 1 | `0.000001` | `0.000001` | `<$0.0001` → `$0.000001` |
  | 17 500 | `0.0175` | `0.0175` | `$0.0175`（**未改**） |
  | 3 000 | `0.0030` | `0.0030` | `$0.003`（**未改**） |

- **看板最后一处裸 `toFixed(4)` 已收口（EVO-G88b）**：`apps/dashboard/components/views/overview.tsx:74` 的**成本区间提示**（`区间 $… ~ $…`，两个端点就是 `costLowUsd` / `costHighUsd`，`lib/types.ts:99-100` 声明为 `number`）改前是**裸的四位小数**（`区间 $${costLowUsd.toFixed(4)} ~ …`）——**没走 `formatUsd`**。于是同一笔 340 µ$ 在这里印 `$0.0003`（CLI 印 `0.000340`），且**没有半微钳位**：30 µ$ 印 `$0.0000`。**改后两个端点各走一次 `formatUsd`（默认位数 = 看板规则）**，与看板其余金额（`overview` 的总花费、`trends`、分桶表、日志表与详情面板）同一函数、同一规则。
  - **改前 → 改后（真实输出，`.tmp/g88b/surface-probe.mjs`）**：340 µ$：`区间 $0.0003 ~ $0.0003` → `区间 $0.00034 ~ $0.00034`；30 µ$：`区间 $0.0000 ~ $0.0000` → `区间 $0.00003 ~ $0.00003`；17 500 µ$：`区间 $0.0088 ~ $0.0350` → `区间 $0.00875 ~ $0.035`。
  - **为何不加 `digits`（保持默认位数）**：加了 `digits` 会让**每一边**都用同一个固定位数；默认规则是**每边各自**「无余数 → 4 位，有余数 → 6 位」，这正是看板其余金额用的那条规则。两端点是同一区间的两个端点，取哪个口径都自洽；选默认口径是为了与**总花费同卡同屏**的金额一致（G89 之后那一格是 `formatUsdSpan(costLowUsd, costHighUsd)`，位数规则同一条；当时的写法是 `formatUsd(summaryData?.costUsd)`）。
  - **此处是更正后的表述**：EVO-G88 节的记录里「`overview.tsx` 没有 `toFixed(4)`」**不属实**——该行改前即在、改后仍在（只是不再是 `toFixed`）。当时这处漏改由独立评审 EVO-G88 指出。

- **R257 类变化必须显式列出**：这次同时改了**钳位阈值**——30 µ$ 与 1 µ$ 从「看不出来的零」（`0.0000` / `<$0.0001`）变成**非零可读值**。位数放宽与「由零变非零」是两件事，看板侧同样成立。
- **未改**：CSV 22 列与前 15 列字面量锁、`usage logs` 默认输出、目录价（`mik models`/`mik pricing`）的 4 位小数、金额的整数微美元真相源。

### B. `init` 重跑不再静默丢弃既有 `cacheDir`（用户可见）

- **选择：保留既有值**（卡片推荐项）。理由：`init` 的**唯一职责**是把用户的选择**写下来**；用户没给 `--cache-dir` 时，「文件里已有的值」是**用户自己先前的选择**，而「主目录默认值」是**工具的猜测**。静默用猜测覆盖用户选择，正是 EVO-G84/F11 刚修好的同一类缺陷。另一种「明确告知」只把损失变得可发现，仍然把配置改掉了。
- **取值顺序**：`--cache-dir` → `MIK_CACHE_DIR` → **被重写的那个配置文件里的既有 `cacheDir`** → 无。与 `openContext` 的 flag → env → file 同一顺序，故写入值就是后续命令会解析到的值。读的是 `--file` 指定的**写入目标**（不是 `--config` 的读取源）；文件缺失/JSON 损坏/非字符串一律视为「无既有值」，`init` 不因此失败。
- **并让这个字段不再隐形**：写入后**多打一行** `  cache  <路径>`（zh 同形）——仅在该值确实生效时打印（无值时不打印）。这是 `init` 唯一被写入却从不显示的字段，也正是它丢失时无人看见的原因。
- **改前/改后（真实产物，同一序列）**：

  | | 第一次 `init --cache-dir <dir>` | 第二次 `init --force`（不带该 flag） |
  | --- | --- | --- |
  | 改前 | `{appId, db, cacheDir}` | `{appId, db}` ← **键消失** |
  | 改后 | `{appId, db, cacheDir}` | `{appId, db, cacheDir}` ← 保留，并在屏幕上打印 `cache  <dir>` |

- **未改**：`appId`/`db` 仍按 flag → env → 默认值重写（它们的取值**每次都会打印**），`--force`/`init.exists` 守卫、向导流程、收尾步骤文案均未动。

### C. `trends` 只给 `--to` 时，被补出来的下沿可见（用户可见）

- **新增一行范围说明**，沿用 EVO-G79 的**同一句式**（`Note: … ; usage summary and usage logs cover the whole history by default.` / `说明：…；usage summary 与 usage logs 默认覆盖全部历史。`）：
  - `Note: with no --from this command fills the lower bound in itself, 30 days before --to; usage summary and usage logs cover the whole history by default.`
  - `说明：未指定 --from 时本命令自行把下沿补成 --to 之前 30 天；usage summary 与 usage logs 默认覆盖全部历史。`
- **触发条件**：`trends` 上**给了 `--to`、既没给 `--from` 也没给 `--days`**。`--from X --to Y`（两个边界都是用户的）与 `--days N`（跨度是用户选的）**都不打印**；三者都没给时仍是 G79 的 `defaultDaysScope` 那一行。数字用 `%s` 传入，与 `applyDays` 实际补的天数同源。
- **改前/改后（真实产物，`mik usage trends --to 2026-09-08`，无 `--from`）**：

  ```
  改前： Range 2026-08-10 → 2026-09-08 · app=g88-app
        （无说明；两个日期看起来都是用户给的）

  改后： Range 2026-08-10 → 2026-09-08 · app=g88-app
        Note: with no --from this command fills the lower bound in itself, 30 days before --to; usage summary and usage logs cover the whole history by default.
  ```

- **`--days N` 现有测试**（本卡补齐，此前无覆盖）：`1`（单日窗口，3 天前的用量**不在**窗口内）；`3650`（文档上界，接受）；`3651`/`0`/`1.5`/`999999999`（拒绝，exit 2，`--days must be an integer between 1 and 3650, got <值>.`）；`abc`（更早的解析层：`--days expects a number, got "abc".`）；`--days -3` 需写成 `--days=-3` 才到得了范围检查（`--days -3` 被选项解析器先吃掉，报 `argument is ambiguous`，两者都 exit 2）。
- **未改**：表头、行序、合计、金额渲染、`DEFAULT_TREND_DAYS = 30` 本身。

## EVO-G89 —— 弃用点估计 `costUsd`，产品内部不再消费它

### 事实：点估计不是任何一侧的界

- `UsageSummary` 的三个成本字段（`costUsd` / `costLowUsd` / `costHighUsd`）**只累加已记录的金额**。`pricing_source: "missing"`（未定价）的请求按 0 入账，对三者都贡献 0；被 `rollupAndPrune()` 折进 `usage_daily_rollups` 的请求同理（汇总表不存价格来源）。
- 因此只要区间里有**未定价或已折叠**的请求，真实总额就**高于**这三个数：`costUsd` **不是下限**（G78 已据此把下限改用 `costLowUsd`），**也不是上限**。三者之间只有 `costLowUsd ≤ costUsd ≤ costHighUsd`，且**仅对已记录金额成立**。
- **价格按点记录**时（`manual` / `flat` / 供应商回传 / `exact` —— 所有 `low === high === usd` 的来源）三者相等：**`costLowUsd === costUsd === costHighUsd`**。这是下面每条迁移写法都安全、且 CLI 与看板输出逐字不变的情形。
- **但「区间里没有未定价请求」并不等于三者相等**：`llm-pricing` 的档位估算给出的是**已定价的价差**（`low < usd < high`）——仓库自带的 fixture 就是这一形：`test/cli.test.ts` 的 `seedUsageEvent` 记 `low 0.01 / usd 0.012345 / high 0.02`，`test/cost-certainty.test.ts` 的 `wide-model` 同形（那里的注释写着「estimates a spread」）。**卡片原文把它写成「完全定价时 `low == usd == high`」，与代码不符**（R197：以代码为准）：没有未定价请求时 `low` 与 `high` 仍是区间两端，`usd` 只是区间内的一点，**三者可以不等**。此时单值表达的正确形式是**区间**，而不是那个点——点落在区间内部，两侧都不是界。

### 变更 1（非破坏）：`@deprecated`

- `packages/mik/src/types.ts` 的 `UsageSummary.costUsd` 就地加上 `@deprecated`，写明**原因**（点估计、两侧都不是界）与**迁移路径**（下限 / 区间 / `costLowerBoundOnly`）。
- **字段继续存在且继续填充**：`summary().costUsd` 仍是原来那个数（整数微美元真源 `SUM(cost_microusd)`），既有宿主的读取与格式化代码不受影响。**删除公共字段属 major，本卡不删。**
- 看板的类型镜像 `apps/dashboard/lib/types.ts` 的 `UsageSummary.costUsd` 同样标注（同一份说明）。

### 变更 2：产品内部不再消费它

- **CLI `usage summary`**：两条成本行都改由 `costCell(summary, bound, lang)` 产出（`src/cli/commands/usage.ts`）——上界未知则 G78 的 `至少 <下限>`；上界已知则 `low === high` 时印**单值**（与改前逐字相同），有价差时印**区间** `下限 – 上限`。改前在「上界已知」这一支无论有没有价差都印 `summary.costUsd`。
- **看板**：`components/views/overview.tsx` 的「总花费」与 `components/views/trends.tsx` 的「区间成本」改用 `apps/dashboard/lib/format.ts` 新增的纯函数 `formatUsdSpan(costLowUsd, costHighUsd)`——点为单值、有价差为 `$a ~ $b`（与同一张卡上的区间提示同形）。
- **改前 → 改后（真实输出，`packages/mik/test/g89-cost-point-estimate.test.ts` 的 spread 用例）**：一笔已定价但**有价差**的请求（`usd = 0.0005`、`low = 0.00034`、`high = 0.000777`；无未定价、无折叠）：

  | | `Cost (USD)` | `Cost range` |
  | --- | --- | --- |
  | 改前 | `0.0005` ← 点估计（区间内的一点） | `0.000340 – 0.000777` |
  | 改后 | `0.000340 – 0.000777` ← 区间 | `0.000340 – 0.000777`（未改） |

  **按点记录**时（`usd = low = high = 0.00034`）两行改前改后**逐字相同**：`0.000340` 与 `0.000340 – 0.000340`——这是本卡「非破坏」的直接证据。**未定价**时仍是 G78 的 `at least 0.0000` 与 `at least 0.0000 (upper bound unknown: 1 request(s) unpriced)`，一个字都没动。两条成本行在每种情形下都**同形**（同一下限、或同一区间），与 G78「两行永不互相矛盾」的设计一致。
- **既有断言的改动（仅一处，申报）**：`test/cli.test.ts` 的 G13 i18n 用例原断言 `toContain("0.0123")`（fixture 的 `usd` 是 `0.012345`，`0.0123` 只是它的子串），其语义是「数据保持既有的四位小数渲染」。本卡之后该格是区间，故改为 `toContain("0.0100 – 0.0200")` 并补 `not.toContain("0.012345")`——后者正是「CLI 不再读点估计」在这条面上的断言。**本卡未改任何其它既有断言。**
- **未改**：`usage export` 的 22 列与前 15 列字面量锁、`usage logs` 默认输出、金额的整数微美元真源（仍无 `SUM(CAST(cost AS REAL))`）、G77 折叠提示 / G78 下限表达 / G79 范围说明 / G85 条件精度。

### 迁移写法（面向宿主；发布说明用同一段）

```ts
// 1) 要下限 → costLowUsd（上界未知时 CLI 与看板印的就是它）
const floor = summary.costLowUsd
// 2) 要区间 → 两端（上界已知且有价差时 CLI 与看板印这个）
const [lo, hi] = [summary.costLowUsd, summary.costHighUsd]
const band = lo === hi ? String(lo) : `${lo} – ${hi}`
// 3) 想标注「至少」→ costBound()；HTTP 面同名字段 costLowerBoundOnly
const bound = costBound(summary, usage.unpricedCoverage(query))
const cell = bound.costLowerBoundOnly ? `at least ${floor}` : band
// 4) 价格按点记录时 low === usd === high，以上结果与今天的 costUsd 完全相同
//    （看板侧同一规则：apps/dashboard/lib/format.ts 的 formatUsdSpan(low, high)）
```

### 边界与未覆盖（本卡不做的部分）

- **EVO-G92 补齐趋势点与 provider/model 分桶的区间**：`UsageTrendPoint` 始终带 `costLowUsd` / `costHighUsd`；`UsageBucket` 的供应商与模型分桶也带这两个端点。明细行在 SQL 中逐行四舍五入成整数微美元后求和，折叠行直接求和 `cost_low_microusd` / `cost_high_microusd`；内存合并仍只累加整数微美元，最后才映射为美元数。既有 `costUsd` 的计算和值保持不变。
- **`byTag()` 的两个区间端点仍可缺席**：历史 `usage_tag_rollups` 只保存 `cost_microusd`，并未保留上下界；`UsageBucket` 因此将端点声明为可选。不会从 `costUsd` 复制或推算缺失端点。此行为只影响 `byTag()`，不影响 HTTP 的供应商/模型分桶。
- **`examples/` 与测试仍读它，且是这样设计的**：`examples/cli-agent`、`examples/agent-cli`、`examples/openai-sdk` 作为**宿主示例**继续读 `summary.costUsd`——它们同时是「既有宿主的读取行为不变」这条非破坏承诺的活证据（A2）；测试里读它是为了断言字段仍被填充。**产品面（CLI / 看板）不再读它**，两件事互不矛盾。
- **看板断言分两层**：`apps/dashboard/test/cost-span.test.ts` 直接 import 生产函数 `formatUsdSpan`（不是复制表达式）断言其输出；`packages/mik/test/g89-cost-point-estimate.test.ts` 断言真实视图文件里调用它的是 `costLowUsd`/`costHighUsd` 两个端点。**仍没有**页面级渲染断言（看板测试用 `node --test` 跑 `.ts`，不带 JSX 变换，渲染不了 RSC）。
- **价差是否由上游真实产出未验证**：spread 用例通过 `UsageService.record()` 直接写入 `low < usd < high` 的 `CostInfo`；类型契约允许该形状，`PricingService.estimate()` 会把 `catalog.estimate()` 的 `low`/`high` 原样带出，仓库自带 fixture 也是这一形——但「`llm-pricing` 当前档位数据在真机上是否会给出价差」未在本卡验证（R208 申报）。
- **两端一边缺失的分支**：`formatUsdSpan` 在 `high` 缺失时只回下限（`number` 类型下不可达，仅为 `NaN`/`undefined` 兜底）；该分支**无真实数据覆盖**，测试只覆盖「两端都缺 → `—`」（R208 申报）。

## EVO-G92 — 趋势点与分桶成本区间

`UsageTrendPoint` 增加必有的 `costLowUsd`、`costHighUsd`；`UsageBucket` 增加可选的同名字段。`GET /api/usage/trends` 的每日/每小时点以及 `/api/usage/by-provider`、`/api/usage/by-model` 的桶都会返回两端金额。保留 `costUsd` 及其原计算结果，以免破坏既有只读消费者。

两端金额在 `usage_events` 上通过 `SUM(CAST(ROUND(cost_low_usd * 1000000) AS INTEGER))` 与对应的 `cost_high_usd` 表达式聚合；已折叠的 `usage_daily_rollups` 使用整数 `cost_low_microusd` / `cost_high_microusd`。内存合并同样只累加整数微美元，完成后才转换为美元数。没有价差时 `formatUsdSpan` 显示单值，有价差时显示完整区间。

看板将「最贵的一天」定义为**区间下限最高的一天**；下限相同时用上限打破并列。最贵日、按天明细、供应商分桶和模型分桶均显示对应的 `costLowUsd ~ costHighUsd` 区间。

## EVO-G93 — 模型机架与能力元数据矩阵

模型能力取自按供应商分组的公开记录，`sourceProviderId` 标出用于规范化该条事实的记录，避免把不同端点的窗口限制混为一谈。静态快照在 2026-09-23 核对；Claude 3.5 Sonnet 保留 Anthropic 历史规格，映射标为 `deprecated`。

`ModelMetadata` 描述标准模型事实：统一 `id`、`family`、名称、上下文/输出上限、推理/视觉/音频/工具/结构化输出能力，以及来源链接。`ProviderModelBinding` 独立描述 `(providerId, protocol, modelId) → upstreamModelName` 和端点状态；供应商部署别名不会覆盖标准模型 ID 或固有能力。实例 API 还会通过配置的 `presetId` 与 `protocol` 将自定义 provider id 解析到兼容绑定；协议不符或没有显式映射时返回 `undefined`，不猜测部署名称。

`ModelInfra.catalog.list(filter?)`、`get(modelId)`、`assertCapability(modelId, capability)`、`resolveEndpoint(modelId, providerId)` 与 `listBindings(filter?)` 提供同步只读查询。能力守卫对缺失模型抛 `MODEL_NOT_FOUND`，对不支持的能力抛 `INVALID_REQUEST`。快照来自每条记录的 `source` / `sourceUrl`，上游不可用不影响启动，也不会在 `ModelInfra.init()` 中触网。`mik models catalog` 支持双语表格与 `--json`；看板 `/models` 将标准机架与供应商实际发现的目录分别展示。Claude 3.5 Sonnet 保留为历史元数据，端点绑定状态为 `deprecated`。

## EVO-G94 — 动态阶梯计价与 SQLite 价格缓存

`ModelPricingTier.rates` 以整数微美元/百万 Token 保存输入、缓存读取、缓存写入、普通输出与思考输出费率；可选长上下文阈值与倍率只作为计价参数。GPT-6 Luna / Sol / Astra 在上游未给出独立缓存费率时，读取价按基础输入价的 10% 计算、写入价按 125% 计算、思考 Token 单独按 `reasoningOutputMicrosPerMillion` 计价（未配置时跟随普通输出价）。基础费率始终来自模型目录或显式手动价。

成本核算以 `BigInt` 计算每个 Token 类别的微美元分子，仅在最终汇总处四舍五入成整数微美元；上下限相同，因为该阶梯卡代表一个确定费率。没有缓存的模型继续走原有 `llm-pricing` 路径。经校验的 tier 按 `(providerId, modelId)` 写入 SQLite `pricing_cache`，带版本号与来源；启动时先读本地 tier，远程刷新异步执行。网络或 JSON 失败只写告警、保留本地缓存并继续使用随包目录。

`mik.pricing.sync({ force?, dryRun? })` 与 `mik pricing sync [--dry-run]` 可刷新阶梯价；试运行不写 SQLite tier 行。手动价格仍优先于同步缓存。密钥不参与价格记录或同步数据。

## EVO-G96 — Agent Trace 查询与全生态适配

`ModelRequest.traceId` / `sessionId` 与 `UsageEvent.traceId` / `sessionId` 是可选归属字段。`UsageQuery.traceId` 和 `sessionId` 可筛选用量明细。`UsageService.traces(query?, groupBy?)` 与 `GET /api/usage/traces?groupBy=trace|session` 返回请求数、成功/失败数、reasoning token、耗时范围、延迟均值和成本上下限。成本在 SQLite 以整数微美元累加，最终映射成美元数。

`GET /api/usage/logs` 支持 `traceId`，用于取回仍在明细保留期内的调用步骤。旧明细每日折叠时，schema v4 会同步写入 `usage_trace_rollups`；聚合金额与 reasoning token 保留到与普通日汇总相同的保留边界。`archivedRequests` 标出仍计入聚合但已经没有逐次详情的调用数。所有查询默认按实例 `appId` 隔离。

OpenAI 兼容入口 `POST /v1/chat/completions` 将标准 `user` 记为 `sessionId`，也接受 `session_id` 或 `X-Mik-Session-Id`；`trace_id`、`metadata.trace_id` 或 `X-Mik-Trace-Id` 会记为 `traceId`。嵌入式 `mik.fetch` 支持同一组 body 字段/headers，并在转发时移除 MIK 专用 headers 与 `session_id` / `trace_id` 扩展字段。

适配示例位于 `examples/openai-sdk`、`examples/python-host` 和 `examples/langchain-python`。OpenAI SDK 仍用 `baseURL: mik.baseUrl` 与 `fetch: mik.fetch`；Python 与 LangChain 指向 `http://127.0.0.1:3211/v1`。`user`/session header 标记会话，逐次 `X-Mik-Trace-Id` 或 `trace_id` 标记一次 Agent Loop。

## EVO-G102 — Model ping and host default

`GET /api/models` includes `defaultModel: string | null`. `PUT /api/models/:ref/default` validates a discovered model and persists its ref through the existing provider registry; it returns `{ defaultModel }`. Encode namespace-containing refs as one URL segment. Both mutation endpoints use existing write authentication.

`POST /api/models/:ref/ping` sends one streaming `ping` prompt, at most 4 output tokens, no fallback chain and a 10-second model timeout. The response is `{ ref, prompt, maxOutputTokens, latencyMs, firstTokenMs, dnsMs, dnsNote, outputTokens, reasoningTokens, tokensPerSecond, text }`. TTFT starts at model invocation and ends at the first nonempty text delta; absent text is `null`. Throughput uses visible output tokens (excluding reasoning) over the post-first-token duration. Text and errors are redacted and normal metering applies, including after a soft budget is exceeded.

DNS is a separately timed OS lookup of the configured provider hostname before model invocation (1-second bound). It may use the OS cache and is explicitly not the SDK connection DNS phase; unavailable/failed lookup returns null and never prevents the model request. Duration measurements are not monetary values.

## EVO-G104 offline price snapshots

`PricingService.exportSnapshot(): string` exports the locally cached rate facts (not manual overrides). `importSnapshot(json): { imported: number; errors: string[] }` validates version 1, timestamp, count, SHA-256 of canonical metadata/models, provider/model identity and safe integer non-negative micro-USD rates before one SQLite transaction. Zero is valid for free rates. Overrides and historical usage remain unchanged. The pure serializer/validator lives in `src/pricing/snapshot.ts`; it returns validated models without writing storage. These helpers are internal, not root exports.

`mik pricing export --output <path>` refuses to overwrite an existing file; `mik pricing import --file <path>` merges validated cache facts. Invalid local cache rows trigger a redacted warning, reset only `pricing_cache`, and use the existing bundled archive; a failed reset still does not block startup.

## EVO-G105/G106 dashboard language and Connect

Dashboard language: `mik_dashboard_lang` localStorage preference (`zh`/`en`), browser-language fallback, same-named SameSite cookie for SSR, no URL query changes. Shared paired dictionaries and `useI18n()` cover all views and helper-generated labels. Native modal dialogs trap focus, handle Escape and restore the invoking control. Existing test anchors are preserved.

`/connect` reads the configured `MIK_SERVER_URL` (strips credentials/query/hash in displayed snippets), enabled providers and discovered text models. Five client snippets use the gateway token environment reference, never the provider key. `/api/playground` accepts same-origin POST `{ model, prompt, traceId }`, forwards a single streamed call to the configured `/v1/chat/completions`, and keeps the token server-side. Prompt length is limited to 8,000 characters, output to 128 tokens, timeout to 60s. Text crosses a `redact.ts` stream boundary; arbitrary upstream metadata is omitted. Browser TTFT measures first displayed redacted text, which may wait for an unfinished word. Final cost is fetched by the unique trace ID from the existing usage logs, converted once to integer micros; absent records/pricing are explicitly unavailable. No client history or credentials are persisted.

<!-- release-battery-runtime-exports:v1 -->
## EVO-G107 — 发布包运行时导出契约

发版电池对实际 `npm pack` 产物执行动态导入，并将运行时（非 type-only）导出与下列机器可读清单逐项比较。数组必须保持排序；新增或删除公共运行时符号时，先更新本契约并同步对应入口说明。

```json
{
  "format": "mik-runtime-exports/v1",
  "entrypoints": {
    ".": [
      "CredentialStore",
      "DEFAULT_MODEL_SETTING",
      "KeyPool",
      "MODEL_CATALOG_SOURCE",
      "MODEL_LIST_PROTOCOLS",
      "MODEL_METADATA",
      "MODEL_REF_SEPARATOR",
      "ModelCatalogService",
      "ModelInfra",
      "ModelInfraError",
      "PROTOCOL_PACKAGES",
      "PROVIDER_MODEL_BINDINGS",
      "PROVIDER_PRESETS",
      "PricingService",
      "ProviderRegistry",
      "SDK_PROTOCOLS",
      "SqliteStorageAdapter",
      "Store",
      "UsageService",
      "checkBudgetStatus",
      "createAiBridge",
      "createFileCache",
      "createMikFetch",
      "defaultCacheDir",
      "defaultDbPath",
      "defaultSecretPath",
      "expandPath",
      "getPreset",
      "isModelInfraError",
      "loadProviderFactory",
      "maskSecret",
      "modelCatalog",
      "normalizeRefs",
      "packageForProtocol",
      "readOpenAiUsage",
      "redact",
      "redactDeep",
      "splitModelRef",
      "toModelInfraError"
    ],
    "./cli": [
      "COMMANDS",
      "CliRuntimeError",
      "CliUsageError",
      "DEFAULT_CONFIG_FILE",
      "EXIT_FAILURE",
      "EXIT_OK",
      "EXIT_USAGE",
      "GLOBAL_FLAGS",
      "USAGE_CSV_COLUMNS",
      "USAGE_CSV_HEADER",
      "assertPortFree",
      "formatDuration",
      "formatMoney",
      "formatPercent",
      "formatTable",
      "formatTimestamp",
      "formatTokens",
      "helpFor",
      "isDirectInvocation",
      "main",
      "netstatShowsPort",
      "offlineFetch",
      "openContext",
      "parseCliArgs",
      "portInUse",
      "probePort",
      "usageCsv",
      "usageCsvRow",
      "withContext"
    ],
    "./server": [
      "DEFAULT_HEARTBEAT_MS",
      "DEFAULT_HOST",
      "DEFAULT_PORT",
      "EventBus",
      "HttpError",
      "MAX_BODY_BYTES",
      "Router",
      "buildOpenApiDocument",
      "createServer",
      "requireScope"
    ]
  }
}
```

## EVO-G103 — 网关 Token 作用域与应用隔离（1.1.0）

`model-infra-kit/server` 新增运行时导出 `requireScope(scope: string)`；类型导出 `GatewayScope`、`GatewayToken`、`TokenReference`。`ServerOptions.tokens?: GatewayToken[]` 支持内存多 Token；省略时读取 `MIK_SERVER_TOKENS` JSON 数组。`ServerOptions.token` 是既有 Master Token，默认 admin。显式空数组覆盖环境映射。

```ts
type GatewayScope = "*" | "admin" | "write:chat" | "write:usage" | "read:usage"
interface GatewayToken { token: string; scopes: GatewayScope[]; appId?: string }
interface TokenReference { tokenRef: string; scopes: GatewayScope[]; appId?: string }
```

- `write:chat`：仅 POST `/v1/chat/completions`（包含 streaming）。
- `write:usage`：仅 POST `/api/usage/events`。
- `read:usage`：GET 用量/详情/Trace、价格、模型目录、预算、SSE 与 OpenAPI；供应商记录/凭据管理和模型探测需要 admin。
- `admin`/`*`：全权；appId 绑定仍适用于用量隔离。未绑定 Token 使用 hub.appId，不接受任意客户端 app 切换。

CLI 的 `mik.config.json.serverTokens` 使用 `TokenReference[]`，只允许 `env:VAR` 引用，密钥本体不写文件或数据库；环境映射优先于文件引用。缺失引用、无效作用域、重复 Token、空 appId 在监听前拒绝，错误不回显配置值。直接嵌入式 createServer 使用内存 tokens 或环境映射；文件引用由 CLI 在创建服务器前解析。

`requireScope` 接受只含 auth 元数据的上下文，不含 bearer 原文。缺少 auth 或权限时抛出 `HttpError(403, "insufficient_scope", "FORBIDDEN")`；server 转成精确的结构化 JSON。开发模式由 server 显式注入 admin，独立中间件调用不默认放行。

应用归属经 `UsageService.withAppScope`（@internal）的实例级 AsyncLocalStorage 传递，shared hub.appId 不变。记录、汇总、趋势、分组、详情、预算均强制当前作用域；SSE 只推送有效 app 的用量事件，目录/价格通知仍为全局共享。header `x-mik-app-id` 和 query `appId`/`app_id` 只能等于有效 appId（重复参数逐项校验）；绑定 Token 的报告 body 或 batch item 越界整单 403。独立库调用保持既有显式 appId 语义。


## EVO-G108 — Synchronous storage adapters and shared state

The root entry exports `SqliteStorageAdapter` at runtime and `StorageAdapter`, `PreparedStatement<T>`, `StorageConfig`, `StorageAdapterFactory` as types. `StorageAdapter` extends the existing synchronous `SqlDriver` surface with `prepare<T extends Record<string, unknown>>(sql): PreparedStatement<T>` and `transaction<T>(fn): T`; statements retain `run`, `get`, and `all`. Factory initialization may return a Promise; database operations and transaction callbacks are synchronous so existing registry, usage and pricing APIs stay compatible. A transaction callback must not return a Promise or schedule later database work. Declared async callbacks are rejected before invocation; returned thenables cause rollback. SQLite transactions use `BEGIN IMMEDIATE` and nested savepoints.

`ModelInfraConfig.storage` / `StoreOptions.storage` accept `{ type: "sqlite", path?: string }`, `{ type: "custom", name: string, url?: string, authTokenRef?: string }`, or an already-connected `StorageAdapter`. `ModelInfraOptions.storageFactory` / `StoreOptions.storageFactory` initializes configured custom storage. Custom configuration without a factory fails explicitly. Store owns the injected connection and closes it on shutdown or failed migration. The legacy `Store.open({ path, driver })` factory remains supported and gains a transaction wrapper; mixing `driver` with `storage` is rejected.

```ts
const mik = await ModelInfra.init({
  appId: "shared-app",
  storage: { type: "sqlite", path: "./shared.db" },
})
// Host-owned transport/credentials: only references are serializable.
const remote = await ModelInfra.init({
  storage: { type: "custom", name: "host-libsql", url: "libsql://db.example", authTokenRef: "env:DB_TOKEN" },
  storageFactory: async (config) => hostConnect(config), // returns synchronous StorageAdapter
})
```

`mik.config.json.storage` accepts only the serializable variants; unknown keys (including `authToken`), credentials in URLs, URL query/hash, invalid token references or malformed values fail without echoing their values. Custom credentials resolve in the host factory and must never enter SQL. CLI `--db` / `MIK_DB` override file storage; file `storage` otherwise overrides legacy `db`. Standalone CLI custom storage needs an embedded CLI host supplying `hub.storageFactory`; it does not silently create a local ledger.

SQL dialect is **SQLite-compatible**, including migration `PRAGMA table_info`, JSON queries (`json_each`) and local-calendar `strftime`; this is compatible with LibSQL SQL syntax, not a claim of arbitrary ANSI database support. Core amount aggregates preserve ANSI `SUM(CAST(ROUND(cost * 1000000) AS INTEGER))` and rollup amounts remain integer micros. Default SQLite retains WAL, busy timeout, integrity probes and corruption quarantine. Injected adapters skip local filesystem, integrity and quarantine assumptions, while schema migrations still run through the adapter. No built-in HTTP LibSQL/Turso implementation is supplied: an asynchronous network SQL API cannot implement these synchronous repository operations directly.

Independent SQLite connections to the same file observe committed provider/settings/usage/pricing-cache rows. This is shared persisted state, not automatic synchronization of per-instance in-memory pricing catalog snapshots or cross-host SQLite file locking. Separate files do not share state. The adapter suite tests repository visibility/amount invariants, nested rollback and real worker-thread SQL contention; production remote transport/locking remains the host adapter's responsibility.


## EVO-G109 — Passive provider health and declarative failover

`ProviderConfig` adds `group?: string`, `priority?: number` (lower wins, default 10), and `fallback_provider_id?: string`. Group and fallback IDs use the existing 1–64 character provider identifier alphabet; priority is a non-negative safe integer and fallback cannot name itself. Registry records and the provider HTTP create/update API expose these fields. They persist in the reserved `meta.routing` JSON object; supplied arbitrary `meta.routing` cannot override validated top-level routing fields. No new SQL schema or secrets are introduced.

Both `ModelInfra.generate()` and `stream()` (therefore the existing `/v1/chat/completions` server routes) share one route implementation. An explicit fallback provider wins over same-group priority selection. One automatic backup reuses the requested model ID; hosts must configure that ID on both endpoints. Existing explicit `fallbackChain` entries retain their ordered, bounded sequence, followed by at most one automatic backup; `fallbackChain: false` suppresses every fallback. Candidates must share a protocol or belong to the protocol-data compatibility set `openai`, `openai-compatible`, `deepseek`, `moonshotai`, `xai`; no provider ID selects an adapter. No round-robin provider selection or active network health polling is added.

`ModelInfraOptions.failover?: { failureThreshold?: number; cooldownMs?: number; now?: () => number }` defaults to three consecutive recoverable failures and a 30,000 ms cooldown. `mik.providerHealth.state(providerId)` returns `CLOSED`, `OPEN`, or `HALF_OPEN`; state is per hub and process-local, independent of G108 persisted rows. CLOSED failures open the circuit at the threshold; cooldown eligibility reserves exactly one synchronous HALF_OPEN probe before transport. A successful response closes it, a recoverable probe failure starts a new cooldown, and client abort/consumer early return releases the probe without charging another provider failure. Cooled backups can recover through later fallback traffic. State inspection does not issue a request or reserve a probe.

Recoverable HTTP statuses are exactly 429/500/502/503/504; existing statusless G95 timeout/connection errors (including ETIMEDOUT/ECONNREFUSED) remain recoverable. An explicit HTTP status outranks message prose and SDK error nesting: other client 4xx responses never rotate keys or providers even when their message says timeout/rate limit. Client abort never falls back. Streams cannot replay after emitting text or tool-call events; generation cannot replay after native `onToolExecutionStart` fires or a tool-call step completes. Failed attempts retain existing zero-cost accounting. The successful row prices the actual provider and records string tags `failover: "true"`, `original_provider: <primary ID>`, alongside the legacy `is_fallback` tag; tag values remain strings per the existing UsageEvent contract.

## EVO-G110 — Measured media pricing and native tool execution attribution

The package entry exports the types `PriceRule`, `MultimodalUsage` and `ToolCallAttribution` (verified in built declaration exports). `ModelPricingTierRates` extends `PriceRule`; media rates are optional non-negative safe integer micros:

```ts
interface PriceRule {
  image_per_megapixel_micros?: number
  audio_input_micros_per_second?: number
  audio_output_micros_per_second?: number
}
interface MultimodalUsage {
  image_pixels?: number
  audio_input_ms?: number
  audio_output_ms?: number
}
```

`ModelRequest.media` and `PricingService.estimate({ media, ... })` accept explicit measured quantities; no media is downloaded and no resolution/duration is guessed from messages. Invalid quantities fail validation before a core provider request. Snapshot import/export validates and preserves these optional rates. Rates missing from the selected card contribute no invented media charge. Text, image and audio numerators are accumulated with BigInt over a common denominator, rounded half-up once, and checked against `Number.MAX_SAFE_INTEGER`. Existing long-context multipliers affect token rates; media unit rates are explicit card prices. A provider-reported billed amount still overrides the estimate.

`UsageEvent.tool_calls?: ToolCallAttribution[]` is persisted as a structured `tool_calls` array in `tags_json`, independently of generic attribution-tag string limits. `UsageEvent.tags` remains a string map and excludes this structured key; tag breakdowns/rollups reserve the key. Reported HTTP events may include `media` and `tool_calls`; only known scalar tool audit fields survive validation. Invalid media rejects that item under the existing `/api/usage/events` batch contract (HTTP 200 plus `rejected[]`, including single reports).

```ts
interface ToolCallAttribution {
  tool_name: string
  id: string
  input_hash: string // SHA-256 of serialized input, no raw input/output persisted
  start_offset_ms: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
}
```

Generate and stream observe AI SDK native `onToolExecutionStart`/`onToolExecutionEnd` and `onStepFinish`, preserving original host tool functions and failover replay protection. Start offset is relative to the request; duration is the SDK's measured execute time. Each completed step's reported input/output tokens are divided equally among its executed tools, with integer remainders assigned in execution-start order. This is an explicit allocation estimate: SDK step tokens do not identify independent tool token invoices. Repeated tool IDs in subsequent steps retain their own counts. Costs allocate the existing request micros in proportion to these token shares, flooring each ratio; parent-only steps and rounding remainders remain on the request. The sum of tool costs never exceeds the request total and never adds another bill.

Tool audit fields are whitelisted on both write and legacy read, names/IDs pass through `redact.ts`, only SHA-256 hashes persist, malformed arrays are ignored, and stored cost shares are clamped against the parent total. Audit arrays are bounded to 256 entries per request with 128-character names/IDs. `UsageService.normalizeEvent` is an internal shared normalization path for `record` and the HTTP event bridge: `onUsage`, event bus/SSE and repository reads use identical safe tool fields and request-local app attribution. No additional row query is needed per event.

The dashboard preserves existing DOM anchors and adds expandable amber tool bars aligned to the whole trace. Native `<details>/<summary>` supports keyboard exploration; hover and expanded content show execution duration, input/output token shares, integer micros, parent-cost percentage and parameter hash. Both dictionaries explain the allocation estimate. No raw tool input/output appears.

## EVO-G111 — Native Prometheus exporter

`GET /metrics` returns Prometheus 0.0.4 text with the exact `Content-Type: text/plain; version=0.0.4; charset=utf-8` and `Cache-Control: no-store`. Configured gateway tokens require `read:usage`, `admin` or `*`; missing/invalid credentials return 401 and insufficient scope returns the existing structured 403. There is no additional unauthenticated whitelist or listener. Existing unconfigured loopback development remains available; remote requests require a configured token. App/header/query restrictions are identical to the usage API: token-bound app IDs apply even for admin, and unbound tokens see only `hub.appId`.

The exporter observes normalized runtime usage through the internal `UsageService.observe(listener)` subscription, independently of the SSE bridge. It counts each committed record once; duplicate persisted request IDs contribute nothing. With `recordUsage: false`, runtime observations still occur without persistence or `onUsage`/SSE emission. Each server starts from zero, never reconstructs historical rows, and unsubscribes on close or failed bind. A failover produces one error attempt on the failed provider and one successful attempt/cost on the actual provider. Scrapes, SSE clients and unrelated management endpoints contribute no request count.

- `mik_requests_total{provider,model,app_id,status}` counts completed provider attempts (`ok`/`error`).
- `mik_request_duration_seconds` is a cumulative histogram with `le` boundaries 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 and `+Inf`, plus `_sum` and `_count`. Each sample is elapsed request time at an attempt's completion, including preceding failed attempts on fallback; it is neither isolated transport duration nor TTFT. Missing/invalid latency is zero.
- `mik_tokens_total{provider,model,app_id,type}` partitions tokens: prompt excludes cached input, completion excludes reasoning, reasoning is bounded to reported output, cache combines cache-read/write counts bounded to reported input. The four types sum to reported input plus output.
- `mik_cost_micros_total{provider,model,app_id}` converts the compatibility USD boundary by decimal text once, then accumulates integer micros with BigInt. Counters may exceed `Number.MAX_SAFE_INTEGER` without losing precision.
- `mik_provider_health_status{provider}` reads the hub's passive circuit state: CLOSED=1, OPEN/HALF_OPEN=0. Reading it neither sends traffic nor reserves a probe. The host app initially includes configured providers; other apps include only providers observed in their own attempts, preventing discovery of unrelated providers. Health is shared per hub rather than an independent per-app circuit.

Only provider/model/app/status/type/bucket identities become labels. Prompt text, trace/session IDs, arbitrary tags, tools and error prose are excluded. Identity values replace known configured gateway tokens, pass through `redact.ts`, bound to 128 characters and escape backslash/newline/quote. Changed/bounded identities gain a SHA-256 suffix to distinguish redaction/truncation collisions. Per-app storage preserves tenant ownership; each app retains 1,024 provider/model series plus a single `__other__` overflow series with exact aggregate totals. Observed health identities are capped at 1,024 per app. No cross-app overflow is used.

Scrapes read only memory and the in-memory circuit, with no usage SQL or historical scan. Typical ten-series rendering is benchmarked in the focused suite; this is measured performance, not a universal sub-millisecond guarantee at the cardinality bound. The exporter class/content-type constant are internal server-module implementation details, not additional package entrypoint exports.

### G110/G111 monetary boundary guard

Tier calculations retain safe integer micros. `PricingService.estimate` rejects a tier total with `RangeError` when converting it to the compatibility USD-number field and decimal-parsing back would change the exact micros; it never silently zeroes that total. Tool attribution fields remain safe integers: for a larger provider-reported amount, the attribution budget is capped at `Number.MAX_SAFE_INTEGER` micros, still below the parent amount, without capping the billed amount. The exporter parses the reported USD number directly to BigInt micros and therefore counts individual amounts above the safe Number range. This cannot recover precision already absent from an upstream USD number.
