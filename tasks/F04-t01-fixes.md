# F04 — T01 修复卡（评审 S15 + 契约增量）

**来源**：`docs/reviews/T02-T04-review.md`
**依赖**：无
**拥有文件**：`src/credential/**`、`test/credential.test.ts`
**指挥本人负责**：`src/types.ts` 的契约增量（见下，Worker 不要动 types.ts）

## 必修（Worker）

1. **S15 删除走「回收站」语义**：`src/credential/store.ts:114` 用了 `rmSync`，违反 `AGENTS.md` 第 8 条。
   - 改为把文件**移动**到 `~/.model-infra-kit/trash/<basename>.<timestamp>`（目录不存在则创建），而不是直接删。
   - 目标位置可被 `CredentialStoreOptions.trashDir` 覆盖（默认 `~/.model-infra-kit/trash`），方便测试。
   - 补测试：`delete()` 后原路径不存在、trash 目录里出现同名文件。

## 指挥并行改动（Worker 知悉即可，不要动）

`src/types.ts` 将追加两处契约增量：
- `ModelPricing` 增加可选 `contextTierAbove?: number` 与 `reasoningMode?: boolean`（供 F02 的 `priceFor()` 透传）。
- `EstimateInput.usage` 相关：`TokenUsage` 本身保持必填，价格入参改 `Partial<TokenUsage>`（在 pricing 层）。

## 验收

- `pnpm exec tsc --noEmit` 0 错误。
- `pnpm exec vitest run test/credential.test.ts` 全绿，测试数只增不减。
