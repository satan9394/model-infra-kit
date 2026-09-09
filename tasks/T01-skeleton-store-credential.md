# T01 — 骨架 / 存储 / 凭据 ✅ 已完成

**状态**：done（2026-09-09，指挥本人执行）
**验收**：`tsc --noEmit` 0 错误；`vitest run` 16/16 通过。

## 交付

- workspace：`package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `.gitignore`
- 主包：`packages/mik/package.json`（子路径导出 `.` / `./server` / `./cli`，bin `mik`）、`tsdown.config.ts`、`vitest.config.ts`
- `src/types.ts`、`src/errors.ts`、`src/util/{paths,redact}.ts`
- `src/store/{driver,schema,database,provider-repository,model-repository,pricing-repository,usage-repository,money}.ts`
- `src/credential/store.ts`
- 测试：`test/store.test.ts`（9）、`test/credential.test.ts`（7）

## 踩坑（已修正，勿重犯）

1. `node:sqlite` 必须**动态 import**（ESM 下没有 `require`）。
2. `groupBy` 里 events 表列名是 `model_actual`，rollup 表是 `model` —— 两套列名要分别传，别共用表达式。
3. `CredentialStore.list()` 依赖 `driver` 才读得到 `credentials` 表，构造时要传。
4. `tsconfig` 不要设 `rootDir: src`，否则 `test/**` 会报 TS6059。
