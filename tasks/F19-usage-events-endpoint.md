# F19 — 实现 `POST /api/usage/events`（宿主自己调模型、只上报用量）

**来源**：T11 发现的 P0 缺口（契约里写了但从未实现，实测 404）
**契约**：`docs/interfaces.md` 已写好该端点（见「`POST /api/usage/events`（F19）」一节），**照它实现，不要改契约**
**拥有文件**：`src/server/api.ts`、`src/server/openapi.ts`、`test/server.test.ts`

## 背景

五种接入面里有一种是「宿主自己调模型，只把用量上报给 mik 统一记账」。进程内 `usage.record()` 可用，但 HTTP 侧没有入口，跨语言宿主用不了。T11 实测：
```
POST /api/usage/events → 404 {"error":{"code":"NOT_FOUND","message":"No route matches /api/usage/events."}}
```

## 要求

1. 按契约实现：单条或 `{ events: [...] }` 批量（上限 500 条），返回 `{ accepted, duplicates, rejected }`。
2. 校验：`requestId` 与 `providerId` 必填非空字符串；`usage` 的每个字段必须是非负整数（缺失按 0，但**不要伪造** `cacheWrite`）；非法项进 `rejected`（带 `index` 与 `reason`），不影响合法项落库。
3. 未给 `cost` 时服务端用 `pricing.estimate({ model: modelActual ?? modelRequested, at: ts, usage })` 计价，落 `pricingSource`/`pricingBasis`。
4. 落库 `source` 固定 `"report"`；`appId` 缺省用服务端 appId，显式给出则用它。
5. `tags` 的值经 `redactDeep` 脱敏后入库。
6. 鉴权与其它端点一致（设了 token 就必须带 `Bearer`）。
7. `GET /openapi.json` 必须包含该端点（否则契约与文档不一致）。

## 验收（逐条真跑并贴输出）

1. 单条上报 → `accepted: 1`；`GET /api/usage/logs` 能查到该行，`source === "report"`。
2. 重复 `requestId` 再报一次 → `duplicates: 1` 且库中仍只有 1 行、金额未被覆盖。
3. 未给 `cost` 的上报 → 服务端算出了非零成本（用可定价的模型名，例如 `deepseek-chat`）。
4. 批量 3 条（1 条合法 + 2 条非法）→ `accepted: 1`、`rejected: 2`（带 index/reason）。
5. 超过 500 条 → 400 且错误可读。
6. 未带 token（服务端设了 token 时）→ 401。
7. `GET /openapi.json` 解析后包含 `/api/usage/events`。
8. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/server.test.ts` 全绿，测试数只增不减。

## 注意

- 不改 `src/hub.ts`、`src/usage/**`、`src/store/**`、`docs/interfaces.md`、`README.md`、`apps/dashboard/**`。
- 用 `@ai-sdk/test-server` 或直接构造 hub（`:memory:` db）测，禁止外网。
