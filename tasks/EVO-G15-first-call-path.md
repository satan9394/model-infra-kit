# EVO-G15 — 让「第一次成功调用」的官方路径真的走得通

> 来源：独立 UX 审计（R113，`.tmp/ux-audit-2026-09-11.md`）+ 编排者综合（`.tmp/gap-map-increment-R113.md`）
> 覆盖 GAP：**G54（P0）/ G55（P1）/ G56（P1）/ G59（P2）/ G62（P2）**

## 目标（一个用户结果，不是五个功能）

新用户**只按官方帮助与 `init` 引导字面照做**，就能走到 `POST /v1/chat/completions → 200` 且用量入账；
中途**不再出现** 502 / 401 / 400 这三类「因为没被提前告知」的错误。

## 用户场景

一个不了解本项目的开发者：`npm i model-infra-kit` → 看 `--help` → `init` → 配供应商 → 起服务 → 发第一次请求。

## 当前问题（审计实测证据）

| # | 现象 | 证据 |
|---|---|---|
| **G54** | 干净安装后发请求 → `502 {"message":"The provider package @ai-sdk/openai-compatible is not installed. Run: npm i @ai-sdk/openai-compatible"}`；补装后**同一请求立刻 200** | 审计 F1 |
| **G55** | `serve --help` 把 `--token` 写成「Require Authorization: Bearer <token> on the HTTP API」（像可选加固）；实际**不设 token 则写端点 401**，启动横幅也不提示 | 审计 F3 |
| **G56** | 裸模型名 → `400 … Set a default with providers.setDefaultModel("provider:model")`——**只有 JS 库有的 API**；CLI 无此命令；`provider list` **不列默认模型**（帮助却称会列） | 审计 F4 |
| **G59** | `init --yes` 输出「1. …」后接一串**无编号**命令；`--provider` 缺省时**不注册任何供应商**（帮助却说会写「首个供应商」）；示例硬编码 `deepseek` | 审计 F7 |
| **G62** | `--help` 的 7 条示例止于 `pricing set`/`usage export`，**没有一条是真实调用**；`init` 引导终点也只到「起服务」 | 审计 F9 |

## 理想行为（要点）

1. **G54 — 主动告知，不捆绑**（**硬约束**：**不得**把 `@ai-sdk/*` 改成 `dependencies`，那会破坏「安装体积小」这一已声明的设计取舍）：
   - `provider add` 成功后：若该协议对应的 `@ai-sdk/*` 包**不可解析**，打印一行可复制的安装命令（按协议映射：`openai-compatible` → `@ai-sdk/openai-compatible`、`deepseek` → `@ai-sdk/deepseek`、`anthropic` → `@ai-sdk/anthropic` …，映射表从既有 `protocol → sdk package` 的**单一真相**取，**不要新写第二份**）。
   - `serve` 启动时：若**已配置的供应商**所依赖的协议包缺失，横幅给一行「写端点可能 502：`npm i <pkg>`」式提示（**不阻塞启动**，遵守硬性规则 6）。
   - `README` 快速开始把「另装协议包」写成**显式一步**（不是脚注）。
2. **G55**：`--token` 帮助改为**如实描述默认行为**（不设置 → 只读端点开放、写端点 401）；`serve` 横幅在**无 token 时**加一行「写端点已禁用（设 `--token` 或 `MIK_SERVER_TOKEN` 启用）」。**不要改默认策略**（默认拒绝写是对的）。
3. **G56**：`400` 文案补一句「或直接用 `<provider>:<model>` 形式的模型 id（见 `GET /v1/models`）」；`provider list` **真的列出默认模型**（帮助已宣称如此）。**本卡不新增 `set-default` 命令**（登记 NEXT）。
4. **G59**：`init --yes` 的引导改为**真正编号且顺序正确**的三步，**最后一步落在「发出第一次调用」**；`init --help` 补「不带 `--provider` 时不注册供应商」；示例里的 `deepseek` 换成 `<presetId>` 或候选列表。
5. **G62**：`--help` 示例区与 `init` 引导末尾各加**一条可复制样例**（起 serve → 带 token POST → 模型带 provider 前缀），并指向 `GET /v1/models` 取 id。

## 涉及模块

`packages/mik/src/cli/commands/{init,provider,serve}.ts`、`packages/mik/src/cli/help.ts`、`packages/mik/src/cli/i18n/{zh,en}.ts`、`packages/mik/src/ai/`（仅在需要读既有协议→SDK 映射时）、`README.md`、`packages/mik/test/cli.test.ts`

## 不能破坏什么

- **`@ai-sdk/*` 仍是 optional peer**（不得改依赖声明）。
- **写端点默认拒绝**的策略不变；`GET /v1/models` 等读端点行为不变。
- **`serve` 不阻塞启动**（缺协议包只提示，不退出）。
- **英文面零回归**：`MIK_LANG=en` 下所有被改动的文案需与改前**逐字一致**（除刻意新增的提示行，须明确列出）。已有 `cli-english-surface.test.ts`（5 类错误形状）必须保持 5/5 绿。
- 退出码语义不变（未知命令/选项 = 2；运行时失败 = 1）。
- 既有 472 例测试全绿；`init --yes` 的**产物**（`mik.config.json` 的 `appId`/`db` 两键）不变。

## 验收标准

- **A1（核心）**：按**官方 `--help` + `init` 引导的字面路径**（**不含试错**）走完，能到 `200` 且 `usage logs` 出现对应行。**必须自己搭 mock 供应商实测**，并把完整命令序列与输出贴进证据（参考审计员的做法：本地 mock OpenAI 服务）。
- **A2**：上述路径中**不再出现** 502 / 401 / 400；若某前提确实无法自动满足（如需装协议包），**必须在**用户走到那一步**之前**就被明确告知（有测试断言该提示存在）。
- **A3**：`provider list` 在有默认模型时**打印**该默认模型（无默认模型时行为不变）。
- **A4**：`README` 快速开始含显式「另装协议包」一步，且示例命令可复制执行。
- **A5**：zh 下新增文案为中文、en 下为英文；`i18n` 键两侧对等。
- **A6**：`tsc --noEmit` 0 错误；全量测试在 **zh-CN 与 en-US 两种 locale** 下均全绿（基线 472）；`node scripts/e2e/run.mjs` exit 0；`node scripts/check-envs.mjs` 三环境 PASS；push 后 **CI 三 OS 绿**。

## 错误场景

- 协议包缺失时：`provider add` 提示可复制；`serve` 启动提示但不退出。
- 无 token 起 serve：横幅明确写「写端点已禁用」；POST 仍 401（信息一致）。
- 无默认模型时用裸模型名：400 文案给出 `<provider>:<model>` 出路。
- `init --provider <不存在>`：维持既有报错行为（如已有）。

## 测试要求

- ≥8 新用例，全部**注入 `MIK_LANG`**（不得读真实 locale）：
  1. `provider add` 后协议包缺失 → stdout 含确切安装命令（**构造「缺失」条件**，例如指向一个不存在的包名映射或 mock 解析失败）
  2. 协议包存在时**不**打印该提示（防噪声）
  3. `serve --help` 的 token 描述包含「不设置时写端点被禁用」语义
  4. 无 token 启动横幅含「写端点已禁用」
  5. 有默认模型时 `provider list` 打印默认模型
  6. 无默认模型时裸模型请求的 400 文案含 `<provider>:<model>` 出路（可对错误文案做单测或经 mock 请求）
  7. `init --yes` 引导含编号 1/2/3 且末步含一次调用样例
  8. `--help` 示例区含一条包含 `/v1/chat/completions` 的样例
- **写卡自检（G43）**：每条断言在**改前**必须能红——请先跑一遍确认，不会红的断言等于没写。

## 范围外（防 scope creep）

`@ai-sdk/*` 改 dependencies、新增 `set-default` 命令、看板随包发布、子命令 `--help` 选项说明本地化（**G58**，独立一片）、`ExperimentalWarning` 抑制（**G61**，需先定策略）、文档入口统一（**G63**）、跨项目隔离提示（**G64**）。
