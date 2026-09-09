# F18 — S13 收尾：看板未用 devDep + `check-port.mjs` 的 `PORT=` 无效

**来源**：`docs/reviews/R02-final-review.md` S13
**拥有文件**：`apps/dashboard/package.json`、`apps/dashboard/scripts/check-port.mjs`

## 缺陷

1. `apps/dashboard/package.json` 里的 `model-infra-kit` devDependency **未被使用**（看板只走 HTTP，不 import 库）。
2. `apps/dashboard/scripts/check-port.mjs` 的错误提示写着 `PORT=`，但脚本只读 `process.argv[2]`，该环境变量无效。

## 修法

1. 确认 `model-infra-kit` 确实未被 import（grep `apps/dashboard` 下所有 `*.ts/tsx/mjs`），确认后从 devDependencies 移除；若有引用则保留并在交证里说明。
2. `check-port.mjs` 真正支持 `PORT` 环境变量（优先级：`argv[2]` > `PORT` > 默认 3210），并让提示文案与实际行为一致。

## 验收（逐条真跑并贴输出）

1. grep 证据：`apps/dashboard` 下无 `from "model-infra-kit"` / `require("model-infra-kit")`。
2. `PORT=3210 node apps/dashboard/scripts/check-port.mjs`（不起服务时端口空闲）→ 退出 0；占用 3210 后再跑 → 退出 1 且提示正确。
3. `pnpm --filter @mik/dashboard build` 仍成功（移除 devDep 后不破构建）。
4. `pnpm --filter @mik/dashboard test` 仍 7/7。
5. 跑完停掉所有进程，不留监听端口。
