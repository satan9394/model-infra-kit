# 自研 Agent CLI 怎么把 mik 装进去（T12）

> 目标读者：要做一个 Claude Code 式命令行 Agent（TUI + 命令层 + 工具循环）的人。
> 问题原文：「比如开发一个类似于 Claude Code CLI 的 Agent CLI，该怎么做？要提供方便的模式，到底该怎么快速给它装进去？好好想一想提供哪些更好、更方便的安装方式。」
>
> 本文件里出现的每条命令、每个 API 都在本仓库里存在，核对表见 §7；所有输出都是本机真实运行结果（离线，本地 mock 供应商，端口 3221）。
> 可直接跑的骨架：[`examples/agent-cli/`](../examples/agent-cli/)（`model add|list|use` / `chat` / `stats` + mock 供应商 + 坑位实测）。

---

## 1. 架构：宿主 CLI 只做壳，mik 只做模型层

```
┌──────────────────────────────────────────────────────────────┐
│ 宿主 CLI（你的产品）                                          │
│  · 参数解析 / TUI / 会话历史 / 工具定义 / 权限确认             │
│  · 只认一个引用：provider:model                               │
│  · 想直接给用户看的：usage.summary() 的请求数、token、成本     │
└───────────────┬──────────────────────────────────────────────┘
                │  ① 嵌入式库：await mik.generate() / mik.stream()
                │  ② fetch 适配器：new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })
                │  ③ HTTP：POST http://127.0.0.1:3211/v1/chat/completions
                ▼
┌──────────────────────────────────────────────────────────────┐
│ model-infra-kit（mik）——模型层，四件自研 + 三个入口            │
│                                                              │
│  ProviderRegistry  供应商记录（id / protocol / baseUrl /       │
│                    api_key_ref），resolve() 时才取密钥         │
│  CredentialStore   env: / file: / keychain: 引用解析，密钥不落库│
│  PricingService    llm-pricing 目录 + 手动价，estimate() 出成本│
│  UsageService      每次调用（含失败）写一行事件，summary/query  │
│                                                              │
│  AiBridge（协议是一等公民）：protocol → @ai-sdk/* 包，数据映射 │
└───────────────┬──────────────────────────────────────────────┘
                │  loadProviderFactory(protocol) → 动态 import 可选 peer
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 供应商：DeepSeek / OpenAI / Anthropic / Google / Moonshot /    │
│        xAI / OpenRouter / 任何 OpenAI 兼容网关（含本地 mock）  │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 「Agent Runtime 只认 `provider:model`」

这是整份指南最重要的一条约定，也是宿主和模型层之间唯一的耦合点。

- 解析规则由 `splitModelRef()` 实现：按**第一个** `:` 切分并 trim；`provider:model` 直接拆。
- 裸模型名（`deepseek-chat`）→ 用 `providers.defaultModel()` 的 provider 拼成完整引用。
- 两者都缺 → 抛 `ModelInfraError{ code: "INVALID_REQUEST" }`。
- 供应商 id 是**全局唯一**的（表主键），因此不允许含 `:`（`/^[A-Za-z0-9._-]{1,64}$/`）。

宿主的做法：会话里存一个字符串 `provider:model`，其余什么都不用知道。换供应商、换网关、加价格覆盖，都不需要改宿主的工具层。

### 1.2 职责边界

| 归宿主 CLI | 归 mik |
|---|---|
| 参数解析、TUI、键位、主题 | 协议适配（`protocol` → `@ai-sdk/*`） |
| 工具定义与执行（`tool()` / `jsonSchema()`） | 工具循环（`stopWhen: stepCountIs(5)`）、tool_call 事件 |
| 会话历史、上下文裁剪 | 模型目录、上下文长度、能力位 |
| 权限/确认/沙箱 | 密钥引用解析、请求头注入、失败分类 |
| 想把成本给谁看、怎么展示 | token 计量、价格匹配、成本落库 |
| 升级策略、包分发 | `usage.summary()` / `query()` / `export` |

一句话：**宿主不要自己写供应商分支，也不要自己算钱。**

---

## 2. 最小接入代码（可直接跑，已实测）

完整可跑文件：[`examples/agent-cli/quickstart.ts`](../examples/agent-cli/quickstart.ts)。下面是与它等价的骨架。

```ts
import { jsonSchema, tool } from "ai"
import { ModelInfra, isModelInfraError } from "model-infra-kit"

// 1) 打开模型层：appId 写进每条用量事件，db 是 SQLite 路径（":memory:" 也可）
const mik = await ModelInfra.init({
  appId: "quickstart-agent",
  db: ":memory:",
  syncCatalog: false,                 // 真宿主可留默认 true（后台发现模型目录，不阻塞 init）
  providers: [                        // 首次运行 seed；同 id 已存在则跳过（见 §6.2）
    { id: "local", presetId: "custom-openai-compatible", baseUrl: "http://127.0.0.1:3221/v1" },
    // 真实供应商：{ id: "deepseek", presetId: "deepseek", apiKeyRef: "env:DEEPSEEK_API_KEY" }
  ],
  defaultModel: "local:deepseek-chat", // 省略 model 时用它
  onWarn: (message) => process.stderr.write(`[mik] ${message}\n`), // 非致命问题
})

try {
  // 2) 非流式
  const reply = await mik.generate({ messages: [{ role: "user", content: "Say hello." }] })
  console.log(reply.text, reply.usage, `$${reply.cost.usd}`, reply.cost.source)

  // 3) 流式 + 一次 tool calling（工具循环由 mik 驱动，最多 5 步）
  for await (const event of mik.stream({
    messages: [{ role: "user", content: "What time is it?" }],
    tools: {
      get_time: tool({
        description: "Current time from the local clock.",
        inputSchema: jsonSchema<{ timezone?: string }>({
          type: "object",
          properties: { timezone: { type: "string" } },
          additionalProperties: false,
        }),
        execute: async (input: { timezone?: string }) => ({
          timezone: input.timezone ?? "UTC",
          iso: new Date().toISOString(),
        }),
      }),
    },
    sessionId: "quickstart",           // 随事件落库，可 usage.query({ sessionId })
    tags: { feature: "chat" },         // 任意归因标签
  })) {
    if (event.type === "text_delta") process.stdout.write(event.text)
    if (event.type === "tool_call_complete") process.stdout.write(`[${event.call.name}] `)
    if (event.type === "usage") console.log(`\ncost=$${event.cost.usd}`)
    if (event.type === "finish") console.log(`steps=${event.response.steps}`)
    if (event.type === "error") throw Object.assign(new Error(event.error.message), { code: event.error.code })
  }

  console.log(mik.usage.summary())
} catch (error) {
  // 4) 按 error.code 分支，绝不匹配文案（文案会变）
  if (isModelInfraError(error)) {
    if (error.code === "CREDENTIAL") console.error("没配密钥：跑 `agent-cli model add ... --api-key-ref env:XXX`")
    else if (error.code === "RATE_LIMIT") console.error(`限流，retryable=${error.retryable}，稍后重试`)
    else if (error.code === "PROVIDER_NOT_FOUND") console.error("供应商不存在或已禁用，跑 `agent-cli model list`")
    else console.error(`${error.code}: ${error.message}`)
  } else {
    console.error(error)
  }
  process.exitCode = 1
} finally {
  // 5) 必须 close：等后台目录同步（上限 5s）后关掉 SQLite；close 后一切公开成员抛 STORAGE
  await mik.close()
}
```

真实运行（本机，mock 供应商，无外网）：

```console
$ node --experimental-transform-types --disable-warning=ExperimentalWarning \
    --import ./scripts/e2e/loader.mjs examples/agent-cli/quickstart.ts
generate: Mock answer to "Say hello.": this reply came from a local mock provider.
  model=deepseek-chat usage={"input":1200,"output":300,"cacheRead":0,"cacheWrite":0,"reasoning":0} cost=$0.0002475 (modelsdev)
stream: [get_time] The clock says 2026-09-09T16:03:15.348Z. (mock answer about "What time is it?", no network)
  cost=$0.000495 (modelsdev)
  steps=2 usage={"input":2400,"output":600,"cacheRead":0,"cacheWrite":0,"reasoning":0}
summary: {"requests":2,"successes":2,"failures":0,"successRate":1,"costUsd":0.000743,...}
[exit=0]
```

注意 `steps=2`：第一步是 `tool_calls`，第二步才是最终文本；两段的 token 都计入同一条用量事件。

### 2.1 错误码 → 宿主动作（`ModelInfraErrorCode` 全集）

| code | 宿主该做什么 |
|---|---|
| `CREDENTIAL` | 提示用户配 `--api-key-ref env:VAR` / 设环境变量；不要重试 |
| `AUTH` | 密钥无效或过期；提示更换，不要打印上游 body（mik 已丢弃） |
| `PROVIDER_NOT_FOUND` | 供应商未配置或 `enabled: false`；引导 `model list` / 重新 `model add` |
| `MODEL_NOT_FOUND` | 模型名不存在；`models --refresh` 或让用户改 `model use` |
| `RATE_LIMIT` | 可重试；`retryable` 为 true，指数退避 |
| `CONNECTION` / `TIMEOUT` | 网络/网关问题；提示检查 `baseUrl`，可重试 |
| `INVALID_REQUEST` | 宿主 bug（少了 model、引用格式错）；不要重试 |
| `PROVIDER` | 协议/peer 包问题（含「`npm i @ai-sdk/xxx`」提示）；按提示装包 |
| `PRICING_UNAVAILABLE` | 价格拿不到；调用仍然成功，成本记为 `source: "missing"` |
| `STORAGE` | 数据库打不开或实例已 `close()`；宿主生命周期 bug |
| `UNKNOWN` | 兜底；看 `error.cause` |

`error.message` 已脱敏、可直接展示；原始错误在 `error.cause`。

---

## 3. 宿主 CLI 的子命令设计建议

原则：**子命令的名字要对应用户的意图，而不是 mik 的类名**；每个子命令背后都只是 1–3 个 mik 调用。

| 子命令 | 背后 mik API | 为什么需要 / 注意 |
|---|---|---|
| `model add <id> --preset <p> --api-key-ref <ref>` | `providers.add({ id, presetId, baseUrl, apiKeyRef })` | 唯一「写配置」入口。`--api-key-ref` 只接受 `env:` / `file:` / `keychain:`，宿主自己做同样校验（示例里就是） |
| `model list` | `providers.list()`、`providers.defaultModel()`、`models.list()` | 让用户看见「现在能打哪个模型」；`models.list()` 空时提示 `mik models --refresh` |
| `model use <provider:model>` | `providers.setDefaultModel(ref)` | 写默认模型到 `settings` 表；之后 `chat` 不传 model 也能量 |
| `chat "<prompt>"` | `mik.stream({ messages, tools, sessionId, tags })` | 主路径。流式打印 `text_delta`，`tool_call_complete` 显示工具名，`usage`/`finish` 收尾 |
| `stats` | `usage.summary()` + `usage.query({ limit })` | 用户最关心的「花了多少钱、多少次」；行数用 `query().total` |
| `serve`（可选） | `mik serve` 或 `createServer({ hub: mik, port, host, token })` | 只有「多进程/多语言共用一份用量库」或「要给 IDE 插件接 HTTP」时才要 |
| `history`（可选） | `usage.query({ sessionId })`、`mik usage logs` | 会话级成本追溯 |
| `pricing set/list`（可选） | `pricing.setOverride()` / `listOverrides()` | 中转网关自报价、企业协议价 |
| `doctor`（可选） | `providers.resolve(id)`、`ai.test(id)` | 排障：密钥能否解析、端点是否可达 |

不建议宿主自己实现的（mik 已经做了）：`provider:model` 解析、模型名归一化、成本计算、token 汇总、CSV 导出、供应商协议分支。

### 3.1 用户第一次使用的最短路径（4 条命令）

```bash
# 1. 装（宿主包 + 你要用的协议的 peer）
npm i my-agent-cli @ai-sdk/deepseek

# 2. 配一个供应商（密钥只进环境变量）
my-agent model add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY
export DEEPSEEK_API_KEY=sk-...            # bash；PowerShell 用：$env:DEEPSEEK_API_KEY = "sk-..."

# 3. 选默认模型
my-agent model use deepseek:deepseek-chat

# 4. 用
my-agent chat "这个仓库的模型层做了什么？"
my-agent stats
```

如果宿主想把 mik 自带的 CLI 直接嵌进自己的进程（省一个入口）：

```ts
import { main } from "model-infra-kit/cli"          // 返回退出码，不调用 process.exit
const code = await main(["provider", "list"], { io: { out: console.log, err: console.error } })
```

`main(argv, options)` 支持 `io.out` / `io.err` / `cwd` / `env` / `interactive` 覆盖，适合被宿主接管输出。

---

## 4. 安装方式矩阵（6 + 1 种，含推荐顺序）

先给结论：**默认走 ①（宿主直接依赖 npm 包）**；只有在「要改 mik 源码」时走 ②，在「宿主不想背依赖 / 多语言 / 多进程」时走 ③。其余四种都是特定场景的补充。

| # | 方式 | 用户敲什么 | 升级 | 离线可用 | 对宿主打包体积 | 什么时候选 |
|---|---|---|---|---|---|---|
| ① | **npm 依赖（推荐）** | `npm i model-infra-kit @ai-sdk/deepseek` | `npm update model-infra-kit` | 首次装需网络；之后运行可离线（注入 `pricingFetch`） | +0.3 MB（mik dist）+ `ai` 6.7 MB + `llm-pricing` 0.2 MB + peer 0.4 MB | 绝大多数宿主。版本可审计、可 tree-shake、类型完整 |
| ② | **workspace 源码引用** | `"model-infra-kit": "workspace:*"`（同仓）/ 仓外 `file:`+先 build | 跟随仓库提交，无版本号 | 是（本地源码） | 不额外增加（就是同一份代码） | 你要改 mik 内部、或想同时调试宿主+模型层 |
| ③ | **npx sidecar** | `npx -y model-infra-kit serve --port 3211`，宿主只打 HTTP | `npx model-infra-kit@latest` | 首次需网络；之后缓存可离线 | 宿主 **0 依赖** | 宿主是 Python/Go/Rust，或多个进程共用一份用量库 |
| ④ | **tarball / 私有 registry** | `npm i ./model-infra-kit-0.1.0.tgz` 或 `npm i --registry <内网>` | 换 tarball 版本号 | 完全离线 | 同 ① | 内网交付、审计留档、锁定不可变制品 |
| ⑤ | **脚手架生成** | `npx create-my-agent@latest`（内部再 `npm i`） | 重新生成 / 由脚手架升 | 模板可缓存，依赖仍需网络 | 同 ① | 新项目起步，想让「装 mik」这一步对用户完全透明 |
| ⑥ | **git 直装** | `npm i github:<你的账号>/<仓库名>` | `npm i github:...#<新 commit>` | 需要 git + 网络 | 同 ①（前提是能装上） | 临时验证某个 commit。**现状不可直接使用**，见 §4.6 |
| ⑦ | **宿主插件 / 配置生成** | `my-agent plugin install mik` 或 `my-agent init` | 宿主自己的升级机制 | 取决于宿主 | 宿主自带 | 宿主已有插件生态，想把 mik 藏进配置里 |

### 4.1 ① npm 依赖（主路径）

```bash
npm i model-infra-kit                 # 库 + CLI + HTTP 服务
npm i @ai-sdk/deepseek                # 你实际用的协议，见下
```

- **必须单独装 provider 包**：`@ai-sdk/*` 是**可选 peer 依赖**，`npm i model-infra-kit` 不会自动带。用哪个协议装哪个包（`openai-compatible` → `@ai-sdk/openai-compatible`，`deepseek` → `@ai-sdk/deepseek`，……）。本仓库的实测输出见 §6.1。
- **升级**：宿主锁定 `^0.1.0`；mik 的公共面在 `docs/interfaces.md` 有契约，破坏性变更走次版本。
- **离线**：装的时候要网络；运行时可以完全离线——注入一个抛错的 `pricingFetch`，`llm-pricing` 的内置价格档案照常计价（上面 `cost=$0.0002475 (modelsdev)` 就是离线算出来的）。
- **体积**：`model-infra-kit` 打包后 95.1 kB / 解包 333.8 kB / 12 个文件；真正的大头是硬依赖 `ai`（6.7 MB）和 `llm-pricing`（0.2 MB），外加每个协议 peer 约 0.4 MB。宿主 CLI 一般把这些放在 dependencies（不进 bundle 的话无所谓）。
- **注意**：`model-infra-kit` **尚未发布到 npm**（本机 `npm view model-infra-kit` 返回 404）。发布前先看 §5。

### 4.2 ② workspace 源码引用

```jsonc
// 宿主 package.json（与 mik 在同一个 pnpm workspace 内）
{ "dependencies": { "model-infra-kit": "workspace:*" } }
```

本仓库的 `examples/cli-agent` 与 `examples/agent-cli` 就是这么写的；配合 `scripts/e2e/loader.mjs` 可以**不 build 直接跑 TS 源码**：

```bash
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --import ./scripts/e2e/loader.mjs examples/agent-cli/index.ts stats
```

workspace 外想引用源码目录，两种做法：

```bash
# A. 先构建，再用 file: 装（npm/pnpm 打包该目录，没有 prepare 就不会自动 build）
pnpm --filter model-infra-kit build
npm i ../model-infra-kit/packages/mik        # 或 pnpm add file:../model-infra-kit/packages/mik

# B. 用 link: 指向源码目录（不复制，改完即生效；同样需要 dist 存在）
pnpm add link:../model-infra-kit/packages/mik
```

- **升级**：跟着仓库提交走，没有版本号；适合「宿主和模型层一起发」的产品。
- **离线**：是（源码在本地）。
- **体积**：不额外增加。
- **什么时候选**：你要给 mik 提内部改动、或者两个包必须同版本联调。**不要**既 `workspace:*` 又 `npm i model-infra-kit`，会出现两份实例、两份用量库。

### 4.3 ③ npx sidecar（宿主零依赖）

```bash
# 宿主启动时拉起（或用容器/进程管理器托管）
npx -y model-infra-kit serve --port 3211 --token "$MIK_SERVER_TOKEN"

# 宿主（任何语言）只打 OpenAI 兼容端点
#   bash: curl -s http://127.0.0.1:3211/v1/chat/completions \
#           -H 'content-type: application/json' \
#           -d '{"model":"deepseek:deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
#   Windows PowerShell：JSON 写文件 + curl.exe（curl 在 PS 里是别名）
Set-Content -Encoding utf8 chat.json '{"model":"deepseek:deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
curl.exe -s -X POST http://127.0.0.1:3211/v1/chat/completions -H "content-type: application/json" --data-binary @chat.json
```

- 宿主侧只改 `base_url`（示例见 `examples/python-host/host.py`）；请求体里的 `provider:model` 决定路由，宿主的认证头会被剥离并由 mik 按协议附上配置好的凭据。
- `GET /api/health` 可以探活；`--token` / `MIK_SERVER_TOKEN` 一旦设置，除健康检查外都要 `Authorization: Bearer <token>`。
- **升级**：`npx model-infra-kit@latest` 或宿主里写死版本号；注意 npx 缓存，生产建议固定 `@0.1.0`。
- **离线**：npx 首次要网络（之后走本地缓存）；已装好的机器可以完全离线运行。
- **体积**：宿主 0 依赖，代价是多一个进程 + 一个本地端口（默认 3211；本机禁用的端口是 3080/3001/3111/8899，起服务前先 `netstat -ano | findstr :3211` 确认）。
- **什么时候选**：宿主不是 Node、或多个 Agent 进程要共用一份用量库、或想让 mik 独立升级。

### 4.4 ④ tarball / 私有 registry（内网交付）

```bash
# 产出制品（仓库内）
cd packages/mik && npm pack          # → model-infra-kit-0.1.0.tgz（95.1 kB，12 个文件）
# 宿主侧
npm i ./artifacts/model-infra-kit-0.1.0.tgz
# 或内网 registry
npm i model-infra-kit --registry https://npm.internal.example/
```

- **升级**：换 tarball 文件名/版本号，制品不可变、可审计。
- **离线**：完全离线（前提是 `ai` / `llm-pricing` / peer 包也在内网源或随 tarball 一起交付）。
- **体积**：同 ①。
- **什么时候选**：金融/政企内网、要留制品指纹（`npm pack` 会打印 shasum 与 integrity）。

### 4.5 ⑤ 脚手架生成

```bash
npx create-my-agent@latest my-agent      # 内部：写 package.json → npm i model-infra-kit @ai-sdk/deepseek → 生成配置
```

- 价值在于把 §3.1 的四步压成一步，并且**替用户选好 peer 包**（这是新手最容易漏的坑）。
- **升级**：脚手架升级 / 用户重新生成；mik 版本由模板里的 `^0.1.0` 决定。
- **离线**：模板可以本地缓存，但依赖安装仍需源。
- **体积**：同 ①。
- **什么时候选**：面向外部开发者发布宿主 CLI 时，作为「第一次装」的入口。

### 4.6 ⑥ git 直装（现状：不可直接使用）

```bash
npm i github:<你的账号>/<仓库名>          # ✗ 装到的不是可用的包
```

原因（本仓库实测）：

- 要发布的包是 **`packages/mik`**，不是仓库根；根 `package.json` 是 `"private": true` 的 monorepo 壳，没有 `exports` / `bin`。
- `dist/` 被 `.gitignore` 忽略（`git ls-files packages/mik/dist` 命中 0 个文件），而 `packages/mik/package.json` **没有 `prepare` / `prepack` 脚本**，git 安装不会替你构建。
- 结果：宿主拿到的是「没有 dist 的包」，`import "model-infra-kit"` 直接解析失败。

要让它能用，二选一（都属于宿主/发布方的改造）：

1. 给 `packages/mik` 加 `"prepare": "tsdown"`（并确保消费方能跑构建，或用 `pnpm` 的 git 安装）；
2. 把构建产物随包提交（或发布 tarball 到内网源）。

**升级**：`npm i github:...#<commit>`；**离线**：需要 git + 网络；**体积**：同 ①。
**什么时候选**：只想验证某个未发布 commit 的行为，且愿意先做上面的改造。

### 4.7 ⑦ 宿主插件 / 配置生成

```bash
my-agent plugin install mik            # 宿主写自己的配置
my-agent config init --provider deepseek --api-key-ref env:DEEPSEEK_API_KEY
```

- 本质是「宿主内部再走 ① 或 ③」，对用户暴露成宿主自己的概念；配置文件就是 `mik.config.json`（`appId` / `db` / `initialProviders`），CLI 的 `--config` 和 `MIK_CONFIG` 都认它。
- **升级**：宿主自己的升级机制；mik 版本被宿主锁死，用户无感。
- **离线**：取决于宿主；如果宿主自带 mik 依赖则离线可用。
- **体积**：宿主自带（同 ①）。
- **什么时候选**：宿主已有插件体系、且不想让用户直接接触 mik 概念。**不要**把它做成唯一的安装方式——高级用户仍然需要 ①。

### 4.8 推荐顺序与理由

1. **① npm 依赖** —— 语义化版本、类型完整、可审计、可离线运行；是唯一能让宿主「自己写调用代码」又不用维护供应商分支的方式。
2. **② workspace 源码引用** —— 只有需要改 mik 或双包联调时才优先；它换来的是即时反馈，代价是没有版本边界。
3. **③ npx sidecar** —— 宿主不想背 Node 依赖、或跨语言/多进程共用用量库时的正解；代价是多一个进程和端口。
4. **④ tarball / 私有 registry** —— ① 的离线/合规版，企业内网首选。
5. **⑤ 脚手架生成** —— 对外发布宿主时的「第一公里」体验，落地后仍回到 ①。
6. **⑥ git 直装** —— 临时验证用；当前需要先补 `prepare` 或提交 dist，不推荐作为长期方案。
7. **⑦ 宿主插件/配置生成** —— 作为 ① 的封装，不能替代 ①。

---

## 5. 发布前清单（宿主把 mik 打进自己的 npm 包之前）

1. **peer 依赖要一起声明**。宿主 `package.json` 里把用户实际用的协议写进 `dependencies`（或 `peerDependencies` + `peerDependenciesMeta.optional`），否则用户第一次调用会撞 §6.1 的错误。
2. **`node:sqlite` 有 Node 版本门槛**。`engines.node >= 22.13.0`（本机 24.14）。首次 import 会打一行 `ExperimentalWarning: SQLite is an experimental feature`；宿主可 `node --disable-warning=ExperimentalWarning` 只压这一类，或在启动器里设 `NODE_OPTIONS=--no-warnings`。
3. **看板不在包里**。`model-infra-kit` 的 `files` 只有 `dist` 与 `LICENSE`（本机 `npm pack --dry-run` 实测 12 个文件、无 `apps/dashboard`）；`mik dashboard` 在装包环境会直接报错并给出指引。宿主不要承诺「装完就有看板」。
4. **`files` / `exports` / `bin` 三件套要对**：`dist`、`./server`、`./cli`、`bin: mik`。宿主自己发版时同样别把测试、`_research/`、`apps/` 打进包里。
5. **密钥只以引用形式出现**。宿主自己的文档、日志、截图里都不要出现明文 key；provider 行只存 `api_key_ref`。
6. **`appId` 要固定**。它是用量归属的唯一标识，改了等于换了一份账本（一库多 app 时尤其明显）。
7. **升级路径写清楚**：宿主版本 ↔ mik 版本 ↔ peer 包版本的对应关系；破坏性变更在 mik 侧走次版本，宿主自己发大版本时同步。
8. **自检命令**（本机真实输出）：

```console
$ cd packages/mik && npm pack --dry-run
npm notice package: model-infra-kit@0.1.0
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 14.4kB README.md
npm notice 7.6kB dist/cli.d.mts
npm notice 64.0kB dist/cli.mjs
npm notice 31.9kB dist/hub-BJAyRxVY.d.mts
npm notice 110.2kB dist/hub-Da7maM2z.mjs
npm notice 10.2kB dist/index.d.mts
npm notice 1.2kB dist/index.mjs
npm notice 17.2kB dist/registry-Banrud7y.mjs
npm notice 6.6kB dist/server.d.mts
npm notice 67.5kB dist/server.mjs
npm notice 1.9kB package.json
npm notice package size: 95.1 kB
npm notice unpacked size: 333.8 kB
npm notice total files: 12
```

---

## 6. 常见坑（每条都有本机实测输出）

### 6.1 provider 包要单独装（否则第一次调用就炸）

`@ai-sdk/*` 是**可选 peer**，按协议在调用时动态 import。实测：把**构建后的包**（`dist` + `package.json`）拷进一个只装了 `ai`、`llm-pricing` 的 `node_modules`，不装任何 `@ai-sdk/*`：

```console
$ node examples/agent-cli/peer-missing.mjs
scratch install: C:\Users\...\Temp\mik-agent-cli-peer-sim-20036\node_modules\model-infra-kit
  installed:     model-infra-kit (dist) + ai + llm-pricing
  NOT installed: @ai-sdk/*  (the optional provider peers)

init() with no @ai-sdk/deepseek installed: OK (the import is lazy)

generate() →
  code    PROVIDER
  message The provider package @ai-sdk/deepseek is not installed. Run: npm i @ai-sdk/deepseek

PASS  PROVIDER error naming the exact package to install
```

要点：`init()` 不会失败（否则宿主启动就挂），失败发生在**第一次真实调用**，`code` 是 `PROVIDER`，文案里点名要装哪个包。宿主的 `doctor` 子命令应当在启动时主动 `providers.resolve(id)` 或 `ai.test(id)`，把这个坑提前。

### 6.2 同 id 的 provider 配置，seed 不覆盖

`ModelInfra.init({ providers })` 走的是 `providers.seed()`：**已存在就跳过**。所以第二次用同样的 id 想改 `baseUrl` 是无效的，必须显式 `providers.add()`。

```console
$ node --import ./scripts/e2e/loader.mjs examples/agent-cli/pitfalls.ts
[2] seeding the same provider id twice does not overwrite the stored config
    PASS  the first registration wins
          stored baseUrl=http://first.example/v1 (use providers.add() to change it)
```

宿主规则：**seed 只用于「首次初始化」，改配置一律走 `add()`**（它同时是 upsert）。

### 6.3 `close()` 之后调用任何公开成员都抛 `STORAGE`

`close()` 会等后台目录同步（上限 5s）再关 SQLite；之后 `providers` / `pricing` / `usage` / `models` / `generate` / `stream` / `fetch` 全部抛 `ModelInfraError{ code: "STORAGE" }`（而不是裸的 `ERR_INVALID_STATE`）。

```console
$ node --import ./scripts/e2e/loader.mjs examples/agent-cli/pitfalls.ts
[3] every public member throws STORAGE after close()
    PASS  generate() → STORAGE
          code=STORAGE message=Cannot use generate(): this ModelInfra instance has been closed. Create a new one with ModelInfra.init().
    PASS  usage.summary() → STORAGE
          code=STORAGE message=Cannot use usage: this ModelInfra instance has been closed. Create a new one with ModelInfra.init().
```

宿主规则：一个实例一个生命周期，`finally` 里 `close()`；进程复用要 `ModelInfra.init()` 新实例。别把 `mik.fetch` 存到全局后在关闭后继续用。

### 6.4 `init()` 不校验供应商，端点不可达也要到调用时才报

```console
$ node --import ./scripts/e2e/loader.mjs examples/agent-cli/pitfalls.ts
[1] init() does not validate a provider: an unreachable endpoint only fails at call time
    PASS  init() ok, generate() reports a transport code
          code=CONNECTION message=Could not reach the provider endpoint. Check the base URL and network.
```

（`docs/SPEC.md` 的硬性规则：启动不得被上游阻塞。所以 `init()` 只保证「数据库能打开、显式配置合法」。）

### 6.5 裸模型名没有默认模型 → `INVALID_REQUEST`

```console
$ node --import ./scripts/e2e/loader.mjs examples/agent-cli/pitfalls.ts
[4] a bare model name with no default model is INVALID_REQUEST
    PASS  resolveModel() → INVALID_REQUEST
          code=INVALID_REQUEST message=No default provider is configured, so the bare model "deepseek-chat" cannot be routed. Set a default with providers.setDefaultModel("provider:model").
```

宿主首次启动应引导用户走 `model use`，或者自己传完整 `provider:model`。

### 6.6 多 app 共库：哪些是全局的

- `providers` / `models` / `pricing_overrides` 三张表**全局共享**（供应商 id 全局唯一）：app B 能看到 app A 的 `baseUrl` / `apiKeyRef`，但看不到密钥本身。
- `usage.summary/trends/query` 等**默认只返回本实例 appId 的数据**；`get(id, { appId: "" })` 才放开（仅调试）。
- `usage.clear()` 是 app 级的；`usage.rollupAndPrune()` 是**全局维护操作**，会处理所有 app 的过期明细，只由一个 app 调用即可。

---

## 7. 核对：本文件出现的命令/API 都在仓库里

| 本文件提到的 | 仓库位置（grep 命中） |
|---|---|
| `ModelInfra.init()` / `generate()` / `stream()` / `close()` / `resolveModel()` / `setBaseUrl()` | `packages/mik/src/hub.ts:301 / 469 / 572 / 586 / 429 / 418` |
| `providers.add/list/get/remove/setEnabled/resolve/defaultModel/setDefaultModel/seed` | `packages/mik/src/registry/registry.ts:71 / 62 / 66 / 124 / 143 / 148 / 209 / 213 / 231` |
| `usage.record/summary/trends/byProvider/byModel/query/get/clear/rollupAndPrune` | `packages/mik/src/usage/service.ts:59 / 80 / 84 / 88 / 92 / 96 / 108 / 130 / 125` |
| `pricing.state/estimate/priceFor/setOverride/removeOverride/listOverrides/candidates` | `packages/mik/src/pricing/service.ts:113 / 123 / 156 / 169 / 186 / 190 / 195` |
| `models.list/get/refresh` | `packages/mik/src/hub.ts:94 / 95 / 96` |
| `splitModelRef` / `MODEL_REF_SEPARATOR` / `DEFAULT_MODEL_SETTING` / `getPreset` / `packageForProtocol` / `PROTOCOL_PACKAGES` | `packages/mik/src/registry/registry.ts:42,8,11`、`presets.ts:99 / 104 / 10` |
| `loadProviderFactory`（peer 缺失报错） | `packages/mik/src/ai/protocols.ts:110`（错误文案在 118–124） |
| `ModelInfraError` / `isModelInfraError` / 错误码全集 | `packages/mik/src/errors.ts:3`（12 个 code） |
| CLI：`init` / `serve` / `dashboard` / `provider add\|list\|remove\|test` / `models` / `pricing list\|sync\|set` / `usage summary\|trends\|logs\|export` | `packages/mik/src/cli/args.ts:246 / 257 / 268 / 275 / 313 / 319 / 341` |
| 全局开关 `--db` / `--app-id` / `--config` / `--cache-dir` / `--offline` | `packages/mik/src/cli/args.ts:77`（`GLOBAL_FLAGS`） |
| `main(argv, options)` / `parseCliArgs` | `packages/mik/src/cli/index.ts:64`、`args.ts:409` |
| `createServer` / `DEFAULT_HOST` / `DEFAULT_PORT` | `packages/mik/src/server/server.ts:124 / 24 / 25` |
| `createMikFetch` / `mik.fetch` / `mik.baseUrl` | `packages/mik/src/fetch.ts:68`、`hub.ts:258 / 413` |
| `X-ModelHub-Provider` 请求头 | `packages/mik/src/server/openai.ts:279` |
| 入口 `model-infra-kit` / `/server` / `/cli` + `bin: mik` | `packages/mik/package.json`（exports / bin） |

---

## 8. 参考

- 可跑骨架与坑位实测：[`examples/agent-cli/`](../examples/agent-cli/)（`index.ts` / `quickstart.ts` / `mock-provider.mjs` / `pitfalls.ts` / `peer-missing.mjs`）
- API 速查：[`packages/mik/README.md`](../packages/mik/README.md)
- 契约（唯一真相）：[`docs/interfaces.md`](interfaces.md)
- 三种接入面：[`README.md`](../README.md)（嵌入式库 / fetch 适配器 / HTTP 服务）
- 取舍理由：[`docs/decisions.md`](decisions.md)；本机实测事实：[`docs/verified-facts.md`](verified-facts.md)
