# F16 — S5 429/超时映射缺测试 + S8 契约漂移补录

**来源**：`docs/reviews/R02-final-review.md` S5 / S8
**拥有文件**：`test/errors.test.ts`、`docs/interfaces.md`

## 缺陷

1. **S5**：`toModelInfraError` 的 429（`RATE_LIMIT`）与超时（`TIMEOUT`）分支没有测试。
2. **S8**：以下公共成员未进 `docs/interfaces.md`（违反 AGENTS 规则 5）：`UsageService.currentAppId` / `isEnabled`、`ProviderRegistry.splitModelRef` / `MODEL_REF_SEPARATOR` / `DEFAULT_MODEL_SETTING` / `PROTOCOL_PACKAGES` / `packageForProtocol`、`src/ai` 的 `SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS` / `loadProviderFactory` / `DiscoveredModel`、`createMikFetch` / `readOpenAiUsage`、`X-ModelHub-Provider` 请求头。

## 修法

1. `test/errors.test.ts` 补：429 → `RATE_LIMIT` 且 `retryable === true`；超时（`ETIMEDOUT` / `AbortError` / 504）→ `TIMEOUT` 且 `retryable === true`；并断言这些分支的 message 也经过脱敏。
2. `docs/interfaces.md` 增加「附加公共面（additive）」一节，逐项列出上面成员的签名与语义；标注哪些属于稳定契约、哪些是 `@internal` 风格（不进 semver 保证）。

## 验收（逐条真跑并贴输出）

1. `pnpm exec vitest run test/errors.test.ts` 全绿，新增用例覆盖 429/超时，测试数只增不减。
2. `docs/interfaces.md` 新增一节；用 `grep` 证明上面列出的每个成员都能在该文件里找到。
3. `pnpm exec tsc --noEmit` 0 错误。
4. 不改任何 `src/**`（本卡只补测试与文档）。
