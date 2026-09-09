# T11 — 接入方式全景与运营分析（`docs/integration-playbook.md`）

**目标**：回答「这个模块接入到别的功能模块里，究竟有哪些方式」，并给出网页端要不要自带可视化的结论。
**拥有文件**：`docs/integration-playbook.md`（新建）。其它文件一律不改。

## 必读
- `README.md`、`packages/mik/README.md`、`docs/SPEC.md`、`docs/interfaces.md`、`docs/decisions.md`
- `examples/**`、`scripts/e2e/run.mjs`、`apps/dashboard/README.md`
- `packages/mik/src/index.ts`（公共面）、`packages/mik/src/cli/**`（命令面）

## 必须交付的内容

1. **两张正交矩阵**
   - **调用面（宿主怎么调）**：嵌入式库 / `hub.fetch` 适配器 / HTTP+OpenAI 兼容端点 / HTTP API+SSE / 用量事件上报（`POST /api/usage/events`）。每格写：适用场景、改动量（行数级）、跨语言、能否拿到实时用量、失败模式。
   - **分发面（代码怎么到宿主）**：npm 包 / GitHub 直装 `npm i github:...` / workspace 或 submodule 源码引用 / `npx` 免安装 sidecar / 脚手架生成 / 宿主插件或配置生成器 / 纯配置（只改 base_url）。每格写：适用场景、安装命令、升级方式、离线可用性、对宿主构建的影响。

2. **决策树**：给一段「如果你是这样，就选这条」的判据（自研 CLI / 已有 OpenAI SDK 代码 / Python 或 Go 项目 / 浏览器端 / 多进程共用 / 只想看成本不想改代码）。

3. **网页端要不要自带可视化**（用户点名的问题，必须给出明确结论 + 理由 + 三种可选做法）
   - 结论要基于事实：看板是独立 Next.js 应用、只走 `/api/*`、不读 SQLite、不随 npm 包发布。
   - 至少覆盖：① sidecar 反向代理（`/usage` 挂到主站）② 复用 `/api/*` 自建 UI ③ 直接复用 `apps/dashboard` 页面组件。给出各自工作量、耦合度、品牌化能力。
   - 明确说清「库本身不含 UI」这一事实，避免宿主误以为装了包就有页面。

4. **运营建议**：按「接入摩擦」排序的推广路径（哪条最先做、哪条最能降低放弃率）、以及需要补的能力清单（例如脚手架、插件、Docker 镜像），每条给出理由与优先级。

## 验收

- 文档中每条命令、每个 API 路径、每个端口都必须在仓库里真实存在（用 grep/read 核对，不得杜撰）。
- 结论必须可执行：读者照着能选出一条路并知道下一步敲什么命令。
- 不改任何源码；不新增未经验证的能力宣称。
