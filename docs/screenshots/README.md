# 看板 UI 截图（`apps/dashboard`）

`apps/dashboard` 是 `model-infra-kit` 自带的用量看板（Next.js + Tailwind + Recharts，
端口 3210）。这里放它的**界面截图**，用于 README、PR 与设计评审——与
[`docs/diagrams/`](../diagrams/) 的架构图是两回事：那些是解释代码结构的图，这些是**产品自己的页面**。基于本目录截图走查产出的产品体验升级方案见 [`../plans/ui-ux-improvement-plan.md`](../plans/ui-ux-improvement-plan.md)。

## 环境

截图取自本机真实运行的服务，不是设计稿：

- `mik serve` @ `127.0.0.1:3211`（appId `ui-demo`，库为 `.tmp/ui-demo.db` 临时演示账本）
- `@mik/dashboard` 生产模式 @ `127.0.0.1:3210`
- 两个 OpenAI 兼容 mock 端点（3212 / 3213），供供应商连接测试与真实计量
- 桌面视口 1440×1000、`deviceScaleFactor=2`，深色主题（项目默认）；另附浅色与移动端各一张
- 数据：`pnpm --filter @mik/dashboard seed` 的 120 条基础用量 + 6 条 4 步链路（共 144 次请求、12 次失败）

## 索引

| 文件 | 页面 | 路由 | 说明 |
|---|---|---|---|
| `overview.png` | 概览 | `/` | 日期区间与过滤、总花费区间、请求数、token、缓存命中、平均/首 token 延迟、成本趋势、按供应商/模型明细 |
| `overview-light.png` | 概览（浅色） | `/` | 同一页面的浅色主题 |
| `overview-mobile.png` | 概览（390px） | `/` | 移动端响应式布局 |
| `trends.png` | 趋势 | `/trends` | 按天堆叠 input/output/cache 与成本、按天明细表 |
| `providers.png` | 供应商 | `/providers` | 已配置供应商、连接状态、启停、模型发现 |
| `models.png` | 模型目录 | `/models` | 标准模型机架（事实与端点分离）+ 本地目录、能力位、上下文、价格 |
| `pricing.png` | 价格表 | `/pricing` | 目录同步状态、手动价增删改、时段/批处理折扣说明 |
| `logs.png` | 请求日志 | `/logs` | 分页日志：四类 token、成本区间、延迟、状态、requestId |
| `traces.png` | 智能体任务链路 | `/traces` | 按 traceId 聚合的多轮调用：任务组、调用数、成本、Thinking token |
| `quotas.png` | 租户配额 | `/quotas` | 组织/应用层级配额与限流状态 |
| `webhooks.png` | Webhook 通知 | `/webhooks` | 通知订阅、投递状态与死信 |
| `connect.png` | 快速接入 | `/connect` | 客户端接入代码片段与 Playground |

### 嵌入版可视化（`embed-*`，用于 iframe）

看板还提供一组**专门用于嵌进宿主网页**的**可视化路由** `app/embed/*`——没有全局导航与页脚，
默认近 7 天、无筛选面板，SSE 实时增量仍生效，可直接 iframe 或由主站做路由反代：

| 文件 | 路由 | 说明 |
|---|---|---|
| `embed-overview.png` | `/embed/overview` | 嵌入版概览（总花费、请求数、token、成本趋势、按供应商/模型明细） |
| `embed-trends.png` | `/embed/trends` | 嵌入版趋势（按天堆叠 token + 成本折线 + 按天明细） |
| `embed-logs.png` | `/embed/logs` | 嵌入版请求日志（分页 + 检索） |
| `embed-pricing.png` | `/embed/pricing` | 嵌入版价格表（目录同步状态 + 手动价） |

用法（前提是先有一个在跑的 `mik serve`）：

```
# 主站把 /usage/* 反代到看板
location /usage/ { proxy_pass http://127.0.0.1:3210/embed/; }

<!-- 宿主页面里 -->
<iframe src="/usage/overview" style="width:100%;height:620px;border:0"></iframe>
```

> 这四张与完整版共用同一套组件与取数逻辑，差别只在布局外壳；接口契约见
> [`apps/dashboard/README.md`](../../apps/dashboard/README.md) 的「嵌入模式」一节。

> 另有两张在**空数据**下的页面（`providers` / `quotas` 的首次使用态）不单独出图，因为上面的
> 截图覆盖了已配置状态；空态由既有 E2E 用例保证。

## 复现

```bash
# 1) 主包构建（CLI 与 seed 都依赖 dist/）
pnpm --filter model-infra-kit build

# 2) 临时演示账本 + 供应商配置（.tmp/ 下，不入库）
#    mik serve 的供应商来自 mik.config.json 的 providers（不是共享账本）
MIK_DB=.tmp/ui-demo.db MIK_APP_ID=ui-demo MIK_CONFIG=.tmp/ui-demo/mik.config.json \
  node packages/mik/dist/cli.mjs serve --port 3211

# 3) 可选：mock 供应商端点（连接测试 / 真实计量）
node apps/dashboard/scripts/mock-openai.mjs            # 3212
node apps/dashboard/scripts/mock-openai.mjs --port 3213

# 4) 播种基础数据
MIK_DB=.tmp/ui-demo.db MIK_APP_ID=ui-demo pnpm --filter @mik/dashboard seed

# 5) 看板（生产模式；不要与 dev 混用，否则 .next 会被覆盖）
MIK_SERVER_URL=http://127.0.0.1:3211 pnpm --filter @mik/dashboard start

# 6) 截图
node .archify/shot-ui.mjs            # 10 个页面
node .archify/shot-ui-variants.mjs   # 浅色 + 移动端
```

截图脚本用 CDP 驱动真实 Chrome：先等到数据与图表稳定，再按内容高度整页截图；
`/`、`/trends`、`/logs` 等页面保持 SSE 长连接，所以不能等 network idle。

> 页面里的数字取决于演示库；重跑后数值会变，布局与结构不变。

## 备注：做图时踩到的一个真实契约点

`mik serve` 默认 `isolatedProviders: true`（`packages/mik/src/cli/context.ts:338`），
供应商由**启动时的配置**决定（`mik.config.json` 的 `providers`，`context.ts:336`），
**不读共享账本里的 providers 表**。所以「seed 写了库、serve 却显示 0 个供应商」是设计行为，
不是缺陷；要让看板显示供应商，必须给 serve 一份 `providers` 配置。

另外 `x-mik-span-type` 只接受 `root` / `reasoning` / `tool_call` / `generation`
（`packages/mik/src/server/span.ts:14`），其余取值会被 400 拒绝、**且不记账**——写链路数据时用错值
会静默少行。
