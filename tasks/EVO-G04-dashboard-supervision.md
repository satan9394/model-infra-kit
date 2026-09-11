# EVO-G04 — `mik dashboard` 子进程生命周期托管（G02）

> 来源：Product Evolution Orchestrator 第 4 轮 vertical slice（NEXT P1，可靠性）。
> 依据：`.tmp/audit-reliability.md` P1-1（dashboard.ts 仅监听 error/exit，无信号转发、无 kill、无 exit 清理；对照 serve.ts 有 waitForShutdown）。证据已由 Orchestrator 核验。

## 目标

`mik dashboard` 退出/被强杀时**必然回收**它拉起的 Next.js 子进程（含子进程树），不残留孤儿进程、不占住 3210 端口。行为对正常使用路径零变化。

## 用户场景

开发者跑 `mik dashboard` → 想让出端口时按 Ctrl+C（或异常崩溃、被 `kill -9`/任务管理器结束）→ 再次 `mik dashboard` 不应报 `Port is already in use`；系统里不应残留看不见的 next-server 进程。

## 当前问题（已核验）

- `packages/mik/src/cli/commands/dashboard.ts:84-95`：`spawn(command, args, { cwd: dir, stdio: "inherit" })` 之后仅 `child.once("error")` / `child.once("exit")`；**无** SIGINT/SIGTERM 转发、**无** `child.kill()`、**无** `process.on("exit")` 清理钩子。
- 对照：`packages/mik/src/cli/commands/serve.ts:88-111` 有 `waitForShutdown` 信号处理（可借鉴形态）。
- 后果：父进程崩溃/被强杀时 Next.js 子进程存活，占用端口与资源；Windows 下 `pnpm` 还会再派生 `next` 孙进程，需按**进程树**终止。

## 理想行为（变更点）

1. 抽出可单测的托管器（新建 `packages/mik/src/cli/child-supervision.ts`）：
   - `superviseChild(child, options)`：注册一次性清理（幂等）；在收到 `SIGINT`/`SIGTERM` 时终止子进程树并释放监听；父进程 `exit` 时同步兜底 `kill`。
   - 终止策略：`process.platform === "win32"` 时用 `taskkill /pid <pid> /T /F`（杀进程树，`pnpm.cmd → next` 场景必需）；其它平台 `child.kill("SIGTERM")`，短暂宽限后 `SIGKILL` 兜底。
   - 幂等：重复信号/重复清理不得抛错；第二次 Ctrl+C 应仍能立即退出（不要吞掉用户的强制退出意图）。
2. `dashboard.ts` 接入该托管器：保留现有 `stdio: "inherit"`、cwd、`useLocalNext`/pnpm 分支与退出码语义；仅在生命周期管理上接入。
3. 不改变 `--port` 校验、端口预检、装包环境（非仓库）报错指引等既有行为。

## 涉及模块

- `packages/mik/src/cli/child-supervision.ts`（新）
- `packages/mik/src/cli/commands/dashboard.ts`（接入）
- `packages/mik/test/`（新增 child-supervision 单测；如 dashboard 有既有测试则同步）

## 不能破坏什么

- `mik dashboard` 正常启动/停止、端口占用提示、`next start` 与本地 next 两条分支、退出码传递。
- 既有 CLI/REPL/e2e/check-envs 全部用例（e2e 的 DASH 检查点自行 spawn `next start`，不受影响）。
- 其它命令（serve 的 waitForShutdown 不动）。

## 验收标准

- A1：`superviseChild` 单测——用假 child（EventEmitter + 记录 kill 调用）：收到 SIGINT → 调用终止（含 win32 分支走 `taskkill`，可由注入的 platform/exec 断言）；收到 SIGTERM 同；父 `exit` 事件 → 同步 kill 一次。
- A2：幂等——连续两次 SIGINT 不抛错，且第二次不阻塞退出。
- A3：真实冒烟（可选但推荐，≤2 分钟）：启动 `node packages/mik/dist/cli.mjs dashboard`（或其等价命令）后强杀父进程，确认端口 3210 释放 / 无 `next` 残留（Windows：`netstat -ano | findstr :3210` 为空）。
- A4：全量：`tsc --noEmit` 0 错误、`pnpm --filter model-infra-kit test` 全绿、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

- 子进程已退出后再收信号：清理应为 no-op，不抛错。
- `taskkill` 不存在/失败（非 Windows 或权限不足）：回退到 `child.kill()`，并只告警不崩溃。
- 父进程收到 SIGKILL（无法拦截）：文档化该限制（`exit` 钩子对 SIGKILL 无效），并在 README 相关小节写明「强杀后如端口占用，可用 `--port` 换端口或手动结束 next 进程」。

## 测试要求

- 至少 3 个单测：SIGINT 触发终止、SIGTERM 触发终止、exit 兜底 + 幂等。
- 不得用真实 Next.js 构建作为单测依赖（太重）；真实冒烟按 A3 可选执行并如实标注。
- 若为可测性需要注入 platform/exec/kill 依赖，保持默认参数与生产行为一致。

## 范围外

G08/G09/G10/G11/G12/G13/G14/G15/G16、serve 的信号处理重构、任何 UI/看板改动。