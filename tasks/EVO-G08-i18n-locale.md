# EVO-G08 — i18n 架构收敛 + 系统语言检测（G09）

> 来源：Product Evolution Orchestrator 第 8 轮 vertical slice（LATER 集群）。
> 依据：`.tmp/audit-architecture.md` 2.3（新增语言 = 单字典全量编辑 + 无语言检测）、2.1（三入口策略分裂）、`.tmp/audit-ux.md` 问题 6（看板零 i18n 未声明边界）。

## 目标

① 把 i18n 从「单文件扁平字典」收敛为**按语言分文件**，并用**键集合对等测试**防漂移，使新增语言的成本从「改一处大字典 + 忘键风险」变成「加一个文件 + 跑对等测试」；② 默认语言改为**按系统语言检测**（而非硬编码 `zh`），顺序明确为 `MIK_LANG` → `cli.lang` → OS locale → 兜底；③ 把「看板当前仅中文」的边界写进 README，消除多入口预期差。

## 用户场景

- 非中文开发者首次 `mik init` / `mik`：不再被迫接受中文界面——系统 locale 是 `en_*` 时自动英文（仍可用 `MIK_LANG`/`/lang` 覆盖并持久化）。
- 贡献者想加一门语言：新建一个语言文件 + 跑对等测试即可，不必在长字典里逐键摸索（漏键会被测试立刻抓住）。
- 读 README 的人知道：CLI/REPL 双语，看板当前仅中文（不做暗含承诺）。

## 当前问题（已核验）

- `packages/mik/src/cli/i18n.ts`：`DICT` 是单个扁平 `Record<string, { zh; en }>`（键与两种语言写在一行），新增语言要改动整张表；`LANGS`/`LANG_LABELS`/`isLang` 手工维护。
- 无任何 OS locale 读取（全仓 grep 无 `LANG`/`LC_*`/`Intl`）；默认语言在 `init.ts:52`、`repl.ts:165` 等处硬编码为 `"zh"`。
- 看板（`apps/dashboard`）零 i18n 且 README 未声明该边界（UX 审计问题 6）。

## 理想行为（变更点）

1. **按语言分文件**（保持现有公开 API 不变）：
   - 新建 `packages/mik/src/cli/i18n/zh.ts`、`.../en.ts`（各导出一个扁平 `Record<string, string>`），`cli/i18n.ts` 保留 `tr`/`trBoth`/`resolveLang`/`parseLangChoice`/`isLang`/`LANG_LABELS`/`LANGS`/`i18nKeys` 等**既有导出**（catalog 从两个文件合成）。
   - 新增 `dictFor(lang)` 保留（现有死代码评估见技术债 G? — 若仍无调用方则**删除**并在报告中说明，避免继续留死代码）。
2. **语言检测**：`resolveLang(envValue, storedValue, options?)` 语义扩展为 `MIK_LANG → cli.lang → OS locale → "en"`：
   - OS locale 读取顺序：`LC_ALL` → `LC_MESSAGES` → `LANG` → （Windows）`Intl.DateTimeFormat().resolvedOptions().locale`；`zh*` → `zh`，其余（含无法判定）→ `en`。
   - 兜底从 `zh` 改为 `en`（国际化默认），**但**：显式 `MIK_LANG=zh` 或已存 `cli.lang=zh` 时行为必须完全不变。
   - 可注入 locale 以便测试（不得在测试里依赖真实环境变量）。
3. **接线**：`init.ts`、`repl.ts` 的默认语言解析统一走 `resolveLang`（移除硬编码 `"zh"`）；`repl.notty` 等固定用 zh 的错误文案改为按解析结果输出。
4. **README 边界声明**：明确「CLI/REPL 支持 zh/en 且可切换；看板当前仅中文（未接入 i18n）」。
5. **契约同步**：`docs/interfaces.md` 的「小设置持久化」与「配置真相」两节更新语言解析顺序（`MIK_LANG → cli.lang → OS locale → en`）。

## 涉及模块

- `packages/mik/src/cli/i18n.ts`（拆分 + 检测 + 保留公开面）
- `packages/mik/src/cli/i18n/{zh,en}.ts`（新）
- `packages/mik/src/cli/commands/init.ts`、`packages/mik/src/cli/repl.ts`（默认语言改走 `resolveLang`）
- `packages/mik/test/i18n.test.ts`（键对等 + 检测用例）
- `README.md`、`docs/interfaces.md`

## 不能破坏什么

- 现有 `tr/trBoth/resolveLang/parseLangChoice/isLang/i18nKeys/LANG_LABELS/LANGS` 的**导出名与语义**（除 `resolveLang` 新增第三参数与兜底语言变化外）；`i18n.test.ts` 既有 parity 用例。
- 显式设置语言的一切路径（`MIK_LANG`、`cli.lang`、`/lang`、向导选择）行为不变。
- REPL/向导既有的全部用例（含 vi.mock(prompt.js) 的无头交互用例）。
- 不引入新依赖（纯 Node 内置）。

## 验收标准

- A1 **键对等**：`zh` 与 `en` 键集合完全一致；测试在任一语言多键/缺键时失败（可临时验证：删一个键应红）。
- A2 **检测顺序**：`MIK_LANG` > `cli.lang` > OS locale > `en`；用例覆盖：env 覆盖 stored、stored 覆盖 locale、`LANG=zh_CN.UTF-8` → `zh`、`LANG=en_US.UTF-8` → `en`、无任何线索 → `en`。
- A3 **接线一致**：`init.ts`/`repl.ts` 无硬编码默认 `"zh"`（grep 断言）；显式 `MIK_LANG=zh` 时向导与 REPL 仍为中文。
- A4 **公开面不变**：`i18n.ts` 既有导出名齐全（grep 断言）；`tr`/`trBoth` 行为不变（既有 22+ 用例全过）。
- A5 **文档边界**：README 含「看板当前仅中文」的明确表述；`interfaces.md` 两处语言顺序已更新（README 与契约一致）。
- A6 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **390** 例起）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

- locale 值畸形（`LANG=C`、`LANG=POSIX`、空串）→ 落到 `en`，不得抛错。
- `MIK_LANG=xx`（不支持）→ 视为未设置，继续按 stored → locale → en 解析（**不得**因此变成 zh 或崩溃）。
- 拆分后若某语言文件缺键：`tr` 必须回退到 `en`（而不是回显 key）——回显 key 会让用户看到调试键名（G07 曾踩过同类坑）。

## 测试要求

- ≥8 个新用例：A1 对等（含「缺键必红」的自证方式）、A2 五条顺序/映射、缺键回退到 `en`、`tr` 行为不变。
- 检测用例必须**注入** locale/env（不依赖运行环境），且不得污染其它用例（用后还原）。
- 不得为测试放宽生产默认。

## 范围外

看板 i18n 全面化（只在 README 声明边界）、G10（协议运行时注册）、任何计量/计价/安全口径变更。