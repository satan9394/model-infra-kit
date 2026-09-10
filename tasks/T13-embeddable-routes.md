# T13 — 看板可嵌入路由（embed 路由组）

**目标**：宿主网页不用克隆仓库，也能把用量可视化嵌进自己的页面（iframe 或反向代理）。
**拥有文件**：`apps/dashboard/**`（仅新增/修改该目录内文件）
**别的文件一律不改**（README/playbook 由指挥在收卡后同步）。

## 背景（来自 `docs/integration-playbook.md` §5）

看板是独立 Next.js 应用，只走 `mik serve` 的 `/api/*`、不读 SQLite、不随 npm 包发布。网页端要可视化的三条路里，「直接复用 dashboard」最大的问题是它带全套页面 chrome（全局 Nav/footer 与主题），当「另一个应用」嵌进主站观感割裂。

## 交付

1. **新增 `apps/dashboard/app/embed/` 路由组**，**没有全局导航/页脚**（独立 layout，可加一个极简「返回完整版」链接）：
   - `/embed/overview` 概览（cost / requests / tokens / 缓存命中 / 延迟卡片 + 30 天趋势）
   - `/embed/trends` 趋势（堆叠 token + 成本双轴）
   - `/embed/logs` 请求日志分页
   - `/embed/pricing` 价格表 + 手动价
   - `/embed/providers` 供应商列表（可选，能省则省）
   复用现有 `components/*` 与 `lib/*`，**不要重写取数逻辑**。
2. **运行时可用**：`pnpm --filter @mik/dashboard build && start`（3210）后，`/embed/*` 全部 200 且含真实数据（先 seed）。
3. **SSE 实时增量在 embed 页同样生效**（复用 `use-events` + `live-refresh`）。
4. `apps/dashboard/README.md` 增加「嵌入模式」一节：
   - **iframe 模式**：`<iframe src="https://主站/usage"></iframe>`，主站把 `/usage/*` 反代到 `3210/embed/*`
   - **路由挂载模式**（宿主是 Next.js）：把 `apps/dashboard` 的 `components/` `lib/` `app/embed/` 拷进宿主，宿主自己的 `app/api/mik/[...path]` 与 `/api/events` 代理已就绪时即可用
   - **共同前提**：宿主的浏览器不能直连 3211（无 CORS），必须走主站代理 `/api/mik/*` 与 `/api/events`
   - 说明 `MIK_SERVER_URL`/`MIK_SERVER_TOKEN` 是服务端环境变量

## 验收（真跑并贴输出）

1. `pnpm --filter @mik/dashboard build` 成功（路由表里出现 `/embed/*`）。
2. seed 后 `pnpm --filter @mik/dashboard start`，`curl` 每个 `/embed/*` 返回 200 且 HTML 含真实数字（成本/请求数/模型名）。
3. 完整版路由（`/` 、`/trends`、`/logs` 等）不回归，仍 200。
4. `apps/dashboard/README.md` 新增的嵌入一节可照着操作。
5. 不改 `packages/mik/**`、`scripts/e2e/**`、根 `README.md`、`docs/**`。
6. 跑完停掉所有进程，不留监听端口。

## 交证

按 `AGENTS.md` 格式，贴 `/embed/*` 的 curl 输出与路由表。