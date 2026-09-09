# T07 — HTTP 服务（`mik/server`）

**优先级**：P0（阻塞 T08/T09）
**依赖**：T05
**契约**：`docs/interfaces.md` → T06/T07 段（端点表）
**拥有文件**：`src/server/**`、`test/server.test.ts`

## 目标

让**任何语言**的宿主项目只改 `base_url` 就能接入并被计量，同时给看板提供数据与实时事件。

## 验收标准

1. `createServer({ hub, port?, host?, token? })` 返回 `{ url, close() }`；默认 `127.0.0.1:3211`。
2. **OpenAI 兼容端点**：`POST /v1/chat/completions` 支持流式与非流式、`GET /v1/models`。用 `openai` 风格的请求体（`model` 支持 `provider:model` 或裸名 + `X-ModelHub-Provider` 头）。错误按 OpenAI 错误结构返回：`{ error: { message, type, code } }`。
3. 鉴权：设了 `token` 时要求 `Authorization: Bearer <token>`，缺失/错误返回 401，且**不泄露**期望值。
4. **REST API** 按契约表的全部端点实现；统一支持 `from`/`to`（ISO 或 epoch ms）/`provider`/`model`/`status`/`limit`/`offset` 查询参数。
5. **SSE**：`GET /api/events` 推送 `usage.recorded` / `catalog.updated` / `pricing.updated`；心跳每 15s 一次；客户端断开要清理监听器（不泄漏）。
6. `GET /openapi.json` 返回合法的 OpenAPI 3.1 文档，覆盖上述端点。
7. 默认只监听 `127.0.0.1`；不允许把密钥回显到任何响应。
8. 单测：用 `fetch` 打真实起的服务（随机端口），覆盖 `/v1/chat/completions`（流式+非流式，走 mock provider）、401、`/api/usage/summary`、SSE 收到一条 `usage.recorded`、`/openapi.json` 可解析。**禁止真实外网调用**。
9. `pnpm typecheck` 0 错误，`pnpm test` 全绿。

## 硬性约束

- 用 Node 内置 `node:http`，不引入 Express/Fastify 等框架。
- 端口被占用时报错退出，不硬抢。
- 遵守 `AGENTS.md` 九条。
