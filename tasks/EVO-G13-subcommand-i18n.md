# EVO-G13 — 子命令输出本地化（G37 余项 · 第一批：`provider` + `usage`）

> 来源：Product Evolution Orchestrator 第 13 轮 vertical slice。
> 依据：G12 之后的**实测残留分布**（编排者用 `io.out/err` 裸英文字面量计数得到），以及「双语承诺 vs 实际体验」这一缺口类别。

## 背景（来自实测，非估计）

G12 已让**入门面**（`--help` 横幅/用法/未知命令/用法错误）双语。但**子命令自身的输出**仍是英文，实测残留分布：

| 文件 | 裸英文 `io.out/err` 处数 |
|---|---|
| `cli/commands/provider.ts` | **7** |
| `cli/commands/models.ts` | 5 |
| `cli/commands/serve.ts` | 5 |
| `cli/commands/usage.ts` | **5** |
| `cli/commands/pricing.ts` | 4 |
| `cli/context.ts` | 3 |
| `cli/commands/dashboard.ts` | 1 |

**本卡只做前两个最高频面**：`provider`（7）+ `usage`（5）= 12 处。理由：README 首推的日常命令正是 `mik provider add` 与 `mik usage summary`（G09 还把这三条 `usage` 命令前置到接入小节）；`models`/`serve`/`pricing`/`dashboard` 留作下一批，避免一次改动面过大。

## 目标

让 `mik provider …` 与 `mik usage …` 的**用户可见输出**（列表表头、成功/失败提示、空态、汇总标签）随 `MIK_LANG → cli.lang → OS locale → en` 解析——与 G12 的入门面同口径。

## 用户场景

- 中文用户跑 `mik provider list`：表头与状态提示是中文，**provider id / 协议名 / 模型 id / 时间戳仍是原文字面量**（可复制、可粘贴回命令）。
- 中文用户跑 `mik usage summary`：汇总标签（请求数、token、成本）是中文，**数字格式与单位不变**。
- 英文环境（或 `MIK_LANG=en`）输出与改前**逐字节相同**。

## 当前问题（已核验）

- `cli/commands/provider.ts` 的 `add/list/remove/test` 输出（7 处）与 `cli/commands/usage.ts` 的 `summary/logs/export/trends` 输出（5 处）为硬编码英文。
- 这两个命令**在 hub 打开之后**执行，因此**可以**取到 `cli.lang`（与 G12 的入门面不同——那里只能取 `MIK_LANG` + OS locale）。请用**既有**的语言解析路径（REPL/init 已在用），不要另造一套。

## 理想行为（变更点）

1. **补字典键**：`cli/i18n/{zh,en}.ts` 两侧各补同名键（逐个对等），覆盖这 12 处的说明性文案；**表头/标签**用字典，**数据值**（id、协议、模型、金额、时间戳、计数）保持原样。
2. **接线**：`provider.ts` 与 `usage.ts` 的输出改走 `tr(lang, …)`；语言从既有解析路径取得（hub 打开后可用 `cli.lang`）。
3. **en 零回归**：`MIK_LANG=en` 下输出与改前**逐字节相同**。请沿用 G12 的做法：**先固化改前基线**（从当前 `HEAD` 构建后跑若干条命令存到 `.tmp/baseline-g13-*.txt`），改完 `Compare-Object` 逐字对照；并**自证对照非恒真**（人为加一行应报差异）。
4. **zh 可见**：`MIK_LANG=zh` 下这两族命令的输出**无英文说明性文案残留**（数据值除外）。

## 涉及模块

- `packages/mik/src/cli/i18n/{zh,en}.ts`（补键）
- `packages/mik/src/cli/commands/provider.ts`、`packages/mik/src/cli/commands/usage.ts`
- `packages/mik/test/cli.test.ts`（新增用例）

## 不能破坏什么

- **表结构与列顺序**（`formatTable` 的列名可本地化，但列数/顺序/对齐不变）；**退出码**语义（成功 0、用法错 2、运行时错既有值）。
- `--json` 等**面向脚本**的输出：**不得**因本地化改变字段名或结构（只改人类可读的行）。
- 既有 451 例测试全绿（含 G12 新增的 4 例与 `run()` 助手的 `MIK_LANG=en` 默认）。
- 不引入新依赖。

## 验收标准

- A1 **zh 可见**：`MIK_LANG=zh` 下 `provider list` / `usage summary` 的说明性文案为中文（框架词黑名单检测应无残留），**数据值仍为原文**。
- A2 **en 零回归**：`MIK_LANG=en` 下这两族命令输出与**改前基线逐字节一致**（提供对照证据与「对照非恒真」自证）。
- A3 **结构化输出不变**：`--json`（若适用）字段与结构未变；表格列数与顺序未变。
- A4 **键对等**：zh/en 新增键逐个对等（既有 parity 测试覆盖）。
- A5 **测试注入**：新用例一律注入 `MIK_LANG`（G26：不得读运行环境 locale）。
- A6 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **451**）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS、push 后 **CI 三 OS 绿**。

## 错误场景

- provider 不存在 / 凭据缺失 / 网络失败：这些**错误文案**同样要本地化，且 `redact()` 仍必须生效（铁律 4）。
- `usage` 在空库下的空态文案要本地化（既有空态语义不变）。
- 若某处文案含**动态拼接**（如 `` `Added ${id}` ``），保持占位符顺序与可读性，勿改数据部分。

## 测试要求

- ≥6 新用例：`provider list` 与 `usage summary` 在 zh 下的表头/标签；同样两个命令在 en 下与基线一致；至少 1 个错误路径（如 `provider test <unknown>`）在 zh 下为中文；1 个空态在 zh 下为中文。
- 不得为测试放宽生产默认；不得新增读真实 locale 的断言。

## 范围外

`models` / `serve` / `pricing` / `dashboard` 的输出本地化（下一批）、看板 i18n 全面化、G10b、任何新功能。