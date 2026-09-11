# EVO-G02 — REPL/向导体验 + i18n 契约集群（G07+G03+G05+G06）

> 来源：Product Evolution Orchestrator 第 2 轮 vertical slice（NEXT P1 集群，同层耦合的小问题一次做完）。
> 依据：`.tmp/audit-ux.md`（问题 1/2/3/4/11）、`.tmp/audit-architecture.md`（2.1/2.2/5.2/5.3）。证据均已由 Orchestrator 核验（i18n.ts 缺 repl.prompt 键、init.ts:52/57、README:318）。

## 目标

把「mik 的交互面与 i18n 契约」补齐到自洽：① REPL 提示符不再泄露调试键名；② 裸 `/lang` 不再与主 readline 抢 stdin；③ `init` 向导的语言解析遵循契约（MIK_LANG → cli.lang → zh）且提问文案跟随所选语言；④ 文档与实机事实一致（版本/发布状态/--cors/端点存在性/升级路径）。

## 用户场景

新用户 `mik` 进 REPL：第一屏提示符是 `mik>` 而不是 `repl.prompt`；输入裸 `/lang` 不会卡输入；已设 `en` 的用户再跑 `mik init` 向导不会又被弹回中文、提问也是英文；读 README 判断「能否 npm 装 / serve 有没有 --cors / 升级怎么做」时得到与实机一致的答案。

## 当前问题（已核验）

1. **G07**：`i18n.ts` DICT 无 `repl.prompt` 键 → REPL 提示符显示字面量 `repl.prompt`（tr() 缺键原样返回）。
2. **G03**：`repl.ts:87` 裸 `/lang` 调 `prompt()`（prompt.ts 对 stdin 新建 readline），与主循环 rl 抢输入。
3. **G05**：`init.ts:52` 语言解析只认 `MIK_LANG`（跳过 `cli.lang` 设置，契约 interfaces.md:353 为 MIK_LANG→cli.lang→zh）；`init.ts:57` 首问硬编码 `tr("zh",…)`；`init.ts:60-62` 三个字段提问硬编码英文；`repl.ts storedLang` 与 `i18n.resolveLang` 逻辑重复。
4. **G06**：README:318 显示 `0.1.1`（实机 0.1.7）；agent-cli-guide.md:248 断言「尚未发布到 npm」与 README 矛盾；integration-playbook.md 的 `--cors` 与 `/api/usage/events` 存在性前后矛盾；README 无升级小节。

## 理想行为（变更点）

1. **G07（一行）**：`i18n.ts` DICT 补 `"repl.prompt": { zh: "mik>", en: "mik>" }`。
2. **G03**：`handleLine` 增加可注入的 `ask?: (question: string) => Promise<string>` 参数；`/lang` 无参分支优先用 `ask`（runRepl 注入基于自己 rl 的实现），缺省回退 `prompt()`（保持 headless 测试可用）；runRepl 不再在同 stdin 上创建第二个接口。补测试：注入 ask 后裸 `/lang` 返回所选语言并输出确认，且不要求真实 TTY。
3. **G05**：
   - `init.ts` 语言解析改为 `resolveLang(env.MIK_LANG, hub.readSetting("cli.lang"))`（在 withContext 内或开库后取值；非交互时先读 setting 再解析）。
   - `init.ts:57` 首问改用解析后语言的文案（`tr(lang,"wizard.lang")`）。
   - `init.ts:60-62` 三个字段提问补 i18n 键（如 `wizard.appId` / `wizard.db` / `wizard.provider`，中英文案含默认值占位 %s），按 `lang` 输出。
   - 收敛重复：`repl.ts` 的 `storedLang` 删除，统一用 `i18n.resolveLang`（repl 侧改为 `resolveLang(env.MIK_LANG, stored)`）。
   - 非法语言输入：打印 `wizard.langInvalid`（i18n 已有键）并重选（循环一次），不再静默。
4. **G06（纯文档）**：
   - README 帮助样例版本号改为动态说明或更新为当前版本（至少不再出现过时号）。
   - agent-cli-guide.md 删除/修正「尚未发布到 npm」段。
   - integration-playbook.md 统一 `--cors` 与 `/api/usage/events` 表述。
   - 根 README（常用命令或常见问题）补一行升级命令（`npm update model-infra-kit` / `npx model-infra-kit@latest`）+ node ≥22.13 提醒。

## 涉及模块

- `packages/mik/src/cli/i18n.ts`（补键 + 校验钩子已有 i18nKeys）
- `packages/mik/src/cli/repl.ts`（ask 注入、storedLang 收敛）
- `packages/mik/src/cli/commands/init.ts`（resolveLang、文案键、非法输入处理）
- `packages/mik/test/{i18n,repl,cli}.test.ts`（新增/修正断言）
- `README.md`、`docs/agent-cli-guide.md`、`docs/integration-playbook.md`

## 不能破坏什么

- REPL 既有斜杠命令行为（/help、/chat、/exit、自由文本聊天）与 EOF 处理；`handleLine` 的既有签名调用方（runRepl + 现有测试）。
- init 的非交互路径（--yes/--app-id/--provider/--file 全部照旧，产出的 config 结构不变）；既有 cli.test.ts init 用例。
- i18n 现有键与 `tr/trBoth/resolveLang/parseLangChoice` 语义；`i18nKeys()` parity 测试。
- README 的交叉 shell 写法、密钥引用等已校对内容不要动。

## 验收标准

- A1：`tr("zh","repl.prompt") === "mik>"` 且 `tr("en","repl.prompt") === "mik>"`（i18n 测试）。
- A2：`handleLine` 注入 ask 后，裸 `/lang`（无参）返回所选语言、输出确认文案，且全程不触发 `prompt()`（可断言 ask 被调用）。
- A3：`init` 在 `MIK_LANG=en` 且存有 `cli.lang=zh` 时解析为 `en`；向导（交互）选 1 后三个字段提问为中文文案；选 2 为英文。
- A4：`mik init` 非法语言输入时输出 `wizard.langInvalid` 并重选，不再静默。
- A5：README/agent-cli-guide/playbook 无 `0.1.1`、无「尚未发布到 npm」、`--cors` 与 `/api/usage/events` 表述一致；README 含升级命令。
- 全量：`tsc --noEmit` 0 错误、`pnpm --filter model-infra-kit test` 全绿、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

裸 `/lang` 在无 TTY/管道下的行为保持既有（notty 拒绝）；`/lang garbage` 输出 `repl.langInvalid`；非法 init 语言输入重选一旦仍非法则取默认并提示——不崩溃、不静默覆盖已有设置。

## 测试要求

- i18n.test.ts：`repl.prompt` 与新增 `wizard.appId/db/provider` 键的 zh/en 对等性自动纳入（i18nKeys 已覆盖 parity，新增键即可）。
- repl.test.ts：ask 注入的 `/lang` 用例。
- cli.test.ts（init）：非交互 `MIK_LANG=en` + settings 预置 `cli.lang=zh` → 断言写入 `cli.lang=en`；断言 config 结构不变。
- 文档一致性用 grep 型断言或人工核验（测试内可用 expect(fs.readFileSync(...)).not.toContain("0.1.1") 等简单断言，或说明人工核验项）。

## 范围外（明确不做）

G02（dashboard 子进程托管）、G04（cli↔repl 循环依赖重构）、G08/G09/G10/G11/G12/G13/G14、看板 i18n 全面化、语言自动检测（OS locale）——全部留待后续 slice。