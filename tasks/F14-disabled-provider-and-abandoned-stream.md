# F14 — S3 禁用的供应商仍被路由 + S6 放弃的流记成 ok+$0

**来源**：`docs/reviews/R02-final-report` S3 / S6
**拥有文件**：`src/hub.ts`、`test/hub.test.ts`

## 缺陷

1. **S3**：`enabled: false` 只影响后台目录同步，`generate`/`stream`/`fetch` 仍会路由到该 provider（实测真出网）。禁用应当是硬约束。
2. **S6**：F05 加的 `finally` 兜底在「消费者中途放弃、且没等到 error/finish」时写 `status: "ok"` + `cost.source: "missing"`，把一次**未完成**的调用记成成功。

## 修法

1. 解析/路由时校验 `record.enabled`：被禁用的 provider 抛 `ModelInfraError`（code `PROVIDER_NOT_FOUND` 或 `INVALID_REQUEST`，message 明确「provider X is disabled」）。`fetch` 路径同样校验。
2. `finally` 兜底：若尚未记录且流未正常结束（没有 `finish`），写 `status: "error"`、`errorCode: "ABANDONED"`（保持 `cost.source: "missing"`）。正常结束路径不变。

## 验收（逐条真跑并贴输出）

1. 把 provider 置 `enabled:false` → `generate` / `stream` / `fetch` 三条路径都抛/返回明确错误，且**没有出网**（mock server 调用计数为 0）。
2. 消费者在第一个 `text_delta` 就 `break` → 落库行 `status === "error"` 且 `errorCode === "ABANDONED"`；把 F05 的 `["ok","error"]` 松断言收紧为精确值。
3. 正常完成（不 break）仍是 `status: "ok"`。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/hub.test.ts test/fetch.test.ts test/server.test.ts` 全绿，测试数只增不减。
5. 不改 `src/registry/**`（F13 拥有）、`src/store/**`（F15 拥有）。
