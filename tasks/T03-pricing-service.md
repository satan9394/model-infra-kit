# T03 — 定价层（llm-pricing 封装）

**优先级**：P0（阻塞 T05）
**依赖**：T01
**契约**：`docs/interfaces.md` → T03 段
**拥有文件**：`src/pricing/**`、`test/pricing.test.ts`

## 目标

把 `llm-pricing@0.17.0` 包成 `PricingService`：目录/价格加载不阻塞、离线有兜底、逐请求精确计价、用户手动价优先级最高。

## 验收标准

1. `init()` **永不抛错**：断网时 `state().status` 为 `stale` 或 `error`，且 `estimate()` 仍能用内置 archive 出价。
2. `estimate({ model, at, usage })` 按 `docs/SPEC.md` 第 4 节的映射调用 `llm-pricing`：
   - `inputTokens = usage.input`、`cacheReadInputTokens = usage.cacheRead`、`cacheCreationInputTokens = usage.cacheWrite`、`outputTokens = usage.output`、`reasoningOutputTokens = usage.reasoning`
   - `inputIncludesCache: true`、`reasoningIncludedInOutput: true`、`perRequest: true`、`at`
   - 缺失字段传 `undefined`，**不得传 0**
3. 返回 `CostInfo`：`usd/low/high` 来自 `CostEstimate`，`basis` 来自 `estimate.basis`，`source` 来自 `pricing.source`，`pricingModel` 用 `estimate.pricing?.displayName ?? model`，`providerId` 用 `pricing.providerId`。
4. 价格优先级：存在 `pricing_overrides` 行时**直接用它**（`costFromRates` 纯算术），`source: "manual"`，且不再查上游。
5. 未定价模型：返回 `usd: 0` 且 `source: "missing"`，并 `onWarn` 一次（同一模型不重复刷屏）。
6. `candidates()` 透传 `llm-pricing` 的 `pricingCandidates`。
7. 目录缓存写到 `cacheDir`（默认 `~/.model-infra-kit/cache`），第二次 `init()` 不重复下载。
8. 单测覆盖：映射正确性（含缺失字段）、override 优先、未定价模型、断网降级（用不存在的 url 或 stub source）。**测试不得真的联网**。
9. `pnpm typecheck` 0 错误，`pnpm test` 全绿。

## 硬性约束

- 只依赖 `llm-pricing` **主入口**（`/internal` 无 semver 保证，禁止使用）。
- 金额在 SQL/聚合层一律微美元整数；本卡内计算沿用 llm-pricing 的美元浮点，但落库前不得再做浮点求和。
- 遵守 `AGENTS.md` 九条。

## 交证

按 `AGENTS.md` 的交证格式回报。
