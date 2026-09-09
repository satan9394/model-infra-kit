# @mik/dashboard — 用量看板

`model-infra-kit` 的薄看板：成本、token、供应商、模型目录、价格表与请求日志。

- 技术栈：Next.js App Router + Tailwind CSS v4 + Recharts（无组件库全家桶）
- 端口：**3210**（`AGENTS.md` 约定；起服务前先查占用，被占直接报错，不硬抢）
- 数据源：**只走 `mik serve` 的 HTTP API**，默认 `http://127.0.0.1:3211`。看板从不打开 SQLite 文件。

## 快速开始

```bash
# 1) 构建主包（CLI 与 dashboard 的 seed 都依赖它的 dist/）
pnpm --filter model-infra-kit build

# 2) 启动上游 HTTP 服务（默认 3211）
node packages/mik/dist/cli.mjs serve --port 3211
#    F06 已修复 CLI 的 server 加载路径（dist 与源码布局都能解析）。
#    apps/dashboard/scripts/serve-mik.mjs 是等价的备用启动器，仅在需要绕过 CLI 时使用。

# 3) 可选：写入假数据，把页面填满
pnpm --filter @mik/dashboard seed

# 4) 启动看板（3210）
pnpm --filter @mik/dashboard dev
#   → http://127.0.0.1:3210
```

> `next dev` 会覆盖 `.next` 里的生产产物：先 `pnpm build` 再 `pnpm start` 之间不要跑 `dev`，否则
> `next start` 会报 "Could not find a production build"。要切回生产模式就重新 `pnpm build`。

生产模式：

```bash
pnpm --filter @mik/dashboard build
pnpm --filter @mik/dashboard start      # next start -p 3210
```

`mik dashboard` 也会从仓库里找到本目录并 `next start -p 3210`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIK_SERVER_URL` | `http://127.0.0.1:3211` | 上游 `mik serve` 地址，仅服务端读取 |
| `MIK_SERVER_TOKEN` | 空 | `mik serve --token` 启动时填，只用于服务端请求，不下发浏览器 |
| `MIK_DB` / `MIK_APP_ID` | `~/.model-infra-kit/usage.db` / `default` | 只被 `scripts/seed.mjs` 使用，必须与 `mik serve` 一致 |

见 `.env.example`。**看板不读任何密钥明文**：`apiKeyRef` 只是 `env:NAME` / `file:path` 形式的引用，由 mik 在服务端解析。

## 页面

| 路径 | 内容 | 主要端点 |
|---|---|---|
| `/` | 日期区间（今日/7d/30d/自定义）+ 供应商/模型过滤；总花费、请求数、token 总量、缓存命中率、平均延迟、首 token 延迟；成本趋势图；按供应商/按模型明细 | `/api/health`、`/api/usage/summary|trends|by-provider|by-model` |
| `/trends` | 按天堆叠 input / output / cache_read / cache_write + 成本折线（双轴）+ 按天明细表 | `/api/usage/trends?bucket=day` |
| `/providers` | 列表、连接测试、模型列表/刷新、启用停用、删除、新增 | `/api/providers*` |
| `/models` | 目录：能力位、上下文、价格、来源；按供应商/能力/关键字过滤 | `/api/models`、`/api/models/:ref` |
| `/pricing` | 同步状态（含 `stale` 提示）、一键同步、手动价增删改 | `/api/pricing*` |
| `/logs` | 分页日志 + 详情抽屉（四类 token、四项成本、`pricing_source` / `pricing_basis`、延迟） | `/api/usage/logs`、`/api/usage/logs/:id` |

### 空数据与故障

- 任意页面在**零用量**下都能正常渲染：卡片显示 `—`，图表区显示空态文案。
- `mik serve` 不可用时页面**不崩**：顶部出现错误横幅（含 `netstat` 级别的排查提示），其余部分按空数据处理。
- 所有服务端取数都走 `mikTry()`（`lib/mik.ts`），永不抛错到 Next 的错误页。

### 实时更新

`components/live-refresh.tsx` 通过看板自己的 `/api/events` 订阅 `mik serve` 的 SSE：

- `usage.recorded` → 概览/趋势/日志页防抖 400ms 后 `router.refresh()`，数字自动更新；概览额外显示「本次会话新增 N 次调用 · $X」的即时计数。
- `catalog.updated` → 模型页刷新；`pricing.updated` → 价格页刷新。
- 事件流断开时 `EventSource` 自动重连，徽标显示「未连接」，不需要刷新页面。

SSE 由 `app/api/events/route.ts` 透传，浏览器因此不需要直连 3211（mik 服务默认不开 CORS）。

## 代理层

浏览器端的所有写操作（测试连接、价格覆盖、启停供应商）走 `app/api/mik/[...path]/route.ts`：

- 只允许 `[A-Za-z0-9._~:@-]` 的路径段，无 `..`、无分隔符；
- 方法、状态码、响应体原样透传；
- `MIK_SERVER_URL` 与 `MIK_SERVER_TOKEN` 只存在于服务端。

## seed 脚本

```bash
pnpm --filter @mik/dashboard seed                       # 30 天 / 120 条，先清空本 appId 的旧数据
pnpm --filter @mik/dashboard seed -- --days 7 --events 40 --no-reset
MIK_DB=./.tmp/demo.db MIK_APP_ID=demo pnpm --filter @mik/dashboard seed
```

写入内容：2 个供应商（含一个启用中的 `mock-gateway`）、6 条模型目录记录、2 条手动价、120 条用量事件（跨 30 天、含失败请求、缓存 token、四类成本与 `pricing_source`/`pricing_basis`）。

脚本直接调用 `model-infra-kit` 的公开 API（`Store` / `UsageService` / `ProviderRegistry`）写同一个数据库，**不经过 HTTP、不联网**；`appId` 会先尝试从 `/api/health` 读取，确保与正在运行的服务一致。

### mock 供应商（可选）

`scripts/mock-openai.mjs` 是一个极小的 OpenAI 兼容服务（默认 3212），用于让「测试连接」「刷新模型」以及真实的计量链路可验证：

```bash
node apps/dashboard/scripts/mock-openai.mjs
# 然后在 /providers 页对 mock-gateway 点「测试连接」
# 或产生一条真实用量（会触发 SSE）：
curl -s -X POST http://127.0.0.1:3211/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock-gateway:mock-chat-pro","messages":[{"role":"user","content":"hi"}]}'
```

## 已知限制（契约层面）

- **appId 过滤不可用**：`mik serve` 的 `/api/usage/*` 刻意不暴露 `appId` 参数（`docs/interfaces.md` 注释：HTTP 面不得绕过 `UsageService` 的 app 隔离）。概览页显示当前 appId 供参考，过滤只按 `provider` / `model` / `status`。
- **「设为默认」不可用**：HTTP 面没有 `defaultModel` 端点（`registry.setDefaultModel` 只在进程内可用），按钮保留但禁用并带说明。
- **模型价格需要逐个补齐**：`GET /api/models` 不返回 `pricing`，只有 `GET /api/models/:ref` 会附上。`/models` 页因此用有界并发（8）补齐前 150 条模型的价格；超出部分只显示能力位与上下文。
- **`mik serve` 当前不可用**（属 T07，不在本卡范围）：`packages/mik/dist/cli.mjs` 的 `serve` 子命令用 `../server.mjs` 相对 `dist/` 解析 server 包，路径越界，报
  `Could not load the HTTP server (mik/server)`。本目录的 `scripts/serve-mik.mjs` 用公开入口（`model-infra-kit` + `model-infra-kit/server`）等价启动，T07 修复后可弃用。

## 自证

```bash
pnpm --filter @mik/dashboard typecheck     # tsc --noEmit
pnpm --filter @mik/dashboard build         # next build
node apps/dashboard/scripts/check-port.mjs 3210   # 端口守卫（dev/start 会先跑它）
```
