# EVO-G09 — 看板首启体验 + 装包用户可发现性（UX P2×2 + 可靠性 P2）

> 来源：Product Evolution Orchestrator 第 9 轮 vertical slice（耦合小问题集群）。
> 依据：`.tmp/audit-ux.md` 问题 5（装包用户看用量出口未前置）、问题 7（看板首屏「先报错后指引」）；`.tmp/audit-reliability.md` P2-2（`dashboard.ts` win32 用 `shell: true`）。

## 目标

让「第一次打开看板 / 第一次想看用量」的用户**先看到指引、再看到数据**，而不是先看到错误横幅；并顺手去掉 dashboard 启动路径上 `shell: true` 这个可腐化的注入面。**不新增功能**。

## 用户场景

- 装包用户（`npm i model-infra-kit`）按直觉跑看板/找用量：README 的嵌入小节末尾直接告诉他「看用量有三条 CLI 命令，或自建 UI 走 `/api/*`」，不必翻到「看板」一节才发现看板不随包发布。
- 开发者 clone 仓库起看板但忘了先 `mik serve`：首屏**第一行**是常规样式的「需要先启动上游：`mik serve`」，而不是红字错误横幅叠加空态；错误横幅只在**确实连不上且已提示过**时出现。

## 当前问题（已核验）

- `apps/dashboard/components/ui.tsx:127` 的「上游 mik serve 不可用」是**错误样式横幅**，`apps/dashboard/components/views/overview.tsx:65-68` 的正确指引文案在其**之后**才出现 → 呈现为「报错 → 解释」。
- `README.md`「三种接入方式」小节（约 48–212 行）结束时**未提示装包用户如何看用量**；看板不随包发布的事实只在「看板」一节（约 216 行起）说明。
- `packages/mik/src/cli/commands/dashboard.ts:81-90`：`shell: !useLocalNext && process.platform === "win32"` —— 当前参数为常量故无实际注入点，但这是「未来把用户输入拼进命令行即注入」的可腐化面（同文件既有 `execFile` 风格可借鉴）。

## 理想行为（变更点）

1. **看板首屏顺序反转**（`apps/dashboard`）：
   - 当上游不可达时，首屏**第一块**渲染常规信息样式（非 error 语义）的「先启动上游：`mik serve`」指引 + 一条可复制的命令；错误横幅要么不再使用、要么仅在用户点过「重试」后仍失败时出现。
   - 指引文案保留既有 `overview.tsx` 的准确性，不新增页面/路由。
2. **README 前置**：在「① 嵌入式库」小节末尾加一行「查看用量：`mik usage summary` / `usage logs` / `usage export`（CLI），或自建 UI 走 `/api/*`；看板不随包发布，见下文『看板』」。
3. **去掉 `shell: true`**：`dashboard.ts` 的 win32 分支改为不启用 shell（pnpm 走 `pnpm.cmd` 或等价的无 shell spawn），行为与输出不变；若 `useLocalNext` 分支已无 shell 则只改另一分支。
4. **契约/文档**：若 `dashboard.ts` 的启动方式对宿主可见（如 README 的 dashboard 说明），同步一句「不依赖 shell 解析」；`docs/interfaces.md` 仅在公共面变化时才需要改（本卡预计不需要）。

## 涉及模块

- `apps/dashboard/components/ui.tsx`（错误横幅语义/位置）
- `apps/dashboard/components/views/overview.tsx`（首屏指引顺序）
- `apps/dashboard/components/views/{trends,logs,pricing}.tsx`（若同样「先报错后指引」，同步顺序）
- `packages/mik/src/cli/commands/dashboard.ts`（去掉 `shell: true`）
- `README.md`（嵌入式小节前置「怎么看用量」）

## 不能破坏什么

- 看板既有页面/路由/embed 路由与 e2e 的 DASH 检查点（它断言真实数字渲染）。
- 空态文案与每处「可行动作」链接（UX 审计确认这部分已达标）。
- `mik dashboard` 的启动方式与退出码语义、端口预检、装包环境报错指引。
- README 已校对内容（交叉 shell 写法、密钥引用、版本相关表述）。

## 验收标准

- A1 **首屏顺序**：上游不可达时，首屏第一个可见区块是常规样式的「先启动上游」指引（`grep` 或组件断言：指引在错误横幅之前渲染/错误横幅不再作为首块）。e2e DASH 仍全绿。
- A2 **README 前置**：嵌入式接入小节内出现「查看用量」与其三条命令；与「看板」节的说明不矛盾。
- A3 **无 shell**：`dashboard.ts` 不再出现 `shell: true`（grep 断言）；`mik dashboard` 仍能拉起看板（真实冒烟：起服务 → 3210 监听 → 结束进程 → 端口释放）。
- A4 回归：看板既有页面在「上游可用」时渲染不变（e2e DASH + 现有 dashboard 测试）；`mik dashboard --help` 输出不变。
- A5 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **405** 例）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

- 看板上游不可达且用户点击重试仍失败 → 此时才展示错误样式横幅（含 `mik serve` 命令与端口）；不得出现「两个都像错误」的重复提示。
- `pnpm` 不存在（有本地 next）→ 走既有本地 next 分支，不变。
- `pnpm.cmd` 在非 win32 或缺失 → 保持既有的清晰报错（不得因去掉 shell 而变成模糊错误）。

## 测试要求

- 看板侧：若现有 dashboard 测试基建可断言渲染顺序，补 1 例（指引在错误横幅之前）；否则以 e2e DASH + 组件结构断言替代，并在报告说明所用方式。
- CLI 侧：`grep -c "shell: true" packages/mik/src/cli/commands/dashboard.ts` 为 0 的断言 + `mik dashboard` 真实冒烟（起/停/端口）。
- 不得为测试放宽生产默认。

## 范围外

看板 i18n 全面化（G08 只声明边界）、看板预算可视化、任何新功能/新路由、G10a/G10b。