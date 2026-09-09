# F06 — `mik serve` 从构建产物起不来（T08 实测发现，指挥已复现）

**来源**：T08 交证风险 ①，指挥复现：
```
$ node packages/mik/dist/cli.mjs serve --port 3211
error: Could not load the HTTP server (mik/server).
Cannot find module '...\model-infra-kit\packages\server\index.ts' imported from ...\packages\mik\dist\cli.mjs
```
**拥有文件**：`src/cli/commands/serve.ts`、`src/cli/context.ts`（如需）、`test/cli.test.ts`

## 根因

`src/cli/commands/serve.ts` 的 `loadServerModule()` 候选路径是按**源码布局**（`src/cli/commands/`）写的：
`["../../server/index.js", "../server.mjs", "../../server/index.ts"]`

从 `dist/cli.mjs` 解析时：
- `../server.mjs` → `packages/mik/server.mjs`（越界）
- `../../server/index.js` → `packages/server/index.js`（越界）
- `../../server/index.ts` → `packages/server/index.ts`（就是报错里那个）

正确候选应同时覆盖两种布局，例如：
```
["./server.mjs", "../server.mjs", "../../server/index.js", "../../server/index.ts", "../server/index.ts"]
```
（按运行时 `import.meta.url` 所在目录判断，先试与 cli 同目录的 `server.mjs`，再退到源码布局。）

## 验收

1. **源码布局**：`node --experimental-strip-types src/cli/index.ts serve --port 3211` 能起（或用现有测试的调用方式）。
2. **构建产物**：`pnpm --filter model-infra-kit build` 后 `node dist/cli.mjs serve --port 3211` **必须成功**，输出里包含 `Listening on http://127.0.0.1:3211` 与 `OpenAI-compatible base URL: .../v1`；`curl http://127.0.0.1:3211/api/health` 返回 200。
3. 新增自动化测试：在 `test/cli.test.ts` 里断言 `loadServerModule()`（或等价的解析逻辑）在 **dist 布局**下也能解析到模块——不必真起服务，但要能捕获"路径越界"这类回归（例如用一个临时目录造出 `cli.mjs` + `server.mjs` 的布局，断言解析成功）。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/cli.test.ts` 全绿，测试数只增不减。
5. 跑完**停掉所有起的进程**，不留监听端口。

## 注意

- 不要改 `src/server/**`、`src/hub.ts`、`apps/dashboard/**`。
- 顺带检查 `src/cli/commands/dashboard.ts` 是否也有同类布局假设（它启动 `apps/dashboard`），有就一起修并说明。
