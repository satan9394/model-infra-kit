# model-infra-kit (`mik`)

可嵌入的模型层：多供应商调用、模型目录、token 用量、计价与成本统计。一个包，三个入口。

```bash
npm i model-infra-kit
```

| 入口 | 导出 | 用途 |
|---|---|---|
| `model-infra-kit` | `ModelInfra`、`Store`、`CredentialStore`、`ProviderRegistry`、`PricingService`、`UsageService`、`createAiBridge`、错误类型与全部类型 | 主路径 |
| `model-infra-kit/server` | `createServer`、`DEFAULT_HOST`、`DEFAULT_PORT` | 自建 HTTP 服务（`mik serve` 用的就是它） |
| `model-infra-kit/cli` | `main(argv)`、`parseCliArgs`、格式化工具 | 把 CLI 嵌进自己的进程 |

> 需要 Node ≥ 22.13（`node:sqlite` 自 22.13.0 起不再需要 `--experimental-sqlite`）。`@ai-sdk/*` provider 是可选 peer 依赖：用哪个协议就装哪个包（`@ai-sdk/openai`、`@ai-sdk/deepseek` …），缺失时 `loadProviderFactory()` 会给出「装哪个包」的可读错误。
>
> **本包不含看板。** `files` 只有 `dist` 与 `LICENSE`（库 + CLI + HTTP 服务）；Next.js 看板在仓库的 `apps/dashboard`，`mik dashboard` 只在 monorepo 内可用，装包环境会报错并给出指引。详见[项目 README 的「看板」一节](../../README.md#看板)。

---

## 1. `ModelInfra.init()`

```ts
import { ModelInfra } from "model-infra-kit"

const mik = await ModelInfra.init({
  appId: "my-app",
  db: "~/.model-infra-kit/usage.db",
  providers: [{ id: "deepseek", presetId: "deepseek", apiKeyRef: "env:DEEPSEEK_API_KEY" }],
  defaultModel: "deepseek:deepseek-chat",
})
```

`init()` **不会**因为「供应商缺失 / 价格目录拉不到 / 模型同步失败」而抛错，只降级并通过 `onWarn` 告警；只有数据库打不开或显式配置非法才是致命错误。

### 配置项（`ModelInfraConfig` + `ModelInfraOptions`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | `string` | `MIK_APP_ID` → `"default"` | 归属应用，写进每条用量事件；一库多 app 的关键 |
| `db` | `string` | `~/.model-infra-kit/usage.db` | SQLite 路径，`":memory:"` 可用 |
| `providers` | `ProviderConfig[]` | — | 首次运行时注册（幂等，已存在跳过） |
| `defaultModel` | `string` | — | `provider:model`，请求省略 `model` 时使用 |
| `syncCatalog` | `boolean` | `true` | 后台发现已启用供应商的模型目录，**不阻塞 `init()`** |
| `recordUsage` | `boolean` | `true` | 是否落库；`false` 时纯转发不计量 |
| `cacheDir` | `string` | `~/.model-infra-kit/cache` | 价格目录快照缓存目录 |
| `onWarn` | `(message, error?) => void` | 丢弃 | 非致命问题回调；**请勿抛错** |
| `baseUrl` | `string` | `http://127.0.0.1:0/v1` | 对外端点；`mik serve` 起来后由 `setBaseUrl()` 注入真实端口 |
| `maxRetries` | `number` | AI SDK 默认 | 每次供应商调用的重试次数 |
| `pricingCatalog` | `PricingCatalog` | — | 注入 llm-pricing 目录（离线/测试） |
| `pricingFetch` | `typeof fetch` | `globalThis.fetch` | 注入一个抛错的 fetch 即可完全离线 |
| `onUsage` | `(event) => void` | — | 每条事件落库后回调；抛错被吞并转 `onWarn` |

### 实例成员

| 成员 | 签名 | 说明 |
|---|---|---|
| `appId` | `readonly string` | 本实例的归属应用 |
| `baseUrl` | `readonly string` | OpenAI 兼容端点（给客户端用） |
| `fetch` | `readonly typeof fetch` | 可直接传给 `new OpenAI({ fetch })` 的适配器 |
| `ai` | `AiBridge` | `languageModel()` / `test()` / `discoverModels()` |
| `providers` | `ProviderRegistry` | 见 §4 |
| `models` | `ModelCatalog` | 见 §5 |
| `pricing` | `PricingService` | 见 §6 |
| `usage` | `UsageService` | 见 §7 |
| `catalogSync` | `Promise<void>` | 后台目录同步的 promise；`init()` 不等它 |
| `generate(req)` | `Promise<ModelResponse>` | 非流式，成功失败都计量 |
| `stream(req)` | `AsyncIterable<StreamEvent>` | 流式；`usage`/`finish` 事件在流结束后发出 |
| `resolveModel(ref?)` | `{ providerId; modelId; requested }` | `provider:model` 直拆；裸名用默认供应商；都缺抛 `INVALID_REQUEST` |
| `setBaseUrl(url)` | `void` | 服务端绑定端口后回填 |
| `close()` | `Promise<void>` | 关闭 SQLite 连接（等后台目录同步最多 5s；之后所有公开成员抛 `STORAGE`） |

---

## 2. `generate()` / `stream()`

```ts
const reply = await mik.generate({
  model: "deepseek:deepseek-chat",           // 省略则用默认模型
  messages: [{ role: "user", content: "hi" }],
  system: "You are terse.",
  temperature: 0.2,
  maxTokens: 512,
  tools: { get_weather: tool({ /* AI SDK tool */ }) },
  tags: { feature: "chat" },                 // 任意键值，随事件落库
  sessionId: "conv-42",                      // 用于按会话查询
})

for await (const event of mik.stream({ messages: [{ role: "user", content: "hi" }] })) {
  if (event.type === "text_delta") process.stdout.write(event.text)
  if (event.type === "usage") console.log(event.usage, event.cost.usd)
  if (event.type === "error") console.error(event.error.code, event.error.message)
}
```

### `ModelRequest` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | `string` | — | `provider:model`；裸模型名走默认供应商；都没有则抛 `INVALID_REQUEST` |
| `messages` | `ModelMessage[]` | ✅ | AI SDK 消息数组（`system` 角色请用顶层 `system` 字段） |
| `system` | `string` | — | 系统提示词 |
| `tools` | `ToolSet` | — | AI SDK 工具集；工具循环默认最多 5 步 |
| `temperature` | `number` | — | 采样温度 |
| `maxTokens` | `number` | — | 输出上限 |
| `headers` | `Record<string,string>` | — | 透传给供应商的额外请求头 |
| `tags` | `Record<string,string>` | — | 随用量事件落库，便于归因 |
| `sessionId` | `string` | — | 随用量事件落库，可 `usage.query({ sessionId })` |
| `signal` | `AbortSignal` | — | 取消 |

### `ModelResponse` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | `string` | 最终文本 |
| `toolCalls` | `ToolCall[]` | `{ id, name, input }` |
| `finishReason` | `string` | 供应商给出的结束原因 |
| `usage` | `TokenUsage` | 四类 token + reasoning（缺失按 0 展示） |
| `cost` | `CostInfo` | 金额、区间、依据、价格来源 |
| `provider` | `string` | 实际供应商 id |
| `model` | `{ requested; actual }` | 请求的引用 vs 供应商回显的模型名 |
| `latencyMs` | `number` | 端到端耗时 |
| `firstTokenMs` | `number?` | 首 token 延迟（流式才有） |
| `steps` | `number?` | 工具循环步数 |

### `StreamEvent` 变体

| `type` | 载荷 | 说明 |
|---|---|---|
| `text_delta` | `{ text: string }` | 文本增量 |
| `tool_call_delta` | `{ id; name; delta }` | 工具调用参数增量 |
| `tool_call_complete` | `{ call: ToolCall }` | 一个工具调用组装完成 |
| `step_finish` | `{ finishReason; usage }` | 单步结束 |
| `usage` | `{ usage: TokenUsage; cost: CostInfo }` | 本次调用已计价（流结束时发出） |
| `finish` | `{ response: ModelResponse }` | 终态汇总 |
| `error` | `{ error: { code; message } }` | 失败（已脱敏） |

### `TokenUsage` / `CostInfo`

| 类型 | 字段 |
|---|---|
| `TokenUsage` | `input`、`output`、`cacheRead`、`cacheWrite`、`reasoning`（均为 `number`，缺失按 0 呈现） |
| `CostInfo` | `usd`、`low`、`high`、`basis`（`exact\|flat\|blended\|manual`）、`source`（`override\|modelsdev\|openrouter\|fallback\|missing\|manual`）、`pricingModel?`、`providerId?` |

> 内部计价保留「字段缺失 ≠ 0」的语义（传给 llm-pricing 的是 `Partial<TokenUsage>`），公共类型只是展示层。

---

## 3. `fetch` 适配器

```ts
const client = new OpenAI({ apiKey: "unused", baseURL: mik.baseUrl, fetch: mik.fetch })
```

- 请求体的 `model` 决定供应商；调用方自带的 `authorization` / `api-key` / `x-api-key` / `x-goog-api-key` 会被剥离，改由 mik 按 `provider.protocol` 附上凭据。
- 响应原样返回，mik 只读克隆来提取 `usage` 并计价，落库 `source = "fetch"`。
- 流式响应同样计量（`isStreaming: true`）。
- 供应商 id 未配置 → HTTP 404 `PROVIDER_NOT_FOUND`；缺凭据 → 401 `CREDENTIAL`。

---

## 4. `mik.providers`（`ProviderRegistry`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `list()` | `ProviderRecord[]` | 全部供应商（**全局共享，不按 appId 过滤**） |
| `get(id)` | `ProviderRecord \| null` | 单个 |
| `add(config)` | `ProviderRecord` | 增改；未给 `protocol` 时按 `presetId` 补全；id 需匹配 `/^[A-Za-z0-9._-]{1,64}$/`（禁 `:`） |
| `remove(id)` | `boolean` | 删除 |
| `setEnabled(id, enabled)` | `void` | 启停 |
| `resolve(id)` | `ResolvedProvider` | `{ record, apiKey, apiKeySource, baseUrl, protocol, npmPackage }`；缺失抛 `PROVIDER_NOT_FOUND` / `CREDENTIAL` |
| `defaultModel()` | `string \| null` | 形如 `"deepseek:deepseek-chat"` |
| `setDefaultModel(ref)` | `void` | 校验 `provider:model` 与供应商存在 |
| `seed(configs)` | `void` | 幂等注册 |

`apiKeySource` 取值：`"ref"`（`apiKeyRef` 命中）、`"env"`（回退到 preset 的 `envKey`）、`"none"`（该供应商不需要密钥）。**密钥永不落库、永不进日志**：`providers` 表只存 `api_key_ref`。

---

## 5. `mik.models`（`ModelCatalog`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `list(providerId?)` | `ModelInfo[]` | 目录（可含 models.dev 与 provider API 来源） |
| `get(ref)` | `ModelInfo \| null` | `provider:model`，附带价格卡 |
| `refresh(providerId)` | `Promise<ModelInfo[]>` | 调供应商 API 重新发现；空结果不会清空已有目录 |

`ModelInfo`：`providerId`、`modelId`、`ref`、`displayName`、`contextWindow?`、`maxOutputTokens?`、`capabilities{text,image,toolCall,reasoning,structuredOutput}`、`pricing?`、`source`（`provider_api\|models_dev\|preset\|manual`）、`syncedAt?`。

---

## 6. `mik.pricing`（`PricingService`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `init()` / `refresh()` | `Promise<PricingState>` | 加载/刷新目录；**永不抛错**，失败降级为 `stale`/`error` |
| `state()` | `{ status: "fresh"\|"stale"\|"error"; loadedAt?; source?; lastError? }` | 当前状态 |
| `estimate(input)` | `CostInfo` | `{ model, at?, usage: Partial<TokenUsage> }` → 金额 |
| `priceFor(model, at?, facts?)` | `ModelPricing \| null` | 单价卡（含 `contextTierAbove` / `reasoningMode`） |
| `setOverride(o)` | `void` | 手动价，优先级最高；至少给 `inputPerM` 或 `outputPerM`，否则 `INVALID_REQUEST` |
| `removeOverride(modelId)` | `boolean` | 撤销手动价 |
| `listOverrides()` | `PricingOverride[]` | 手动价列表 |
| `candidates(model)` | `string[]` | llm-pricing 的匹配候选，供 UI 展示 |

价格优先级：**手动价 `pricing_overrides` > llm-pricing overrides > 上游目录 > 内置 archive 兜底**。断网时用本地快照继续计价（状态标 `stale`）；历史成本**永不重算**——事件落库即固化 `cost` / `pricing_source` / `pricing_basis`。

---

## 7. `mik.usage`（`UsageService`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `record(event)` | `boolean` | 幂等写入（`requestId` 重复返回 `false`）；正常由 `generate/stream/fetch` 自动调用 |
| `summary(query?)` | `UsageSummary` | 请求数、成功/失败、成本（含 low/high）、四类 token、缓存命中率、平均延迟 |
| `trends(query?, bucket?)` | `UsageTrendPoint[]` | 按 `"day"`（默认）或 `"hour"` |
| `byProvider(query?)` / `byModel(query?)` | `UsageBucket[]` | 分组汇总 |
| `query(filter?)` | `UsagePage` | 明细分页 `{ total, events }` |
| `get(requestId, options?)` | `UsageEvent \| null` | **默认只查本实例 appId**；`{ appId: "" }` 显式放开（调试用） |
| `rollupAndPrune(now?, retentionDays?)` | `number` | 全局维护：把所有 app 的过期明细折进 rollup 并删除 |
| `clear()` | `number` | 清空**本 app** 的明细 |

`UsageQuery`：`from`、`to`（epoch ms）、`appId`、`providerId`、`model`、`status`（`ok\|error`）、`sessionId`、`limit`、`offset`。

`UsageEvent`（明细）：`requestId`、`appId`、`ts`、`source`（`generate\|stream\|fetch`）、`providerId`、`modelRequested`、`modelActual`、`pricingModel?`、`usage`、`cost`、`latencyMs?`、`firstTokenMs?`、`status`、`errorCode?`、`isStreaming`、`sessionId?`、`tags?`、`pricingBasis?`、`pricingSource?`。

> 金额一律以**整数微美元**在 SQL 里聚合（`SUM(CAST(ROUND(cost*1000000) AS INTEGER))`），返回前才转回美元，避免浮点求和误差。

---

## 8. 低层入口

```ts
import { Store, ProviderRegistry, CredentialStore, PricingService, UsageService } from "model-infra-kit"
import { createServer } from "model-infra-kit/server"

const store = await Store.open({ path: "usage.db", driver }) // driver 可选：注入 better-sqlite3
const server = await createServer({ hub: mik, port: 3211, host: "127.0.0.1", token: process.env.MIK_SERVER_TOKEN })
console.log(server.url, server.port)
await server.close()
```

`Store.open({ path?, driver? })` → `{ providers, models, pricing, usage, settings, driver, close() }`。
`createServer(options)` → `{ url, port, host, sseClients, close() }`；`port: 0` 取随机端口；`token` 一旦设置，除 `GET /api/health` 外都需要 `Authorization: Bearer <token>`。

---

## 9. 错误

```ts
import { ModelInfraError, isModelInfraError } from "model-infra-kit"

try {
  await mik.generate({ messages })
} catch (error) {
  if (isModelInfraError(error)) console.error(error.code, error.message, error.retryable)
}
```

`ModelInfraErrorCode`：`AUTH`、`CONNECTION`、`RATE_LIMIT`、`MODEL_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`INVALID_REQUEST`、`PROVIDER`、`TIMEOUT`、`PRICING_UNAVAILABLE`、`CREDENTIAL`、`STORAGE`、`UNKNOWN`。

`message` 已脱敏，可直接展示给用户；原始错误保留在 `cause`。

---

## 相关文档

- 接入示例：[`../../examples/`](../../examples/)（`cli-agent` 嵌入式库、`openai-sdk` fetch 适配器、`python-host` 跨语言）
- 项目 README：[`../../README.md`](../../README.md)
- 契约：[`../../docs/interfaces.md`](../../docs/interfaces.md)；取舍：[`../../docs/decisions.md`](../../docs/decisions.md)
