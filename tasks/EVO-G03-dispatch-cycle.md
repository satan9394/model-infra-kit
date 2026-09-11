# EVO-G03 — 收敛 cli↔repl 循环依赖（G04）

> 来源：Product Evolution Orchestrator 第 3 轮 vertical slice（NEXT P1，架构顶层地雷）。
> 依据：`.tmp/audit-architecture.md` 1.1（cli/index.ts:22 ↔ repl.ts:16 全 src 唯一直接双向环）。

## 目标

消除 `cli/index.ts ↔ cli/repl.ts` 的直接双向循环依赖，依赖方向收敛为一元：`index → repl → dispatch`（及 `index → dispatch`）。行为零变化。

## 用户场景

开发者视角无感（命令与 REPL 行为完全一致）；工程视角：消除「任何把 main/runRepl 提升到模块顶层就会变 undefined 引用」的地雷，让裸 `mik` 入口与 REPL 各自可独立测试、构建产物可 tree-shake。

## 当前问题（已核验）

- `packages/mik/src/cli/repl.ts:16` `import { main } from "./index.js"`（REPL 斜杠命令复用 main 分发）
- `packages/mik/src/cli/index.ts:22` `import { runRepl } from "./repl.js"`
- 构成直接双向环；ESM 当前靠「引用发生在调用期」侥幸成立。

## 理想行为（变更点）

1. 新建 `packages/mik/src/cli/dispatch.ts`，从 index.ts 迁出：
   - `dispatch(parsed, options)`：现有命令 switch（init/serve/dashboard/provider/models/pricing/usage + default 抛 CliUsageError）。
   - `runCommand(argv: readonly string[], options: RunOptions): Promise<number>`：`parseCliArgs(argv)` → version/help/无命令 TTY→REPL（**repl 从 index 的循环改从 dispatch 引？不行：runRepl 在 repl.ts**）——设计约束：dispatch 不得引入 repl；无命令分支留由 index.ts 处理。即 dispatch 只负责「有命令时的分发（含 version/help）」，无命令（裸 mik）分支仍由 index.ts 决定（TTY→runRepl / 非TTY→root help）。
2. `repl.ts`：把 `import { main } from "./index.js"` 改为 `import { runCommand } from "./dispatch.js"`；斜杠命令处理器调用 `runCommand(argv, options)`。
3. `index.ts`：自身 `main` 流程改为调用 `dispatch(parsed, options)`（不 import repl；裸 mik 分支调用 `runRepl`——index→repl 单向，OK）。移除 repl.ts:16 反向引用后环即断。
4. 保持导出面：index.ts 仍导出 `main`、`parseCliArgs` 等公共面（对外不破坏）。

## 涉及模块

- `packages/mik/src/cli/dispatch.ts`（新）
- `packages/mik/src/cli/index.ts`、`packages/mik/src/cli/repl.ts`
- 测试：`packages/mik/test/cli.test.ts`、`test/repl.test.ts`（既有用例即回归网）

## 不能破坏什么

- CLI/REPL 一切外部行为（--help/-v、子命令、裸 mik TTY→REPL 或非TTY→help、斜杠命令 /providers 等）。
- index.ts 的公共导出（main、helpFor、EXIT_*、parseCliArgs 等——仓库与 e2e/check-envs 依赖）。
- dispatch 内 switch 的默认分支 CliUsageError 行为。

## 验收标准

- A1：grep 确认 `repl.ts` 不再 `import { main } from "./index.js"`；`index.ts` 到 `repl.ts` 仅单向（index import repl 的 runRepl）。
- A2：`node packages/mik/dist/cli.mjs --help` 正常；`node packages/mik/dist/cli.mjs provider list`（空库）正常；REPL 斜杠 /providers、/help（经既有 repl 测试）正常。
- A3：`tsc --noEmit` 0 错误；全量 vitest 全绿；`node scripts/e2e/run.mjs` exit 0；`node scripts/check-envs.mjs` 三环境 PASS。
- A4：构建产物中 cli 模块图无 index↔repl 环（可用 grep 构建产物验证 repl 段不再出现 "from \"./index" 或等价物）。

## 错误场景

无新运行时错误场景（纯重构）；唯一风险是漏改导致模块顶层引用 undefined——A1 的 grep 断言 + 全量测试兜住。

## 测试要求

既有用例即回归网（cli.test.ts/repl.test.ts 不动或仅微调 import）；新增 1 个断言：repl.ts 源码不含 `from "./index.js"`（或改为 grep 型构建验证），证明环已断。不要新增无关功能。

## 范围外

G02（dashboard 子进程托管）、G08/G09/G10/G11/G12/G13/G14/G15/G16、任何行为变更。