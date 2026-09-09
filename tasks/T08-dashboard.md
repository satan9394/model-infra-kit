# T08 — 用量看板（`apps/dashboard`）

**优先级**：P1
**依赖**：T07
**契约**：消费 T07 的 `/api/*` 与 `/api/events`
**拥有文件**：`apps/dashboard/**`

## 目标

一个能独立跑起来的薄看板：按日期/供应商/模型/appId 看用量与花费。

## 页面

- `/` 概览：日期区间（今日/7d/30d/自定义）+ appId/供应商/模型过滤；卡片显示总花费、请求数、token 总量、缓存命中率、平均延迟、首 token 延迟；近 30 天成本趋势图。
- `/trends`：按天堆叠面积图（input / output / cache_read / cache_write）+ 成本折线（双轴）。
- `/providers`：供应商列表、连接状态、测试连接按钮、模型列表、设为默认。
- `/models`：模型目录（能力位、上下文、价格、来源），按供应商/能力过滤。
- `/pricing`：价格表、手动覆盖表单、同步状态（含 `stale` 提示）、一键同步。
- `/logs`：请求日志分页 + 详情抽屉（四类 token、四项成本、`pricing_source`、`pricing_basis`、延迟）。

## 验收标准

1. `pnpm --filter dashboard dev` 起在 **3210**（先查端口占用，被占则报错而不是硬抢）。
2. 数据全部来自 `MIK_SERVER_URL`（默认 `http://127.0.0.1:3211`），不在前端直连 SQLite。
3. 概览/趋势/日志三页在**空数据**下不崩，显示空态文案。
4. 实时增量：`/api/events` 收到 `usage.recorded` 时概览数字自动更新（不需要手动刷新）。
5. `pnpm --filter dashboard build` 成功（Next.js 生产构建无错误）。
6. 提供一个 seed 脚本或说明，能用假数据把页面填满以便验收。

## 硬性约束

- 技术栈固定 Next.js App Router + Tailwind + Recharts。
- 不引入组件库全家桶；需要就手写。
- 遵守 `AGENTS.md` 九条（尤其端口与密钥脱敏）。
