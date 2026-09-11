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
ModelResponse { text; toolCalls; finishReason; usage; cost; provider; model{requested,actual}; latencyMs; firstTokenMs?; steps? }
StreamEvent（text_delta | tool_call_delta | tool_call_complete | step_finish | usage | finish | error）
UsageEvent, UsageSummary, UsageBucket, UsageTrendPoint, UsageQuery, UsagePage
ModelInfraConfig

// src/errors.ts
ModelInfraError, isModelInfraError, toModelInfraError, ModelInfraErrorCode

// src/credential/store.ts
CredentialStore { parse; resolve; tryResolve; set; delete; list; describe }

// src/store/database.ts
Store.open({ path?, driver? }) → Store { providers; models; pricing; usage; settings; driver; close() }
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
  trends(query?: UsageQuery, bucket?: "day" | "hour"): UsageTrendPoint[]
  byProvider(query?: UsageQuery): UsageBucket[]
  byModel(query?: UsageQuery): UsageBucket[]
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
export const SDK_PROTOCOLS: Record<Protocol, SdkProtocol>          // 稳定：protocol → factoryExports + factoryOptions
export const MODEL_LIST_PROTOCOLS: Record<Protocol, ModelListProtocol>  // 稳定：protocol → 模型列表探测（url / headers / parse / defaultCapabilities）
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
- `SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS` 是「协议是一等公民」（规则 3）的落点：每个协议一行，任何 provider 差异只能进 `provider.meta`。

### 稳定 — fetch 适配器

```ts
// src/fetch.ts
export interface ForwardedCall { requestId; at; providerId; modelRequested; modelActual; usage; latencyMs; firstTokenMs?; status: "ok" | "error"; errorCode?; isStreaming }
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
export function readOpenAiUsage(payload: Record<string, unknown> | null): { usage: TokenUsage; model?: string } | null
```

- `createMikFetch()` 让现有 OpenAI 兼容客户端带计量：`new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })`。请求体的 `model` 决定路由，凭据由 provider 协议附加；**调用方自带的密钥不转发**；响应按字节原样返回（只读 clone）。
- `readOpenAiUsage()` 兼容 `prompt_tokens`/`input_tokens`、`cached_tokens`/`prompt_cache_hit_tokens`/`cache_read_tokens`、`cache_creation_tokens`/`cache_write_tokens`、`reasoning_tokens`；**一个字段都读不到时返回 `null`**（而不是全 0 的 `TokenUsage`），调用方据此区分「上游没报 usage」与「确实为 0」。

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
- CLI 侧读取顺序：`MIK_LANG` 环境变量 → `cli.lang` 设置 → `zh`。

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
- **settings 表**（`cli.lang` 等小设置）只由 CLI 的 REPL/向导读写（`hub.readSetting`/`writeSetting`），优先级低于环境变量：`MIK_LANG` → `cli.lang` → `zh`（见上文「小设置持久化」节）。
- `mik.config.json` 只承载 `appId` / `db` / `initialProviders`（`src/cli/context.ts:25-34`）——改文件**不会**重新播种供应商，`initialProviders` 仅 `mik init` 首次消费。
- 已由测试锁定：`packages/mik/test/config-precedence.test.ts`。

### 环境变量清单（源码实测，逐个 grep 确认；含 CLI 与库两条路径）

| 变量 | 读取位置 | 语义 |
|---|---|---|
| `MIK_DB` | `cli/context.ts:140`、`cli/commands/init.ts:55` | SQLite 路径（CLI；`--db` 优先） |
| `MIK_APP_ID` | `cli/context.ts:141`、`cli/commands/init.ts:54`、`hub.ts:317` | 账本所属应用 id；多宿主共用一库时用于隔离 |
| `MIK_CONFIG` | `cli/context.ts:75` | `mik.config.json` 的替代路径（`--config` 优先） |
| `MIK_CACHE_DIR` | `cli/context.ts:142` | 价格目录缓存目录（`--cache-dir` 优先） |
| `MIK_OFFLINE` | `cli/context.ts:143`（`"1"` 为真） | 完全离线：禁用目录同步与在线价格拉取（flag `--offline` 为 `||` 关系，不是覆盖） |
| `MIK_LANG` | `cli/commands/init.ts:53`、`cli/repl.ts:165`（`cli/i18n.ts` 只提供 `resolveLang`） | CLI/REPL 界面语言 `zh`/`en`；优先于 `cli.lang` 设置 |
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

该接口与 F16 记录的 `ModelInfraOptions`（`baseUrl`/`maxRetries`/`pricingCatalog`/`pricingFetch`/`onUsage`）共同构成 `ModelInfra.init()` 的入参。

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
