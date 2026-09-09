# F08 — 后台目录同步污染 CLI 输出 / 与 close() 竞态（T10 实测，指挥已复现）

**来源**：T10 交证风险 ①
**拥有文件**：`src/hub.ts`、`src/cli/context.ts`、`test/hub.test.ts`、`test/cli.test.ts`

## 复现（指挥实跑）

```
$ node packages/mik/dist/cli.mjs provider add local --base-url http://127.0.0.1:9/v1 --api-key-ref env:FAKE_KEY
Added provider "local".

$ node packages/mik/dist/cli.mjs provider list
warning: Could not discover models for provider "local": Environment variable FAKE_KEY is not set for this provider's API key.
PROVIDER  NAME   ...
```
每一条非 `--offline` 的子命令都会多打一行；T10 在另一种时序下还观察到
`warning: Could not sync models for provider "<id>". (database is not open)`。

## 根因

- `src/hub.ts` 构造时启动 `catalogSync` 但从不 await（fire-and-forget）。
- `src/cli/context.ts` 的 `withContext` 在 `finally` 里 `hub.close()` → 后台同步随后撞上已关闭的驱动（"database is not open"）。
- 后台同步对「provider 没配密钥」这类**预期失败**也 `onWarn`，于是刷进用户可见的 CLI 输出。

## 修法

1. **`close()` 必须先收尾**：`close()` 等待在途的 `catalogSync`（给一个上限，例如 5s；超时也继续关，但不再抛/不再打竞态警告）再关 store。
2. **CLI 不该在只读命令上触发网络同步**：`src/cli/context.ts` 对不需要联网的子命令（`provider list/remove`、`models`（不带 `--refresh`）、`pricing list`、`usage *`、`init`）以 `syncCatalog: false` 建 hub；`serve`/`dashboard`/显式 `--refresh`/`pricing sync` 保持开启。
3. **背景同步的预期失败不告警**：缺凭据（`CREDENTIAL`）与 provider 被禁用属于预期，跳过且不 `onWarn`；真正的网络/协议失败仍告警。
4. 保留 `syncCatalog` 配置项语义；嵌入式宿主仍默认开启（不改变 `ModelInfra.init()` 的行为契约）。

## 验收（逐条真跑并贴输出）

1. 复现步骤重跑：`provider add` 后连续三次 `provider list`，**输出中不得再出现任何 `warning:`**。
2. `hub.close()` 后不再出现 `database is not open` 类错误（用带 provider 的 hub 连开关 3 次验证）。
3. 嵌入式路径不回归：`ModelInfra.init()`（默认 `syncCatalog: true`）仍会同步目录，`catalogSync` 仍可 await。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/hub.test.ts test/cli.test.ts` 全绿，测试数只增不减。
5. 不要改 `src/server/**`、`src/pricing/**`、`apps/dashboard/**`、`examples/**`、`scripts/**`、`README.md`。
6. 跑完停掉所有进程，不留监听端口。

## 交证

按 `AGENTS.md` 格式，贴出「修复前有 warning / 修复后无 warning」的原始输出对比。
