# 接入方式全景与运营分析（Integration Playbook）

> 回答两个问题：**这个模块接进别的功能模块，究竟有哪些方式？** 以及 **网页端要不要自带可视化？**
> 本文只写仓库里能验证的事实。每条命令、每个端点、每个端口都在文末「核对附录」给出出处；**没有出处的能力一律不写**。

---

## 0. 结论速览

1. **三种调用面已经落地**（嵌入式库 / `mik.fetch` 适配器 / HTTP+OpenAI 兼容端点），第四种（HTTP API + SSE）是给「自建 UI」用的读接口。
2. **第五种调用面「用量事件上报 `POST /api/usage/events`」已补齐**（F19 实现，本文初稿时还是 404）。宿主自己直连供应商、只把 token 上报进来的场景现在有 HTTP 入口了；进程内的 `usage.record()` 同样可用。
3. **库本身不含任何 UI。** 看板是仓库内的独立 Next.js 应用（`apps/dashboard`），只走 `mik serve` 的 HTTP API，不读 SQLite，且 `packages/mik/package.json` 的 `files` 只有 `dist` 与 `LICENSE`——**装包用户拿不到看板**。
4. **网页端可视化的推荐结论**：正式产品走「复用 `/api/*` 自建 UI」；只想看成本、不介意多一个进程走「sidecar 反向代理」；接受 Next.js/Tailwind 技术栈且想最快见效走「直接复用 `apps/dashboard`」。三种做法都**必须先有一个在跑的 `mik serve`**。

---

## 1. 前置事实（选路之前必须知道的边界）

| 事实 | 出处 |
|---|---|
| 三个公共入口：`model-infra-kit`（库）、`model-infra-kit/server`（`createServer`）、`model-infra-kit/cli`（`main`） | `packages/mik/src/index.ts`、`packages/mik/package.json` 的 `exports` |
| 库只有一个 npm 包 `model-infra-kit`（当前 `0.1.1`，Releases 页提供 tarball），`bin` 是 `mik` | `packages/mik/package.json`、GitHub Releases |
| `@ai-sdk/*` 是**可选 peer**，用哪个协议装哪个包；缺包时 `loadProviderFactory()` 给出「装哪个包」的可读错误 | `packages/mik/README.md`、`packages/mik/src/index.ts` 导出 `loadProviderFactory` |
| Node ≥ 22.13（`node:sqlite`），本机 24.14 | `README.md`、`packages/mik/package.json` 的 `engines` |
| 端口：`mik serve` **3211**、看板 **3210**、示例 mock 供应商 **3212** | `README.md` 端口表、`apps/dashboard/package.json`、`apps/dashboard/scripts/mock-openai.mjs` |
| 禁止使用 3080 / 3001 / 3111 / 8899（已被本机其它项目占用） | `README.md`、`AGENTS.md` |
| 看板不随 npm 包发布；装包环境跑 `mik dashboard` 会报错并给指引 | `packages/mik/package.json` 的 `files`、`README.md`「看板」一节 |
| 看板只走 HTTP API，从不打开 SQLite | `apps/dashboard/lib/config.ts`、`apps/dashboard/README.md` |
| `mik serve` 默认不开 CORS（`cors` 选项默认关闭，CLI 无 `--cors` 开关） | `packages/mik/src/server/server.ts` 的 `ServerOptions.cors`、`packages/mik/src/cli/args.ts` 的 `serve` flags |
| 同一次调用只计量一次：三条路径共用同一套注册表/价格目录/用量库 | `README.md`「三种接入方式」 |

---

## 2. 矩阵 A：调用面（宿主怎么调）

行 = 5 种调用面，列 = 卡片要求的 5 个维度。

| 调用面 | 适用场景 | 改动量 | 跨语言 | 实时用量 | 失败模式 |
|---|---|---|---|---|---|
| ① 嵌入式库 `ModelInfra.init()` → `generate/stream` | 自研 CLI Agent、后端服务、量化项目，宿主自己写调用代码 | 最小 ~10 行（`README.md` 快速开始）；完整走查示例 175 行（`examples/cli-agent/index.ts`） | 否，仅 JS/TS | 是：`reply.usage` / `reply.cost` 同步返回，`mik.usage.summary()` 立即反映 | `init()` 不因目录/价格/模型同步失败而抛错（降级 + `onWarn`）；调用失败抛 `ModelInfraError`（`AUTH/CONNECTION/RATE_LIMIT/...`），且**失败也计量** |
| ② `mik.fetch` 适配器（已有 OpenAI SDK 代码） | 已经在用 `openai` SDK 的项目，业务代码不想动 | 2 行：`new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })`；示例 102 行（`examples/openai-sdk/index.ts`），业务代码 0 行改动 | 否，仅 JS/TS | 是：响应原样返回，mik 读克隆计价落库；`source=fetch` | 供应商未配置 → HTTP 404 `PROVIDER_NOT_FOUND`；缺凭据 → 401 `CREDENTIAL`；调用方自带认证头被剥离；**流式中途断开时该次调用不落库**（`docs/reviews/R02-final-review.md` 记为未覆盖） |
| ③ HTTP + OpenAI 兼容端点（`mik serve` → `/v1/chat/completions`） | Python/Go/任何语言项目；多进程共用一个模型层 | 宿主 0 行（只改 `base_url`）；Python 示例 62 行纯标准库（`examples/python-host/host.py`） | 是，只要客户端说 OpenAI 协议 | 是：响应体带 `usage`，并额外带 `x_modelhub`（provider / model_requested / cost_usd / cost_source） | 端口被占直接拒绝启动（`assertPortFree`）；`--token`/`MIK_SERVER_TOKEN` 时除 `GET /api/health` 外都要 `Authorization: Bearer`；裸模型名需 `X-ModelHub-Provider` 头或已设默认模型，否则 400 `INVALID_REQUEST` |
| ④ HTTP API + SSE（`/api/*` + `GET /api/events`） | 自建 UI、外部脚本取汇总、实时数字刷新 | 读接口每个几行 `fetch`；SSE 订阅参考 `apps/dashboard/components/live-refresh.tsx`（92 行） | 是（纯 HTTP/JSON + text/event-stream） | 是：SSE 推 `usage.recorded` / `catalog.updated` / `pricing.updated`，心跳 15s | 上游不可达时页面/脚本必须自己降级（看板用 `mikTry()` 永不抛错到 Next 错误页）；**`/api/usage/*` 刻意不暴露 `appId` 过滤**；`GET /api/models` 不返回 `pricing`，只有 `GET /api/models/:ref` 带 |
| ⑤ 用量事件上报 `POST /api/usage/events` | 想把宿主「自己直连供应商」的用量灌进同一本账 | 宿主每次调用后一个 `fetch`（单条或 `{events:[...]}` 批量，上限 500） | 是（纯 HTTP/JSON） | 是：写入后 `GET /api/usage/*` 与 SSE `usage.recorded` 立即反映 | **已实现（F19）**：返回 `{accepted,duplicates,rejected}`；`requestId` 重复计入 `duplicates` 且不覆盖；不给 `cost` 时服务端用 `pricing.estimate()` 计价；落库 `source="report"`、`tags` 值经 `redactDeep` 脱敏。契约见 `docs/interfaces.md` |

### 2.1 逐面补充（照着敲就能跑）

**① 嵌入式库**

```bash
npm i model-infra-kit
# 还要装你实际用的 provider 包，例如：npm i @ai-sdk/openai-compatible
export DEEPSEEK_API_KEY=sk-...
node quickstart.ts
```

要点：`init()` 只接受 `appId/db/providers/defaultModel/...`，**不暴露 `driver` 开关**；要换 `better-sqlite3` 得用 `Store.open({ driver })` 自组子服务（`README.md` 常见问题 2）。`close()` 之后调用任何公开成员一律抛 `STORAGE`。

**② fetch 适配器**

```ts
const client = new OpenAI({ apiKey: "unused", baseURL: mik.baseUrl, fetch: mik.fetch })
```

要点：请求体里的 `model`（`provider:model`）决定路由；调用方自带的 `authorization`/`api-key`/`x-api-key`/`x-goog-api-key` 会被剥离，由 mik 按 `provider.protocol` 附上凭据；流式响应同样计量（`isStreaming: true`）。

**③ HTTP + OpenAI 兼容端点**

```bash
node packages/mik/dist/cli.mjs init --app-id my-app --provider deepseek --yes
node packages/mik/dist/cli.mjs serve --port 3211
# 装了包之后也可以： npx mik serve --port 3211
curl -s http://127.0.0.1:3211/api/health
curl -s http://127.0.0.1:3211/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek:deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
python examples/python-host/host.py http://127.0.0.1:3211/v1 deepseek:deepseek-chat
```

跨语言侧只改 `base_url`。`system` 角色要放顶层 `system` 字段——OpenAI 兼容端点当前不暴露它，`messages` 里带 `system` 会 500（`examples/python-host/README.md`）。

**④ HTTP API + SSE**

端点清单（全部挂 `/api`，OpenAI 兼容端点挂 `/v1`）：

```
GET    /api/health
GET    /api/providers            POST   /api/providers
PATCH  /api/providers/:id        DELETE /api/providers/:id
POST   /api/providers/:id/test
GET    /api/providers/:id/models POST   /api/providers/:id/models/refresh
GET    /api/models               GET    /api/models/:ref
GET    /api/pricing              PUT    /api/pricing/:modelId
POST   /api/pricing/sync         DELETE /api/pricing/:modelId
GET    /api/usage/summary | trends | by-provider | by-model | logs | logs/:id
GET    /api/events               （SSE）
GET    /openapi.json
POST   /v1/chat/completions      GET    /v1/models
```

**⑤ 用量事件上报**

`UsageService.record(event)` 是公开 API（`packages/mik/src/index.ts` 导出 `UsageService`），`requestId` 幂等，`recordUsage: false` 时直接返回 `false`。仓库里唯一「宿主侧导入」的现成例子是 `apps/dashboard/scripts/seed.mjs`——它**直接调用库**（`Store`/`UsageService`/`ProviderRegistry`）写同一个数据库，**不经过 HTTP、不联网**。要做 HTTP 上报必须先改 `docs/interfaces.md` 契约（AGENTS 规则 5），见 §5.2。

---

## 3. 矩阵 B：分发面（代码怎么到宿主）

| 分发面 | 适用场景 | 安装命令 | 升级方式 | 离线可用性 | 对宿主构建的影响 |
|---|---|---|---|---|---|
| ① npm 包 | 默认路径，JS/TS 宿主 | `npm i model-infra-kit`（+ 用到的 `@ai-sdk/*`） | `npm i model-infra-kit@latest` | 安装需网络；运行时 `--offline` / 抛错的 `pricingFetch` 可完全断网，价格退到内置 archive 并标 `stale` | 只进 `dist`（ESM + `.d.mts`），`sideEffects: false`；`ai` 与 `llm-pricing` 是 dependencies，`@ai-sdk/*` 是可选 peer |
| ② GitHub 直装 `npm i github:...` | 想免发布试最新源码 | **当前布局不成立**：仓库根 `package.json` 是 `private: true` 的 `model-infra-kit-monorepo`，没有 `bin`/`files`/`exports`，也没有 `prepare`/`prepublishOnly` 脚本（全仓 grep 零命中）——装到的是 monorepo 根，拿不到 `mik` 包 | 不适用 | 不适用 | 不适用。要做需先把 `packages/mik` 拆成独立仓库，或补 `prepare` 构建脚本并验证 |
| ③ workspace / submodule 源码引用 | 同一 monorepo 内共享；或宿主愿意吃源码 | `pnpm-workspace.yaml` 里加路径；或 `git submodule add` | `git pull` + 重新构建 | submodule 首次需 git 网络，之后本地 | 宿主必须能构建 TypeScript 并解析 workspace 依赖；会连带 `ai`/`llm-pricing` 一起进宿主的依赖图 |
| ④ `npx` 免安装 sidecar | 想先试跑、不想改宿主 `package.json`；非 Node 宿主的落地形态 | `npx mik serve --port 3211`、`npx mik --help` | `npx mik@latest ...`（npx 自带缓存，升级即换版本号） | 首次需网络下载，之后走缓存 | 零影响：宿主不装包，只当一个本地 HTTP 服务用 |
| ⑤ 脚手架生成 | 新项目第一次接入 | **当前不存在**（仓库无 `create-*` 包、无 `--template` 参数） | — | — | — |
| ⑥ 宿主插件 / 配置生成器 | 想把 mik 挂进某个具体宿主（IDE/Agent CLI） | **当前不存在** | — | — | — |
| ⑦ 纯配置（只改 `base_url`） | 宿主已有 OpenAI 兼容客户端或非 JS 语言；多进程共用 | 0 安装（宿主侧）；上游需 `npx mik serve --port 3211` 或 `node packages/mik/dist/cli.mjs serve --port 3211` | 只升上游 mik，宿主不动 | 宿主本来就联网调模型；mik 侧 `--offline` 只影响价格目录 | 零影响：宿主不知道 mik 存在 |

> ⑤⑥ 两行是**能力缺口**，不是可选做法。卡片要求写「安装命令/升级方式」，但仓库里没有对应实现，写命令就是杜撰——因此如实标为「不存在」，并在 §5.2 给出优先级建议。

---

## 4. 决策树：如果你是这样，就选这条

```
Q1 宿主是 JS/TS 吗？
├─ 否（Python / Go / Rust / 任意语言）
│   └─ → 调用面 ③ + 分发面 ④/⑦：起 mik serve，只改 base_url
│       下一步：node packages/mik/dist/cli.mjs init --app-id <你的app> --provider <preset> --yes
│                 node packages/mik/dist/cli.mjs serve --port 3211
└─ 是 → Q2

Q2 宿主已经在用 openai SDK 吗？
├─ 是 → → 调用面 ② + 分发面 ①：只改客户端构造那两行，业务代码一行不动
│       下一步：npm i model-infra-kit openai，然后 new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })
└─ 否 → Q3

Q3 宿主是自己写的调用代码（自研 CLI Agent / 后端服务）吗？
├─ 是 → → 调用面 ① + 分发面 ①：嵌入库，直接拿 generate/stream/usage
│       下一步：照 README「快速开始」跑通 quickstart.ts
└─ 否 → Q4

Q4 需要多个进程/多个 app 共用一本账吗？
├─ 是 → → 调用面 ③ + 分发面 ④：一个 mik serve 常驻，各进程打 3211
│       一库多 app 靠 appId：ModelInfra.init({ appId: "cli-agent" }) / { appId: "quant-lab" }
│       注意：providers / models / pricing_overrides 三张表全局共享，用量明细按 appId 隔离
└─ 否 → Q5

Q5 宿主是浏览器端（纯前端）吗？
├─ 是 → → 不要在浏览器里嵌库（库依赖 node:sqlite 与 Node 内置模块）
│       走调用面 ③：浏览器直连 3211/v1（需在 createServer 里开 cors，CLI 无 --cors 开关）
│       或走调用面 ④ + 宿主自己的服务端代理（看板的做法，见 §5.1 做法②）
└─ 否 → Q6

Q6 只想看成本、完全不想改宿主代码？
└─ → 调用面 ③/④ + 做法①：跑 mik serve + 看板（仅仓库内），主站反向代理 /usage → 3210
        下一步：pnpm --filter @mik/dashboard build && pnpm --filter @mik/dashboard start
```

---

## 5. 网页端要不要自带可视化

### 5.1 结论

**不要指望「装了包就有页面」。** 事实链：

- 看板是仓库内的**独立 Next.js 应用** `apps/dashboard`（`@mik/dashboard`，`private: true`）。
- 它的数据源只有 `mik serve` 的 HTTP API（`apps/dashboard/lib/config.ts` 的 `DEFAULT_MIK_SERVER_URL = "http://127.0.0.1:3211"`），**从不打开 SQLite 文件**。
- 它**不随 npm 包发布**：`packages/mik/package.json` 的 `files` 只有 `dist` 与 `LICENSE`。装包环境跑 `npx mik dashboard` 会直接报错并给指引。
- 浏览器**不直连 3211**：写操作走 `app/api/mik/[...path]/route.ts` 代理，SSE 走 `app/api/events/route.ts` 透传，因为 mik 服务默认不开 CORS。

所以网页端要可视化，只有三条路，**共同前提是先有一个在跑的 `mik serve`**。

| 做法 | 工作量 | 耦合度 | 品牌化能力 | 前提与风险 |
|---|---|---|---|---|
| ① sidecar 反向代理：`/usage` 挂到主站 | 低：起两个进程 + 一条 rewrite（Next `rewrites` 或 nginx） | 低到中：主站不碰看板代码，但要转发 `/api/mik/*` 与 `/api/events` 两条代理路由，漏一条则写操作或实时刷新失效 | 低：看板自带 `Nav`、深色主题与 footer，嵌进去仍是「另一个应用」的观感 | 需要 `apps/dashboard` 的一份副本（仓库内或 `--dir <path>` 指向）；`MIK_SERVER_URL`/`MIK_SERVER_TOKEN` 留在服务端 |
| ② 复用 `/api/*` 自建 UI（推荐给正式产品） | 中到高：页面自己写；图表、空态、降级横幅都要自己实现 | 最低：只依赖 HTTP 契约，不依赖看板代码 | 最高：布局、导航、权限、文案完全自控 | 服务端取数要自己处理上游不可达（参考 `lib/mik.ts` 的 `mikTry()`：永不抛错，渲染错误横幅）；`/api/usage/*` 没有 `appId` 过滤、`GET /api/models` 不带 `pricing`、HTTP 面无「设为默认」端点——这三条是契约层面的已知限制 |
| ③ 直接复用 `apps/dashboard` 页面组件 | 低到中：拷进宿主仓库，改 `app/layout.tsx` 的 Nav/footer 与 `globals.css` 主题；`lib/*` 与 `components/*` 原样可用 | 中到高：是**拷贝**不是依赖，升级要手动 diff | 中：能改品牌与主题，但 Next 15 + React 19 + Tailwind v4 + Recharts 3 这套技术栈会被带进宿主构建 | 宿主必须是 Next.js App Router；`components/ui.tsx`（154 行）、`components/live-refresh.tsx`（92 行）、`components/charts/{cost-trend,token-cost}.tsx` 是现成参考 |

**怎么选**：

- 只想自己和团队看成本、不介意多一个端口 → **①**
- 要嵌进产品、要品牌化、要按宿主权限收口 → **②**
- 接受 Next.js/Tailwind 栈、想最快看到页面 → **③**
- 想要一个**立刻能嵌、零重写**的现成页面 → **④ `/embed/*` 路由（T13 已落地）**：看板自带无导航的 `/embed/overview`、`/embed/trends`、`/embed/logs`、`/embed/pricing`，iframe 或主站反代 `/usage/* → 3210/embed/*` 即可；默认近 7 天、无筛选面板、SSE 实时增量仍生效。代价是观感仍是看板自带主题（要改主题走 ③ 的拷贝）。

**三条路的实时性一致**（④ 同）：都靠 `GET /api/events` 的 `usage.recorded` / `catalog.updated` / `pricing.updated`。看板的做法是防抖 400ms 后 `router.refresh()`，断开时 `EventSource` 自动重连并显示「未连接」。

### 5.2 待补能力（可视化相关）

- **P0（部分完成）**：让装包用户拿到看板——`/embed/*` 嵌入路由已落地（T13），仓库内 `pnpm start` 后主站反代即可用；「独立发布 `@mik/dashboard` 或 `npx` 入口」仍未做，装包环境跑 `mik dashboard` 仍会报错并指引克隆仓库。
- **P1（已完成，T14）**：`mik serve --cors <origin>` 已落地——`--cors '*'` 允许任意源，`--cors https://主站` 固定源；浏览器现在可以直连 3211 取数，不必自建代理（看板仍走代理，两者并存）。CLI 对非法值报错。
- **P2**：`GET /api/models` 带上 `pricing`、补 `defaultModel` 端点、HTTP 面 `appId` 过滤——看板 README 已把它们记为「已知限制」。

---

## 6. 运营建议

### 6.1 按接入摩擦排序的推广路径（摩擦最低 → 最高）

| 顺序 | 路径 | 为什么放在这里 | 优先做 |
|---|---|---|---|
| 1 | 纯配置：只改 `base_url`（调用面 ③ + 分发面 ⑦） | 摩擦最低：0 依赖、0 构建、0 代码改动，非 JS 语言也能用；「多进程共用」也只有这条路 | P0 |
| 2 | `mik.fetch` 两行适配器（调用面 ②） | 对已有 `openai` SDK 的项目是「业务代码零改动被计量」，最能把「要不要引入」变成「顺手加两行」 | P0 |
| 3 | 嵌入式库（调用面 ① + 分发面 ①） | 主路径，能力最全（`generate/stream/tools/sessionId/tags`），但要求宿主自己写调用代码 | P0 |
| 4 | `npx` sidecar（分发面 ④） | 试跑门槛最低（不装进项目），适合「先看一眼」；生产环境仍需进程管理 | P1 |
| 5 | 脚手架生成（分发面 ⑤） | 摩擦最高，但它决定**第一次是否成功**——首次失败是放弃率的主要来源 | P1 |
| 6 | 宿主插件 / 配置生成器（分发面 ⑥） | 只有在确定了具体宿主之后才值得投入；当前没有目标宿主 | P2 |

**最能降低放弃率的两条**：第 1 条（纯配置）和第 5 条（脚手架）。前者让「不想改代码的人」立刻看到成本数据，后者让「愿意改代码的人」不卡在第一步。

### 6.2 需要补的能力清单

| 能力 | 理由 | 优先级 |
|---|---|---|
| `POST /api/usage/events`（或等价的事件上报端点） | 卡片点名要求，但仓库不存在（实测 404）。没有它，跨语言/多进程宿主无法把「自己直连供应商」的用量灌进同一本账，只能进程内 `usage.record()`。**需先改 `docs/interfaces.md` 契约**（AGENTS 规则 5），并考虑鉴权、幂等（`requestId`）、appId 归属、脱敏 | P0 |
| 看板可用性（见 §5.2） | 装包用户完全拿不到可视化，是当前最大的能力落差 | P0 |
| 脚手架（`create-mik-*` 或 `mik init --template`） | 把「读文档 → 自己拼」变成「一条命令出可跑项目」，直接影响首次成功率 | P1 |
| Docker 镜像 / compose（`mik serve` + 看板） | 非 Node 宿主的落地形态；也解决「两个端口两个进程」的运维摩擦 | P1 |
| `mik serve --cors` 开关 | 浏览器端直连的前置条件 | P1 |
| GitHub 直装可用（拆独立仓库或补 `prepare` + 验证） | 免发布试最新源码；当前仓库布局不成立 | P2 |
| 配置生成器 / 宿主插件 | 按需，取决于是否有明确宿主 | P2 |

---

## 7. 核对附录

### 7.1 命令存在性

| 命令 | 出处 |
|---|---|
| `npm i model-infra-kit` | `README.md`、`packages/mik/README.md` |
| `pnpm install` / `pnpm --filter model-infra-kit build\|typecheck\|test\|check` | `README.md`、`packages/mik/package.json` |
| `node packages/mik/dist/cli.mjs --help` / `init` / `serve` / `dashboard` / `provider` / `models` / `pricing` / `usage` | `README.md`、`packages/mik/src/cli/args.ts` 的 `COMMANDS` |
| `npx mik serve --port 3211` / `npx mik dashboard` | `README.md`、`packages/mik/package.json` 的 `bin` |
| `pnpm --filter @mik/dashboard build\|start\|dev\|seed\|typecheck` | `apps/dashboard/package.json` 的 `scripts` |
| `node apps/dashboard/scripts/serve-mik.mjs` / `check-port.mjs 3210` / `mock-openai.mjs` | `apps/dashboard/scripts/` |
| `node scripts/e2e/run.mjs` | `scripts/e2e/run.mjs` |
| `pnpm --filter @mik/example-cli-agent start -- --base-url ...` | `examples/cli-agent/README.md`、`examples/cli-agent/package.json` |
| `pnpm --filter @mik/example-openai-sdk start -- --base-url ... --model ...` | `examples/openai-sdk/README.md`、`examples/openai-sdk/package.json` |
| `python examples/python-host/host.py http://127.0.0.1:3211/v1 <provider:model>` | `examples/python-host/host.py`、`examples/python-host/README.md` |
| `curl -s http://127.0.0.1:3211/api/health` / `.../v1/chat/completions` | `README.md`「三种接入方式 ③」 |
| `mik usage logs --config mik.config.json` | `examples/python-host/README.md` |
| `netstat -ano \| findstr :<端口>` | `README.md` 端口表、`AGENTS.md` |

### 7.2 端点存在性（源码 grep）

- `packages/mik/src/server/api.ts` 的 `router.add(...)` 命中 21 条：`/api/health`、`/api/providers`(GET/POST)、`/api/providers/:id`(PATCH/DELETE)、`/api/providers/:id/test`、`/api/providers/:id/models`(GET)、`/api/providers/:id/models/refresh`(POST)、`/api/models`、`/api/models/:ref`、`/api/pricing`(GET)、`/api/pricing/:modelId`(PUT/DELETE)、`/api/pricing/sync`(POST)、`/api/usage/summary|trends|by-provider|by-model|logs|logs/:id`、`/api/events`。
- `packages/mik/src/server/server.ts:152-156` 注册 `GET /openapi.json`、`POST /v1/chat/completions`、`GET /v1/models`。
- `apps/dashboard/app/api/mik/[...path]/route.ts`（GET/POST/PUT/PATCH/DELETE 全转发到 `<MIK_SERVER_URL>/api/<path>`）、`apps/dashboard/app/api/events/route.ts`（SSE 透传 `GET /api/events`）。
- **反向确认**：全仓 grep `usage/events` 只命中 `tasks/T11-integration-playbook.md` 与本文件；`packages/mik/src/server/api.ts` 无该路由。

### 7.3 本卡实测（活服务探针）

用 `node packages/mik/dist/cli.mjs serve --offline --port 3271 --app-id t11` 起服务后实测：

```
GET  /api/health        → 200 {"status":"ok","appId":"t11","baseUrl":"http://127.0.0.1:3271/v1",...}
GET  /api/usage/summary → 200 {"summary":{"requests":0,...}}
GET  /api/usage/trends?bucket=day → 200 {"bucket":"day","points":[]}
GET  /api/usage/logs?limit=2      → 200 {"total":0,...}
GET  /api/providers     → 200 {"providers":[]}
GET  /api/pricing       → 200 {"state":{"status":"stale","source":"fallback"},"overrides":[]}
GET  /v1/models         → 200 {"object":"list","data":[]}
GET  /openapi.json      → 200 {"openapi":"3.1.0",...}
POST /api/usage/events  → 404 {"error":{"code":"NOT_FOUND","message":"No route matches /api/usage/events."}}
```

服务启动打印 `Listening on http://127.0.0.1:3271` / `OpenAI-compatible base URL: http://127.0.0.1:3271/v1` / `Press Ctrl+C to stop.`，验证完毕已停进程并确认端口释放。

### 7.4 本卡读过的文件

`tasks/T11-integration-playbook.md`、`README.md`、`packages/mik/README.md`、`packages/mik/package.json`、`packages/mik/src/index.ts`、`packages/mik/src/types.ts`、`packages/mik/src/server/{api,server,index,openai}.ts`、`packages/mik/src/cli/{index,args}.ts`、`packages/mik/src/cli/commands/serve.ts`、`docs/SPEC.md`、`docs/interfaces.md`、`docs/decisions.md`、`docs/verified-facts.md`、`docs/verify-checklist.md`、`apps/dashboard/README.md`、`apps/dashboard/package.json`、`apps/dashboard/app/{layout,page}.tsx`、`apps/dashboard/app/api/{events,mik/[...path]}/route.ts`、`apps/dashboard/lib/{config,mik,server-data}.ts`、`apps/dashboard/scripts/serve-mik.mjs`、`scripts/e2e/run.mjs`、`examples/{cli-agent,openai-sdk,python-host}/README.md`、`examples/python-host/host.py`、`tasks/BOARD.md`、`AGENTS.md`。

---

## 8. 已知文档冲突与风险（本卡不改源码）

1. **`apps/dashboard/README.md`「已知限制」说 `mik serve` 当前不可用（属 T07）**——该限制已过时：T07/F06 已修复 `dist` 路径解析（`packages/mik/src/cli/commands/serve.ts` 的 `SERVER_CANDIDATES` 优先试 `./server.mjs`），本卡实测 `dist/cli.mjs serve` 正常起服务。建议后续卡同步该 README（不在本卡文件范围内）。
2. **`apps/dashboard/scripts/serve-mik.mjs` 的注释仍写着「T07 修好后可弃用」**——同上，属陈旧注释。
3. **卡片点名的 `POST /api/usage/events` 不存在**——已按事实处理，列入 §6.2 的 P0 能力缺口。
