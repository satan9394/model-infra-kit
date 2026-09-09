# F03 — T04 修复卡（评审 B1 / S5 / S6 文档）

**来源**：`docs/reviews/T02-T04-review.md`
**依赖**：无
**拥有文件**：`src/usage/**`、`test/usage.test.ts`

## 必修

1. **B1 `get()` 按 appId 隔离**（阻断级）
   - 签名改为 `get(requestId: string, options?: { appId?: string }): UsageEvent | null`（契约已改）。
   - 默认用实例的 `appId` 过滤：事件属于别的 app 时返回 `null`。
   - `options.appId === ""` 显式关闭过滤（调试用，语义与 `scoped()` 一致）。
   - **改掉反向断言**：`test/usage.test.ts:163-172` 现在把「app A 能读到 app B 的明细」写成期望，必须改成「读不到（返回 null）」，并补一条 `{appId:""}` 能读到的测试。

2. **S5 `record()` 包住 `onEvent`**
   - `onEvent` 抛错不得冒泡；捕获后交 `onWarn`（`UsageServiceDeps` 增加可选 `onWarn`）。
   - 补测试：监听器抛错时 `record()` 仍返回 `true` 且 `onWarn` 被调用一次。

3. **S6 文档化 `rollupAndPrune()` 的全局语义**
   - 在方法注释里写明：这是**全局维护操作**，会把所有 app 的过期明细折进 rollup 并删除，与 app 级的 `clear()` 不同。
   - 契约已同步。不需要改行为。

## 验收

- `pnpm exec tsc --noEmit` 0 错误。
- `pnpm exec vitest run test/usage.test.ts` 全绿，测试数只增不减。
- 不得改动其它卡的文件（`src/store/**` 不动；`rollup` 的 app 过滤本次不做）。
