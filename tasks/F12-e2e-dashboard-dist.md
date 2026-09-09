# F12 — 阻断 B4 + 建议 S10：e2e 未覆盖看板，且有恒真断言

**来源**：`docs/reviews/R02-final-review.md` B4 / S10
**拥有文件**：`scripts/e2e/**`、`apps/dashboard/test/**`（新建）、`apps/dashboard/package.json`（仅加 test 脚本）

## 缺陷

1. **B4（阻断）**：SPEC §6 第 ③ 条「看板看到记录、成本拆解与价格来源」在 e2e 里**零覆盖**——`run.mjs` 全文无 `dashboard`/`3210` 字样，`apps/dashboard` 也没有任何测试文件；而 `README.md:232` 却写 e2e 覆盖「SPEC §6 全场景」。实际只覆盖 5/6 条。
2. **S10**：`run.mjs:267` 有恒真断言（三值全收）；e2e 跑的是 `src`（`loader.mjs:29-33`），**从不跑 `dist`**，所以 F06 那类「dist 布局才暴露的 bug」e2e 抓不到。

## 修法

1. **e2e 增加看板检查项**：起看板（3210，被占则用临时端口）→ 断言 `/`、`/logs`、`/pricing` 返回 200 且 HTML 里出现**真实数字**（来自前面步骤写入的用量与手动价），并能读到 `/api/mik/health`。跑完停掉。
2. **e2e 增加 dist 冒烟**：对 `packages/mik/dist` 跑一次「CLI `--help` + `serve` + `/api/health`」，确保发布产物可用（build 不存在时先 `pnpm --filter model-infra-kit build`）。
3. **删掉恒真断言**，改为断言具体值。
4. README 的 e2e 描述改为与实现一致（若 B4 修完确实覆盖 6/6，则可保留原表述并注明）。

## 验收（逐条真跑并贴输出）

1. `node scripts/e2e/run.mjs` 输出新增的看板检查项与 dist 冒烟项，全部 PASS，退出码 0。
2. 贴出看板 HTML 中命中的真实数字（例如成本、请求数）。
3. 故意让看板不可用（改错 `MIK_SERVER_URL`）→ 该项必须 FAIL 且整体退出码非 0（证明断言有效）。
4. 跑完 `netstat` 确认 3210/3211/3212 无监听残留。
5. 不改 `packages/mik/src/**`、`packages/mik/test/**`。

## 注意

- 另有 Worker 在改 `README.md`（F11）；你只改 `scripts/**` 与 `apps/dashboard/**`。README 的 e2e 描述由 F11 负责，你在交证里说明「README 需同步的句子」即可。
