# T04 — UsageService（计量门面）

**优先级**：P0（阻塞 T05）
**依赖**：T01（存储层已完成）
**契约**：`docs/interfaces.md` → T04 段
**拥有文件**：`src/usage/**`、`test/usage.test.ts`

## 目标

给宿主一个稳定的用量门面：写入事件、查询、聚合、维护 rollup，并在写入时通知监听者（看板 SSE 与 CLI 实时刷新都靠它）。

## 验收标准

1. `record()` 自动补 `appId`（调用方未给时用 deps.appId），`request_id` 重复时返回 `false` 且不覆盖已有行。
2. `record()` 成功后触发 `onEvent(event)`；`enabled: false` 时直接返回 `false` 且不落库。
3. `summary/trends/byProvider/byModel/query/get` 全部透传到 `store.usage`，并默认带上 `appId` 过滤（调用方显式传了 `appId` 则尊重调用方）。
4. `rollupAndPrune()` 透传，返回删除条数。
5. `clear()` 只清本 app 的数据，返回删除条数。
6. 单测覆盖：幂等、appId 补全、enabled=false、onEvent 触发一次、按 appId 隔离（两个 app 的数据互不串）。
7. `pnpm typecheck` 0 错误，`pnpm test` 全绿（含 T01/T02/T03 的测试）。

## 硬性约束

- 不修改 `src/store/**`；如果发现存储层缺能力，在交证里提，不要自己改。
- 遵守 `AGENTS.md` 九条。
