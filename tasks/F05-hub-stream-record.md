# F05 — T05 流式记账时机修复（T07 实测发现）

**来源**：T07 交证风险 ②，指挥已复核确认为真
**拥有文件**：`src/hub.ts`、`test/hub.test.ts`

## 缺陷（已定位）

`src/hub.ts` 的 `stream()` 生成器：
- 循环里遇到 `error` / `abort` 会 `yield { type: "error" }`（L559-572）；
- 记账发生在**循环之后**（L610-626 失败路径、L632-645 成功路径）。

后果：消费者收到 `error` 事件后 `break` 退出 for-await，生成器被 `return()` 提前关闭，**循环之后的 `record()` 永不执行** → 这次调用的用量行彻底丢失（既没成功行也没失败行）。

T07 已在 HTTP 层用「drain 到 done」兜底，但任何直接 `for await (const ev of hub.stream(...))` 的宿主都会中招。

## 修法

把两条路径的 `record()` 收进 `finally`（生成器被 `return()` 时会执行 `finally`），保证：
1. 消费者提前 break 也落库；
2. 不重复落库（`request_id` 幂等已保证，但不要在同一路径写两次）；
3. 成功路径仍在 `yield { type: "finish" }` **之前**落库（保持现有语义）。

## 验收

- 新测试：mock provider 返回中途错误 → `for await` 收到 `error` 后立刻 `break` → 断言 `usage.query().total === 1` 且 `status === "error"`。
- 新测试：成功流中收到 `finish` 后立刻 `break` → 断言已落库且 `status === "ok"`。
- 新测试：消费者在第一个 `text_delta` 就 `break`（连 error/finish 都没等到）→ 仍必须落一行（`status` 取当时已知状态，允许 `error` 或 `ok`，但**必须存在**）。
- 回归：`pnpm exec vitest run test/hub.test.ts test/fetch.test.ts test/server.test.ts` 全绿，测试数只增不减。
- `pnpm exec tsc --noEmit` 0 错误。

## 注意

- `src/server/**`、`src/cli/**` 已由 T06/T07 落地，**不要改**；若发现它们的 drain 逻辑与本修复冲突，在交证里提，不要自行修改。
