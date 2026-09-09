# T12 — 自研 Agent CLI 接入指南 + 可跑骨架

**目标**：回答「要开发一个类似 Claude Code 的 Agent CLI，该怎么把 mik 装进去」，并交付一个能跑的最小骨架。
**拥有文件**：`docs/agent-cli-guide.md`（新建）、`examples/agent-cli/**`（新建）。其它文件一律不改。

## 必读
- `README.md`、`packages/mik/README.md`、`docs/interfaces.md`
- `examples/cli-agent/index.ts`（已有的嵌入式示例，可参考但**不要改**）
- `scripts/e2e/loader.mjs`（如何在仓库内直跑 TS 源码）
- `packages/mik/src/index.ts`、`packages/mik/src/cli/**`

## 必须交付

1. **`docs/agent-cli-guide.md`**，至少包含：
   - **架构图**：宿主 CLI（TUI/命令层）→ mik（模型层）→ provider；说明「Agent Runtime 只认 `provider:model`」。
   - **最小接入代码**：从 `ModelInfra.init()` 到 `generate` / `stream` / tool calling 的完整片段，含 `close()` 与错误处理（按 `error.code` 分支，不要匹配文案）。
   - **CLI 命令设计建议**：宿主应暴露哪些子命令（`model add|list|use`、`stats`、`serve`），每个背后对应 mik 的哪个 API；给出「用户第一次使用」的最短路径（几条命令）。
   - **安装方式矩阵**（用户点名要「好好想一想」的部分）：至少比较 6 种——`npm i`、`npm i github:satan9394/model-infra-kit`、workspace 源码引用、`npx` sidecar、脚手架生成、宿主插件/配置生成。每种给出：用户敲什么、升级怎么做、离线可用性、对宿主打包体积的影响、什么时候该选它。**并明确给出推荐顺序与理由。**
   - **发布前清单**：宿主项目要发 npm 时需要注意什么（peer 依赖、`node:sqlite` 的 Node 版本、看板不在包里）。
   - **常见坑**：至少写清「provider 包要单独装」「同 id 的 provider 配置 seed 不覆盖」「关闭后调用会抛 STORAGE」。

2. **`examples/agent-cli/`**：一个能跑的极简 Agent CLI 骨架（不是玩具截图，要真能执行）：
   - 子命令：`model add <id> --preset <p> --api-key-ref <ref>`、`model list`、`model use <provider:model>`、`chat "<prompt>"`、`stats`。
   - `chat` 走 `mik.stream()`，逐段打印；支持一次 tool calling（工具用内置的 `get_time` 之类，不联网）。
   - `stats` 打印 `mik.usage.summary()`。
   - 用本地 mock provider 可离线跑通；提供 `README.md` 说明怎么用真实 key 跑。

## 验收（必须真跑并贴输出）

1. `examples/agent-cli` 的每条子命令真实执行一次，贴输出（用本地 mock provider，禁止外网）。
2. `stats` 显示真实写入的用量行数与成本。
3. 指南里每条命令/API 都在仓库里真实存在（grep 核对）。
4. 不改 `packages/mik/**`、`apps/dashboard/**`、`README.md`。
5. 跑完停掉所有进程，不留监听端口。

## 交证

按 `AGENTS.md` 格式，附子命令真实输出与文件清单。
