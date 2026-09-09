# F15 — S4 只读库抛裸错误且被静默 + S14 迁移 INSERT 无 OR IGNORE

**来源**：`docs/reviews/R02-final-review.md` S4 / S14
**拥有文件**：`src/store/database.ts`、`src/store/schema.ts`、`src/store/usage-repository.ts`（如需）、`test/store.test.ts`

## 缺陷

1. **S4**：打开只读数据库时 `init()` 成功，首次写入抛裸 `ERR_SQLITE_ERROR`；经 `hub.ts` 的 `safely()` + 默认空 `onWarn` 被**静默吞掉**，宿主以为在记账其实没有。
2. **S14**：`schema.ts:136` 的 `INSERT INTO schema_migrations` 无 `OR IGNORE`（8 进程冷启动未复现，但属理论竞态）。

## 修法

1. `Store.open()`：对目标文件做**可写性探测**（例如 `PRAGMA quick_check` 后尝试一次无副作用的写事务，或用 `fs.accessSync(path, W_OK)`），失败时抛 `ModelInfraError`（code `STORAGE`，message 说明「数据库不可写」）。
2. 仓储写入的底层 SQLite 错误统一包装为 `ModelInfraError(code: "STORAGE")`（保留 `cause`），不再裸抛。
3. `schema_migrations` 的 INSERT 改 `INSERT OR IGNORE`。
4. **默认 `onWarn` 不再静默**：`ModelInfra` 的默认告警写一行到 `stderr`（经 `redact()`），前缀 `[model-infra-kit]`。这条在 `src/hub.ts`（F14 拥有）——**本卡不要改 hub.ts**，在交证里写明「需 F14/指挥在 hub.ts 落地默认 onWarn」。

## 验收（逐条真跑并贴输出）

1. 用 `chmod`/只读属性造一个只读 db 文件（Windows 用 `attrib +R` 或 ACL），`Store.open()` 抛 `ModelInfraError` code `STORAGE`（贴原文），不再是裸 `ERR_SQLITE_ERROR`。
2. 写入路径的 SQLite 错误被包装：构造一次写冲突/只读库写入，断言错误 `instanceof ModelInfraError` 且 `code === "STORAGE"`、`cause` 保留。
3. 迁移并发：连续两次 `migrate()` 同一库不抛（`OR IGNORE` 生效）。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/store.test.ts` 全绿，测试数只增不减。
5. 不改 `src/hub.ts`、`src/registry/**`。
