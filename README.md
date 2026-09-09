# model-infra-kit

> 一个可嵌入任意 AI 项目的模型层：装进宿主项目后，立刻获得**多供应商调用、模型目录、token 用量、模型计价与成本统计**，外加一个独立的用量看板（看板只在仓库内运行，**不随 npm 包发布**，见[「看板」一节](#看板)）。

它不是网关平台，不是企业级 AI Gateway，也不读任何第三方应用的数据文件——用量数据由本模块自己产生。

| 能力 | 由谁提供 |
|---|---|
| 多供应商 / 多协议 / 流式 / 工具调用 / usage | Vercel AI SDK `ai@7` + `@ai-sdk/*` |
| 模型目录（能力位、上下文、价格） | models.dev（经 llm-pricing 的 modelsDevSource） |
| 模型名归一化 + 成本计算 | `llm-pricing@0.17` |
| 用量存储与聚合 | SQLite（`node:sqlite`，Node 内置） |
| 可视化 | 自研 Next.js 看板（端口 3210） |

自研的只有四块：`ProviderRegistry` / `CredentialStore` / `UsageRecorder` / `UsageRepository`。取舍理由见 [`docs/decisions.md`](docs/decisions.md)。

仓库：<https://github.com/satan9394/model-infra-kit>（当前为 private）。尚未发布到 npm registry，现阶段用下面的方式之一安装。

| 安装方式 | 命令 | 适用 / 说明 |
|---|---|---|
| 本地打包 | `pnpm --filter model-infra-kit pack --pack-destination .tmp` 后 `npm i ./.tmp/model-infra-kit-0.1.0.tgz` | 本机联调；无需鉴权 |
| 从 Release 下载（**private 仓走这条**） | `gh release download v0.1.0 --repo satan9394/model-infra-kit --pattern "*.tgz" --dir .` 后 `npm i ./model-infra-kit-0.1.0.tgz` | 已实测：CLI `mik 0.1.0` 与库导出均正常 |
| Release 直链 | `npm i https://github.com/satan9394/model-infra-kit/releases/download/v0.1.0/model-infra-kit-0.1.0.tgz` | **仅公开仓可用**；private 仓匿名请求返回 404 |
| 源码引用 | 把本仓库作为 workspace 成员或 git submodule | 需要改内部实现时 |
| 免安装 sidecar | 用上面的 tgz 安装后 `npx mik serve`，或直接跑 `node packages/mik/dist/cli.mjs serve` | 不改宿主代码，只改 `base_url` |

> 注意：**`npm i github:satan9394/model-infra-kit` 不能用**——仓库根 `package.json` 是 private 的 monorepo 声明，没有 `bin`/`files`/`prepare`，装到的是空壳。请用 Release 或本地打包。
> 无论哪种方式，**都要另外装你实际用的 provider 包**（`@ai-sdk/*` 是可选 peer），见下方「① 嵌入式库」。

---

## 环境要求

- **Node ≥ 22.13**（`node:sqlite` 自 22.13.0 起不再需要 `--experimental-sqlite`，仍会打一行实验特性告警；本机 24.14）
- **pnpm 11**（本仓库是 pnpm workspace）
- 密钥**只以引用形式**出现：`env:VAR` / `file:path` / `keychain:service`。任何文档、数据库、日志里都不会出现明文密钥。
- 看板是**仓库内的独立应用**，不随 `model-infra-kit` npm 包发布；装包用户只能用库 / CLI / HTTP 服务（见[「看板」一节](#看板)）。

```bash
pnpm install                       # 首次克隆后
pnpm --filter model-infra-kit build # 产出 packages/mik/dist/{index,server,cli}.mjs
```

---

## 三种接入方式（5 分钟上手）

三条路径共用同一套注册表、价格目录与用量库，所以**同一次调用只会被计量一次**。选一条即可，也可以混用。

### ① 嵌入式库（主路径）

适用：自研 CLI Agent、后端服务、量化项目——你自己写调用代码。

```bash
npm i model-infra-kit
```

> **还要装你实际用的 provider 包。** `@ai-sdk/*` 是可选 peer 依赖，只装主包时第一次调用会报
> `The provider package @ai-sdk/openai-compatible is not installed. Run: npm i @ai-sdk/openai-compatible`。
> 常见对应关系：`openai-compatible`（DeepSeek / Qwen / GLM / Kimi / 中转网关）→ `@ai-sdk/openai-compatible`；
> `openai` → `@ai-sdk/openai`；`anthropic` → `@ai-sdk/anthropic`；`google` → `@ai-sdk/google`；
> `deepseek` → `@ai-sdk/deepseek`；`moonshotai` → `@ai-sdk/moonshotai`；`xai` → `@ai-sdk/xai`。

```ts
// quickstart.ts —— 用 `node quickstart.ts` 直接跑（Node ≥ 22.18 内置类型剥离）
import { ModelInfra } from "model-infra-kit"

const mik = await ModelInfra.init({
  appId: "quickstart",
  db: "quickstart.db",
  providers: [
    {
      id: "deepseek",
      presetId: "deepseek", // preset 补全 protocol 与 base URL
      baseUrl: process.env.MIK_BASE_URL, // 可选：指向自己的网关
      apiKeyRef: "env:DEEPSEEK_API_KEY", // 引用，不是密钥本身
    },
  ],
  defaultModel: "deepseek:deepseek-chat",
})

const reply = await mik.generate({
  messages: [{ role: "user", content: "Reply with one short sentence." }],
})

console.log(reply.text)
console.log(reply.usage, `$${reply.cost.usd}`, `source=${reply.cost.source}`)
console.log(mik.usage.summary())

await mik.close()
```

```bash
export DEEPSEEK_API_KEY=sk-...   # 你的真实密钥只进环境变量
node quickstart.ts
```

真实输出（本机对着本地 OpenAI 兼容 mock 跑，`MIK_BASE_URL` 指向 mock）：

```text
Mock reply: the local provider answered without touching the network.
{ input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 64 } $0.0002475 source=modelsdev
{ requests: 1, successes: 1, failures: 0, ... }
```

字段速查见 [`packages/mik/README.md`](packages/mik/README.md)。

### ② fetch 适配器：已有 OpenAI SDK 代码零改动被计量

适用：已经在用 `openai` SDK 的项目。**只改客户端构造的两行**，业务代码一行不动。

```bash
npm i model-infra-kit openai
```

```ts
// quickstart-sdk.ts
import OpenAI from "openai"
import { ModelInfra } from "model-infra-kit"

const mik = await ModelInfra.init({
  appId: "quickstart",
  db: "quickstart.db",
  providers: [
    {
      id: "deepseek",
      presetId: "deepseek",
      baseUrl: process.env.MIK_BASE_URL, // 可选：指向自己的网关
      apiKeyRef: "env:DEEPSEEK_API_KEY",
    },
  ],
})

// 唯一改动的两行：端点与传输层。
const client = new OpenAI({ apiKey: "unused", baseURL: mik.baseUrl, fetch: mik.fetch })

const completion = await client.chat.completions.create({
  model: "deepseek:deepseek-chat",
  messages: [{ role: "user", content: "Reply with one short sentence." }],
})

console.log(completion.choices[0]?.message?.content)
console.log(mik.usage.summary())
await mik.close()
```

要点：

- 请求体里的 `model`（`provider:model`）决定路由到哪个供应商；调用方自带的认证头会被剥离，由 mik 按协议附上配置好的凭据。
- 供应商返回什么就原样返回什么，mik 只读一份克隆来做计价与落库。
- 落库的 `source` 是 `fetch`，和 `generate` / `stream` 区分开。
- 完整可跑示例：[`examples/openai-sdk/index.ts`](examples/openai-sdk/index.ts)。

### ③ 本地服务 + OpenAI 兼容端点（跨语言）

适用：Python / Go / 任何语言的项目，或想让多个进程共用一个模型层。

```bash
# 1) 初始化并配好一个供应商（这里以 deepseek preset 为例）
node packages/mik/dist/cli.mjs init --app-id my-app --provider deepseek --yes
export DEEPSEEK_API_KEY=sk-...

# 2) 起服务（默认 127.0.0.1:3211）
node packages/mik/dist/cli.mjs serve --port 3211
#    装了包之后也可以直接： npx mik serve --port 3211

# 3) 健康检查
curl -s http://127.0.0.1:3211/api/health

# 4) 打一次 OpenAI 兼容端点
curl -s http://127.0.0.1:3211/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek:deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
```

真实输出（本机用本地 mock 供应商验证）：

```text
$ curl -s http://127.0.0.1:3211/api/health
{"status":"ok","appId":"quickstart","baseUrl":"http://127.0.0.1:3211/v1","origin":"http://127.0.0.1:3211",
 "time":...,"uptimeMs":7341,"providers":1,"models":2,"pricing":{"status":"fresh","source":"modelsdev",...}}

$ curl -s -X POST http://127.0.0.1:3211/v1/chat/completions -H 'content-type: application/json' --data-binary @chat.json
{"id":"chatcmpl-...","object":"chat.completion","model":"mock-mini",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Mock reply: ..."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,...},
 "x_modelhub":{"provider":"local","model_requested":"local:mock-mini","cost_usd":0,"cost_source":"missing",...}}
```

跨语言侧只需要改 `base_url`：

```bash
python examples/python-host/host.py http://127.0.0.1:3211/v1 deepseek:deepseek-chat
# status: 200 / model: ... / usage: {...} / session: python-host
```

端点清单（全部挂 `/api`，OpenAI 兼容端点挂 `/v1`）见 [`docs/interfaces.md`](docs/interfaces.md) 与运行时的 `GET /openapi.json`。

---

## 看板

看板是独立的 Next.js 应用，**端口 3210**，数据只来自 `mik serve` 的 HTTP API（默认 `http://127.0.0.1:3211`），从不打开 SQLite 文件。

> **看板只在仓库内可用，不随 npm 包发布。** `model-infra-kit` 的 `files` 只有 `dist` 与 `LICENSE`（库 + CLI + HTTP 服务），`npm i model-infra-kit` 的宿主拿不到 `apps/dashboard`；在装包环境里跑 `mik dashboard` 会直接报错并给出指引（见下）。要看看板，请克隆本仓库。

```bash
# 方式 A：由 CLI 拉起（自动找到仓库内的 apps/dashboard，再 next start -p 3210）
node packages/mik/dist/cli.mjs dashboard

# 方式 B：手动跑
pnpm --filter @mik/dashboard build     # 生产构建
pnpm --filter @mik/dashboard start     # next start -p 3210（会先做端口守卫）
pnpm --filter @mik/dashboard dev       # 开发模式；会覆盖 .next 里的生产产物
pnpm --filter @mik/dashboard seed      # 可选：写入 30 天假数据把页面填满
```

在**装包环境**（没有 `apps/dashboard`）里跑 `mik dashboard`，实际输出：

```text
$ npx mik dashboard
error: Could not find the dashboard app (apps/dashboard).
The dashboard is not published with the npm package: model-infra-kit ships the library, the CLI and the HTTP server only.
  Installed from npm? Run the dashboard from a clone of the repository, or deploy apps/dashboard yourself.
  In the monorepo: pnpm --filter @mik/dashboard dev   (or build + start)
  Or point the CLI at an existing copy: mik dashboard --dir <path>
  See the "Dashboard" section of the project README.
```

`--dir <path>` 可指向任意一份看板副本（该目录需含 `package.json`）；自行部署时也走 `next start`，看板只读 `mik serve` 的 HTTP API。仓库内启动时先打印一行 `Starting dashboard from <dir> on http://127.0.0.1:3210`。

打开 <http://127.0.0.1:3210>。页面：概览 `/`、趋势 `/trends`、供应商 `/providers`、模型目录 `/models`、价格 `/pricing`、日志 `/logs`。SSE 实时增量、空数据与上游不可用时的降级行为见 [`apps/dashboard/README.md`](apps/dashboard/README.md)。

### 端口

| 端口 | 用途 | 覆盖方式 |
|---|---|---|
| **3211** | `mik serve` OpenAI 兼容服务 + `/api/*` | `mik serve --port <n>`（`MIK_SERVER_TOKEN` 只用于鉴权，不是端口） |
| **3210** | 看板（**仅仓库内**，不随包发布） | `mik dashboard --port <n>`（仓库内）、`next start -p <n>`、`MIK_DASHBOARD_DIR` 指向已有副本 |
| 3212 | 仅示例/测试用的 mock 供应商 | `node apps/dashboard/scripts/mock-openai.mjs` |

已被本机其它项目占用、**禁止使用**：3080（dsh web）、3001（html-anything）、3111（NewAPI）、8899（知识库）。起服务前先 `netstat -ano | findstr :<端口>`；`mik serve` / `mik dashboard` 端口被占会直接报错，不硬抢。

---

## 常用命令

在仓库根目录执行（「验证」列只写可复跑的结论，具体数字/体积每次都会变，以命令输出为准）：

| 命令 | 作用 | 本机验证 |
|---|---|---|
| `pnpm --filter model-infra-kit build` | tsdown 打包，产出 `dist/{index,server,cli}.mjs` + `.d.mts` | ✅ 9 个文件（体积见构建输出） |
| `pnpm --filter model-infra-kit typecheck` | `tsc --noEmit` | ✅ 0 错误 |
| `pnpm --filter model-infra-kit test` | vitest 全量 | ✅ 全绿（文件数/用例数见命令输出） |
| `pnpm --filter model-infra-kit check` | typecheck + test + build | ✅ 退出码 0 |
| `node packages/mik/dist/cli.mjs --help` | CLI 帮助 | ✅ 见下 |
| `node packages/mik/dist/cli.mjs init --app-id my-app --provider deepseek --yes` | 写 `mik.config.json` 并注册首个供应商 | ✅ |
| `node packages/mik/dist/cli.mjs provider add <id> --preset <presetId> --api-key-ref env:VAR` | 增改供应商 | ✅ |
| `node packages/mik/dist/cli.mjs provider list` | 列出供应商与默认模型 | ✅ |
| `node packages/mik/dist/cli.mjs provider test <id>` | 最小调用探活 | ✅（需可用的 base URL/密钥） |
| `node packages/mik/dist/cli.mjs models --provider <id> --refresh` | 拉取模型目录 | ✅（需可用凭据/网络；`--offline` 下会明确拒绝） |
| `node packages/mik/dist/cli.mjs pricing set <modelId> --input <usd/M> --output <usd/M>` | 设手动价（优先级最高） | ✅ |
| `node packages/mik/dist/cli.mjs pricing list` | 价格目录状态 + 手动价 | ✅ |
| `node packages/mik/dist/cli.mjs usage summary\|trends\|logs\|export` | 用量查询与 CSV 导出 | ✅ |
| `node packages/mik/dist/cli.mjs serve --port 3211` | 起 OpenAI 兼容服务 | ✅ |
| `node packages/mik/dist/cli.mjs dashboard` | 起看板（3210，**仅仓库内可用**；装包环境会报错并给指引） | ✅ 仓库内解析到 `apps/dashboard` 并拉起 `next start`（首次需先 `pnpm --filter @mik/dashboard build`） |
| `node scripts/e2e/run.mjs` | 端到端验收（SPEC §6 全场景，含看板场景；检查点清单见 [`scripts/e2e/README.md`](scripts/e2e/README.md)） | 以命令实时输出为准（退出码 0 = 全过；看板检查点需 `apps/dashboard` 可构建） |
| `pnpm --filter @mik/dashboard build` / `start` | 看板构建 / 生产启动 | ✅ 退出码 0 / HTTP 200 |

`mik` 的全局开关：`--db <path>`、`--app-id <id>`、`--config <path>`、`--cache-dir <path>`、`--offline`（完全不联网）、`-h`、`-v`。每个子命令都支持 `--help`。

```text
$ node packages/mik/dist/cli.mjs --help
model-infra-kit (mik) 0.1.0
Embeddable model layer: multi-provider access, model catalog, token usage and cost tracking.

USAGE
  mik <command> [options]

COMMANDS
  init        Write mik.config.json (app id, database path, first provider)
  serve       Start the OpenAI-compatible HTTP service (default 127.0.0.1:3211)
  dashboard   Start the dashboard app (default 3210)
  provider    List, add, remove and test providers
  models      List the model catalogue, optionally refreshing it from the provider
  pricing     Inspect, sync and override model prices
  usage       Query recorded usage: summary, trends, logs, CSV export

GLOBAL OPTIONS
      --db <path>         SQLite database file (default ~/.model-infra-kit/usage.db)
      --app-id <id>       Owning application id (default: default)
      --config <path>     CLI config file (default ./mik.config.json)
      --cache-dir <path>  Pricing catalogue cache directory
      --offline           Never touch the network (skip catalogue sync and provider probes)
  -h, --help              Show help
  -v, --version           Show version

EXAMPLES
  mik init --app-id my-app --provider deepseek
  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY
  mik provider test deepseek
  mik models --provider deepseek --refresh
  mik pricing set deepseek-chat --input 0.27 --output 1.10
  mik usage summary --from 2026-09-01
  mik usage export --format csv --out usage.csv

Run "mik <command> --help" for details on any command.
```

---

## 常见问题

### 1. `ExperimentalWarning: SQLite is an experimental feature` 怎么消除？

`node:sqlite` 目前仍是实验特性，Node 在**首次 import 时打一行告警到 stderr**，不影响功能。三种处理方式（本机均已实测）：

```bash
# A. 只压这一类告警（推荐：其它告警仍然可见）
node --disable-warning=ExperimentalWarning quickstart.ts

# B. 全局压掉全部告警
NODE_OPTIONS=--no-warnings node quickstart.ts
#   Windows PowerShell: $env:NODE_OPTIONS="--no-warnings"

# C. 等 Node 把它转正，或换掉驱动（见下一条）
```

`mik serve` 的 stdout 默认三行：`Listening on http://127.0.0.1:3211`、`OpenAI-compatible base URL: .../v1`、`Press Ctrl+C to stop.`（带 `--token` / `MIK_SERVER_TOKEN` 时多一行 `Bearer token required (value not shown).`；退出时再打一行 `Stopped.`）。子命令的输出都是人类可读的表格，没有隐藏日志。

### 2. 如何换成 `better-sqlite3`？

默认驱动是 `node:sqlite`（零原生编译、零额外依赖）。持久层只依赖一个很窄的接口：

```ts
export interface SqlDriver {
  exec(sql: string): void
  prepare(sql: string): SqlStatement // { run, get, all }
  close(): void
}
export type SqlDriverFactory = (path: string) => SqlDriver | Promise<SqlDriver>
```

注入点在 `Store.open()`：

```ts
import { Store, ProviderRegistry, CredentialStore, PricingService, UsageService } from "model-infra-kit"

const store = await Store.open({
  path: "usage.db",
  driver: async (path) => {
    const { default: Database } = await import("better-sqlite3")
    const db = new Database(path)
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.pragma("foreign_keys = ON")
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql), // better-sqlite3 的 run/get/all 形状一致
      close: () => db.close(),
    }
  },
})

// 之后按需自组子服务（ModelInfra.init() 目前不暴露 driver 开关）
const credentials = new CredentialStore({ driver: store.driver })
const providers = new ProviderRegistry({ store, credentials, appId: "my-app" })
const pricing = new PricingService({ store })
await pricing.init()
const usage = new UsageService({ store, appId: "my-app", enabled: true })
```

本机实测：用一个包了 `node:sqlite` 的「marker driver」注入 `Store.open()`，工厂被调用一次、语句被正常 prepare，供应商/价格/用量三个子服务都跑通。

> V0.1 的 `ModelInfra.init()` 不接受 `driver` 选项。要拿到 `generate/stream/fetch` 全套能力，就用默认驱动；只要存储层，就按上面的方式自组。

### 3. 多个 app 共用一个数据库？

`ModelInfraConfig.appId` 就是为这件事存在的：**一个 SQLite 文件可以服务多个宿主应用**，每条用量事件都带 `app_id`。

```ts
const mik = await ModelInfra.init({ appId: "cli-agent", db: "~/.model-infra-kit/usage.db" })
// 另一个进程：
const other = await ModelInfra.init({ appId: "quant-lab", db: "~/.model-infra-kit/usage.db" })
```

约定（评审后已收紧，见 [`docs/decisions.md`](docs/decisions.md)）：

- `usage.summary/trends/byProvider/byModel/query` 与 `usage.get(requestId)` **默认只返回本实例 appId 的数据**；`get(id, { appId: "" })` 才显式放开（仅调试用）。
- `usage.clear()` 是 app 级的；**`usage.rollupAndPrune()` 是全局维护操作**，会把所有 app 的过期明细折进 rollup 并删除，只由其中一个 app 调用即可。
- `providers` / `models` / `pricing_overrides` 三张表**全局共享**（供应商 id 全局唯一）：app B 能看到 app A 的 `baseUrl` / `apiKeyRef`，但看不到密钥本身。
- 并发：驱动开了 `WAL` + `busy_timeout=5000`，多读单写；长时间写事务会互相等待，别把大导出塞进事务里。
- CLI 侧用 `--app-id <id>` 区分；看板顶部会显示当前 appId（HTTP 面刻意不暴露 `appId` 过滤参数，避免绕过服务层的 app 隔离）。

---

## 文档地图

| 文件 | 内容 |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | 定位、数据模型、关键口径、非目标、验收场景 |
| [`docs/interfaces.md`](docs/interfaces.md) | 跨模块接口契约（唯一真相）+ 评审裁决记录 |
| [`packages/mik/README.md`](packages/mik/README.md) | API 速查：`init/generate/stream/fetch/providers/models/pricing/usage` 与字段表 |
| [`examples/`](examples/) | 三种接入面的可跑示例（`cli-agent` / `openai-sdk` / `python-host`） |
| [`docs/decisions.md`](docs/decisions.md) | 关键取舍与理由 |
| [`docs/verified-facts.md`](docs/verified-facts.md) | 本机实测事实（AI SDK usage 形状、环境坑） |
| [`apps/dashboard/README.md`](apps/dashboard/README.md) | 看板页面、环境变量、代理层、已知限制 |
| [`tasks/BOARD.md`](tasks/BOARD.md) | 任务看板与进度 |
| [`AGENTS.md`](AGENTS.md) | 项目规则与硬性约束 |

## V0.1 明确不做

智能路由、自动 failover、负载均衡、Key 池、预算限制、RPM/TPM 调度、团队管理、云同步、PostgreSQL、embedding、CC Switch 相关能力（跨 agent 导入 / 特殊 cache 计费 / 去重）。

## License

MIT —— 全文见 [`packages/mik/LICENSE`](packages/mik/LICENSE)（该文件随 npm 包一起发布）。
