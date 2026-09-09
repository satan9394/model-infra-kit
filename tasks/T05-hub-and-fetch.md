# T05 — ModelInfra 主类 + fetch 适配器（集成核心）

**优先级**：P0（阻塞 T06/T07/T08/T09）
**依赖**：T02、T03、T04
**契约**：`docs/interfaces.md` → T05 段
**拥有文件**：`src/hub.ts`、`src/fetch.ts`、`src/index.ts`、`test/hub.test.ts`、`test/fetch.test.ts`

## 目标

把 registry / ai bridge / pricing / usage 缝成一个门面：`ModelInfra.init()` 之后，`generate` / `stream` / `fetch` 三条路径都能用，且每次调用自动计量。

## 验收标准

1. `ModelInfra.init()` 在**没有任何 provider** 时也能成功（不抛错）；`syncCatalog` 默认开启但失败只 `onWarn`。
2. 模型解析：`"provider:model"` 直拆；裸名走 `providers.defaultModel()` 的 provider；都缺 → `ModelInfraError(code: INVALID_REQUEST)`；provider 不存在 → `PROVIDER_NOT_FOUND`。
3. `generate()`：
   - 调用 AI SDK `generateText`（`stopWhen` 支持工具多步，默认 `stepCountIs(5)`）
   - 返回 `text` / `toolCalls` / `finishReason` / `usage` / `cost` / `provider` / `model{requested,actual}` / `latencyMs` / `firstTokenMs?` / `steps`
   - `usage` 由 AI SDK `LanguageModelUsage` 归一化：`input = inputTokens`、`cacheRead = inputTokenDetails.cacheReadTokens`、`cacheWrite = inputTokenDetails.cacheWriteTokens`、`output = outputTokens`、`reasoning = outputTokenDetails.reasoningTokens`（缺失一律 0，但传给 pricing 的字段要区分“缺失”与 0）
   - `cost` 来自 `pricing.estimate({ model: 实际模型 id, at: 请求时刻, usage })`
   - 无论成功失败都要 `usage.record()`（失败记 `status:"error"` + `errorCode`）
4. `stream()` 产出 `StreamEvent` 序列：至少 `text_delta`、`tool_call_complete`、`step_finish`、`usage`、`finish`、`error`；流结束前必须记录用量。
5. `mik.fetch`：实现 `typeof fetch`，把 OpenAI 兼容请求转发到**已配置的 provider**（按 `model` 字段解析 provider），并把响应里的 `usage` 落库；`mik.baseUrl` 返回 `"http://127.0.0.1/v1"` 形态的占位（真实端口由 T07 server 注入）。
6. 密钥/Authorization 不出现在任何返回结构或日志里。
7. 单测：用 `@ai-sdk/test-server` 起 mock provider，覆盖 generate 成功/失败、stream、fetch 转发、模型解析错误、用量落库断言（`store.usage.query()` 能查到）。**禁止真实外网调用**。
8. `pnpm typecheck` 0 错误，`pnpm test` 全绿。

## 硬性约束

- 不得把 provider 特例写进 hub；协议解析全部走 T02 的 `AiBridge`。
- 遵守 `AGENTS.md` 九条。

## 指挥补充（来自 T03/T04 交证，必须照做）

1. `ModelInfra.init()` 里要 `await pricing.init()`：`PricingService.estimate()` 是同步的，冷启动首次调用会退回内置 archive 出价。init 等待一次即可拿到实时目录。
2. `usage.record()` 的 `onEvent` 回调**必须自行 try/catch**：T04 的实现会让回调异常向上冒泡（此时行已落库）。hub 注入的回调（SSE 广播 / 用户监听器）不得把 record 变成抛错路径。
3. T03 的 `PricingServiceDeps` 额外有可选 `catalog` / `fetch` 注入口，hub 正常路径不用传。
