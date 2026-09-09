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
  /** F08：等待在途目录同步（上限 5s）后再关闭 store，可重复调用。 */
  close(): Promise<void>
}

/** T05 追加（指挥批准）：全部可选，向后兼容。 */
export interface ModelInfraOptions extends ModelInfraConfig {
  baseUrl?: string
  maxRetries?: number
  pricingCatalog?: import("llm-pricing").PricingCatalog
  pricingFetch?: typeof globalThis.fetch
  onUsage?: (event: UsageEvent) => void
}
```

`ModelRequest.model` 解析规则：`"provider:model"` 直接拆；裸模型名用 `providers.defaultModel()` 的 provider；都缺失抛 `INVALID_REQUEST`。

## T06/T07 — `src/cli/` 与 `src/server/`

CLI 子命令：`init` / `serve` / `dashboard` / `provider add|list|remove|test` / `models` / `pricing sync|set|list` / `usage summary|trends|logs|export`。

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
GET  /openapi.json
POST /v1/chat/completions      GET /v1/models
```

---

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
