# F11 — 阻断 B3 + 建议 S11/S13：README 与发布物不实

**来源**：`docs/reviews/R02-final-review.md` B3 / S11 / S13
**拥有文件**：`README.md`、`packages/mik/README.md`、`packages/mik/package.json`、`src/cli/commands/dashboard.ts`、`test/cli.test.ts`

## 缺陷

1. **B3（阻断）**：`README.md:188/204` 承诺 `npx mik dashboard`，但 `packages/mik/package.json` 的 `files: ["dist"]` 不含看板；`npm pack` 只有 11 个文件。实测装包后 `node .../dist/cli.mjs dashboard` → `Could not find the dashboard app (apps/dashboard)`，exit 1（`dashboard.ts` 靠 `walkUpFor` 找 monorepo 目录，只在仓库内有效）。
2. **S11**：README 数字漂移——测试数写 239（实际 248）、产物 298kB（实际 302.54kB）、`serve` 输出写「两行」（实际三行含 `Press Ctrl+C to stop.`）。
3. **S13**：`dist/cli.mjs` 无 shebang（`bin` 在 POSIX 不可执行）；tarball 无 LICENSE；`engines` `>=22` 偏宽（实际用了 Node 22+ 的 `node:sqlite`，需确认 22.x 最低版本）；`apps/dashboard` 的 `model-infra-kit` devDependency 未使用；`check-port.mjs` 提示 `PORT=` 但脚本不读该变量。

## 修法

1. **README 如实描述**：`mik dashboard` 目前**仅在 monorepo 内可用**；发布包用户请用 `pnpm --filter @mik/dashboard dev` 或自行部署看板。或者：给 `dashboard.ts` 一个明确错误信息（含「看板未随包发布，见 README」）。**两处都要做**（文档 + 错误文案）。
2. 修正 README 里所有会漂移的数字：测试数、产物大小、输出行数——改为「约」或去掉具体数字，避免下次再漂。
3. 发布物：加 shebang（`#!/usr/bin/env node`）、加 LICENSE 文件、核对 `engines`、移除未用 devDep、让 `check-port.mjs` 真正读 `PORT`。
4. 补测试：`mik dashboard` 在找不到看板时给出**含指引的**错误（断言 message 含 `README` 或安装指引）。

## 验收（逐条真跑并贴输出）

1. `npm pack --dry-run` 或 `pnpm pack` 列出 tarball 内容；断言含 `LICENSE`、`dist/cli.mjs` 首行为 shebang。
2. 临时目录安装 tarball → `node_modules/.bin/mik --help` 可用；`mik dashboard` 报出**可读指引**（贴原文）。
3. README 中每条命令重跑一遍，逐条确认与文档一致；不再出现未验证的具体数字。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/cli.test.ts` 全绿。
5. 跑完停掉所有进程，不留监听端口。

## 注意

- 不要改 `src/hub.ts`（F10）、`src/errors.ts`（F09）、`scripts/**`（F12）。
