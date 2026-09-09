# F02 — T03 修复卡（评审 S1 / S2 / S3 / S4 / S14 + 漏测）

**来源**：`docs/reviews/T02-T04-review.md`
**依赖**：无
**拥有文件**：`src/pricing/**`、`test/pricing.test.ts`

## 必修

1. **S1 手动价命中不再碰上游**：把 `findOverride` 判定提到 `warm()` 之前（`service.ts:109-113`）。补测试：override 命中时 `catalog.ensureLoaded`/`estimate` 均未被调用。
2. **S2 入参类型**：`EstimateInput.usage` 改为 `Partial<TokenUsage>`（契约已改）。去掉 `service.ts:205` 的 `as unknown as TokenCounts`。补一条「从 AI SDK 形状（含 `cacheWriteTokens` 缺失）到 `estimate()`」的端到端测试。
3. **S3 手动价校验**：`setOverride()` 至少给 `inputPerM` 或 `outputPerM`，否则抛 `ModelInfraError` code `INVALID_REQUEST`。补测试。
4. **S4 `priceFor()`**：
   - 也调用 `warm()`（与 `estimate()` 一致）。
   - 返回的 `ModelPricing` 带上 `contextTierAbove` / `reasoningMode`（`ModelPricing` 需要加这两个可选字段——这是契约增量，已批准）。
   - 补测试：分档模型返回 `contextTierAbove`。
5. **S14 `warnedMissing` 上限**：超过 1000 条时清空（或改 LRU），避免长进程单调增长。补测试：塞 1001 个模型不炸、内存不失控（断言集合大小）。
6. **S10 删掉恒真断言** `test/pricing.test.ts:264-270` 的 `toEqual(pricingCandidates(x))`。

## 补漏测（S11）

- `CostInfo.providerId` 透传：用带 `providerId` 的 stub 卡断言。

## 验收

- `pnpm exec tsc --noEmit` 0 错误。
- `pnpm exec vitest run test/pricing.test.ts` 全绿，测试数只增不减。
- 不得改动其它卡的文件（`src/types.ts` 的 `ModelPricing` 若需加字段，由指挥统一改，见 F04）。
