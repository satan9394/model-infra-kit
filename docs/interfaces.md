# 接口契约（跨 Worker 唯一真相）

> 多个 Worker 并行时，**签名以此文件为准**。要改先改这里，并在交证里写明。

已存在（T01，勿改签名）：

```ts
// src/types.ts
ProviderConfig, ProviderRecord, ProviderPreset, ProviderStatus
ModelInfo, ModelCapabilities, ModelPricing, ModelSource
TokenUsage { input; output; cacheRead; cacheWrite; reasoning }
CostInfo { usd; low; high; basis; source; pricingModel?; providerId? }
ModelRequest { model?; messages: ModelMessage[]; system?; tools?: ToolSet; temperature?; maxTokens?; headers?; tags?; sessionId?; signal? }
  // EVO-G75：`tags?: Record<string, string>` 是宿主自定义的**归属标签**（如
  // `{ feature: "quant-backtest" }`）。值入库前经 `sanitizeTags()` 归一化 + `redactDeep()`
  // 脱敏；非对象/异常值一律按既定策略处理，**绝不抛错**（见「EVO-G75」节）。
  // 它是成本归属维度，**不是身份**：不做权限、配额、多租户、访问控制。
ModelResponse { text; toolCalls; finishReason; usage; cost; provider; model{requested,actual}; latencyMs; firstTokenMs?; steps? }
StreamEvent（text_delta | tool_call_delta | tool_call_complete | step_finish | usage | finish | error）
UsageEvent, UsageSummary, UsageBucket, UsageTrendPoint, UsageQuery, UsagePage
ModelInfraConfig

// src/errors.ts
ModelInfraError, isModelInfraError, toModelInfraError, ModelInfraErrorCode

// src/credential/store.ts
CredentialStore { parse; resolve; tryResolve; set; delete; list; describe }

// src/store/database.ts
Store.open({ path?, driver?, onWarn?, trashDir?, maxIntegrityCheckBytes? }) → Store { providers; models; pricing; usage; settings; driver; close() }
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
}
export interface PricingState {
  status: "fresh" | "stale" | "error"
  loadedAt?: number
  source?: string
  lastError?: string
}
export interface EstimateInput { model: string; at?: number; usage: Partial<TokenUsage> }
export class PricingService {
  constructor(deps: PricingDeps)
  /** 永不抛错：失败只把 status 降级为 stale/error 并 onWarn */
  init(): Promise<PricingState>
  refresh(): Promise<PricingState>
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
  pricingCatalog?: import("llm-pricing").PricingCatalog
  pricingFetch?: typeof globalThis.fetch
  /** G01 追加：显式价格目录源；HTTP 面 sync 前用 SSRF guard 校验（经 `pricing.outboundUrls()`）。 */
  pricingSources?: import("llm-pricing").PricingSource[]
  onUsage?: (event: UsageEvent) => void
}
```

`ModelRequest.model` 解析规则：`"provider:model"` 直接拆；裸模型名用 `providers.defaultModel()` 的 provider；都缺失抛 `INVALID_REQUEST`。

## T06/T07 — `src/cli/` 与 `src/server/`

CLI 子命令：`init` / `serve` / `dashboard` / `provider add|list|remove|test` / `models` / `pricing sync|set|list` / `usage summary|trends|logs|export`。

`mik serve` 标志（T14）：`--port <n>` / `--host <h>` / `--token <t>` / `--cors <origin>`。`--cors` 接受 `'*'`（任意源）或 `https://...`（固定源，映射到 `createServer({ cors: { origin } })`），非法值直接报错；默认关闭。T14 同时也暴露了 `createServer({ cors })` 已是既有能力（`boolean | CorsOptions`）。

HTTP API（全部挂在 `/api`，OpenAI 兼容端点挂 `/v1`）：

```
GET  /api/health
GET  /api/providers            POST /api/providers
PATCH/DELETE /api/providers/:id
POST /api/providers/:id/test
GET  /api/providers/:id/models   POST /api/providers/:id/models/refresh
GET  /api/models               GET /api/models/:ref
GET  /api/pricing              PUT /api/pricing/:modelId   POST /api/pricing/sync
DELETE /api/pricing/:modelId   （T07 追加并经指挥批准：看板需要撤销手动价）
GET  /api/usage/summary|trends|by-provider|by-model|logs|logs/:id
       （G78：`/api/usage/summary` 的响应在 `summary` 上**追加**三个字段，
         `costLowerBoundOnly` / `unpricedRequests` / `unmeasuredRequests`，
         由 `costBound()` 推出。既有字段与数字一个都没变；加了它们之后，
         `costLowUsd === costHighUsd` 才不再被机器读者当成"精确值"。）
GET  /api/events               （SSE：usage.recorded / catalog.updated / pricing.updated）
POST /api/usage/events         （F19 新增：宿主自己调模型，把用量上报进来）
GET  /openapi.json
POST /v1/chat/completions      GET /v1/models
```

**G01 默认拒绝写（安全默认）**：未配置 token（`--token` / `MIK_SERVER_TOKEN`）时，写方法（POST/PATCH/PUT/DELETE，除 `/api/health` 外，含 `/v1/chat/completions`）一律 401，消息给出如何设置 token 的指引；GET 读端点与 `/api/health` 保持公开。配置了 token 时行为不变：除 `/api/health` 外全部端点要求 `Bearer`。另外：`readJsonBody` 只接受 `application/json`（含 `+json`、charset），否则 415；`provider test` / `models refresh` / `pricing sync` 出站前校验 URL（仅 http(s)，禁链路本地/云元数据地址如 169.254.0.0/16、fe80::/10、0.0.0.0、`[::]`，loopback 127.0.0.0/8、`::1` 放行），违规 400「INVALID_REQUEST」。

### `POST /api/usage/events`（F19）

宿主不想改调用链、只想统一记账时用。**鉴权**与其它端点一致（设了 token 就要求 `Bearer`）。**G01 计量防伪造**：`appId` 只允许等于本服务 `hub.appId`（缺省取 `hub.appId`），否则 400。

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
  appId?: string               // G01：只允许等于本服务 appId，缺省取服务端 appId；否则整单 400（防计量伪造）
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
- **`budget`（EVO-G07）**：属 config 入参层，即**最高优先级**；它没有环境变量、`mik.config.json` 或 settings 层的对应物（CLI 不读该字段），因此只有「显式入参 → 不配置」两种状态，不存在被覆盖的情形。
- `mik.config.json` 承载 `appId` / `db` / `cacheDir` / `initialProviders`（`src/cli/context.ts`）——改文件**不会**重新播种供应商，`initialProviders` 仅 `mik init` 首次消费。
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
| `budget` | `{ usd: number; window?: "day" \| "month"; onExceed?: "warn" }` | 不配置（= 关闭） | 软预算：**只告警、绝不硬拒绝**。见下文「EVO-G07」 |

该接口与 F16 记录的 `ModelInfraOptions`（`baseUrl`/`maxRetries`/`pricingCatalog`/`pricingFetch`/`onUsage`）共同构成 `ModelInfra.init()` 的入参。

#### `budget`（EVO-G07 新增，契约）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `usd` | `number` | 必填 | 阈值（美元），必须为**正有限数**；`0`/负数/`NaN`/`Infinity` 视为非法配置 |
| `window` | `"day" \| "month"` | `"day"` | 统计窗口，边界为 **UTC** 日界/月界（`Date.UTC(...)`），不是本地时区 |
| `onExceed` | `"warn"` | `"warn"` | 目前**只支持** `"warn"`；其它取值视为非法配置 |

语义（不可放宽）：

- **只告警，绝不硬拒绝**：不阻断、不排队、不返回 429、不做 RPM/TPM 限流；越阈只经 `onWarn` 发一条消息。
- **每实例每窗口每 appId 最多一次**：同一 `UsageService` 实例内，同一窗口的后续越阈写入不再告警；跨窗口（UTC 日/月界）后累计值归零，可再告警一次。（多实例各自计数、互不知晓。）
- 累计口径为**整数微美元**（`Math.round(usd * 1e6)`，与 SQL 的 `CAST(ROUND(cost_usd * 1000000) AS INTEGER)` 同语义），不做浮点求和。
- 基数：`ModelInfra.init()` 时**一次性**从库汇总「本窗口内本 appId 成本」（`UsageRepository.costMicros()`，detail 行、`[windowStart, now)`），之后靠内存运行值累加；**每次 `record()` 不做全表 SUM**。
- 计数范围：只累计 `event.appId` **严格等于**本实例 `appId` 的事件（不等则整行跳过；init 基数同样只覆盖该 appId）。
- **失败静默（不影响调用与记录）**：未配置 → 零查询零告警；配置非法 → 忽略该配置并经 `onWarn` 提示一次；init 基数汇总失败 → 基数按 0 计（一次 `onWarn`），不抛错；运行期累计异常 → 静默。
- 告警消息含阈值、当前累计、窗口与 appId，且整体过 `redact()`（`packages/mik/src/util/redact.ts`）。

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
- **对账精度声明**：CSV 的对账精度是 **微美元（1e-6）**。逐行 `cost_microusd` 求和 == `usage summary` 所用的同一批整数之和（同一个查询范围、同一批行）；把逐行 `cost_usd` 求和后按 `usage summary` 的显示精度（4 位）取整，得到的就是它打印的那个成本值（未定价存在时是它打印的**下界** `at least …`，见 EVO-G78）。
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



