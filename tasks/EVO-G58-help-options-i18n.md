# EVO-G58 — 子命令 `--help` 的选项说明本地化（补齐 G14 的过度宣称）

> 暂存于 `.tmp/`，待 G15 关闭后转正为 `tasks/EVO-G58-help-options-i18n.md`。
> 证据：`.tmp/g58-evidence-R122.md`（R122 在**已发布 0.2.10** 上实测）

## 目标

`MIK_LANG=zh` 下，各子命令 `--help` 的**选项说明文本**为中文；`MIK_LANG=en` 下与改前**逐字一致**。

## 用户场景

中文用户忘了 `--api-key-ref` 的取值格式（`env:VAR` / `file:path` / `keychain`）或 `--cache-dir` 的默认位置，于是 `mik provider add --help`——**看到的却是英文说明**。而「选项说明」正是理解成本最高的部分。

## 当前问题（R122 实测原文）

```
选项
      --provider <presetId>  First provider preset to register
      --file <path>          Config file to write (default ./mik.config.json)
      --force                Overwrite an existing config file
  -y, --yes                  Do not ask for confirmation

全局选项
      --db <path>         SQLite database file (default ~/.model-infra-kit/usage.db)
      --app-id <id>       Owning application id (default: default)
      --config <path>     CLI config file (default ./mik.config.json)
      --cache-dir <path>  Pricing catalogue cache directory
```

**特征**：**区块标题已中文化**（`选项`/`全局选项`），**标题下每一条说明都是英文**。
**覆盖范围**：8 个子命令、**73 行**选项说明（`init` 11 / `provider` 7 / `provider add` 12 / `models` 9 / `pricing` 7 / `usage` 7 / `serve` 11 / `dashboard` 9）。

**这条为何现在才被发现**：G14 我宣称「CLI 双语已收口」，而 G14 的验收探针把子命令帮助标成 `OUT-OF-SCOPE (pre-existing G12 boundary, not this card)`，**我接受了那个标签而未独立判断**（已记入 `AGENTS.md` 铁律：**验收工具的范围标签不是证据**）。

## 理想行为

1. 选项描述（`COMMANDS` 里每个 option 的 `description`）纳入 zh/en 字典，与已本地化的正文**同一机制**。
2. **数据部分不译**：flag 名（`--db`/`-y, --yes`）、占位符（`<path>`/`<presetId>`）、默认值路径（`./mik.config.json`、`~/.model-infra-kit/usage.db`）、取值示例（`env:VAR`、`file:path`、`keychain:service`）**保持原文**。
3. 各命令的**结尾说明段**（如 `provider add --help` 的「Secrets are referenced, never stored…」三行）同样纳入。
4. **`--help` 的既有版式不变**：选项列对齐、区块顺序、退出码 0。

## 涉及模块

`packages/mik/src/cli/args.ts`（`COMMANDS` 的选项描述）、`packages/mik/src/cli/help.ts`、`packages/mik/src/cli/i18n/{zh,en}.ts`、`packages/mik/test/cli.test.ts`、`packages/mik/test/fixtures/*-en.txt`（若有英文冻结面需同步）

## 不能破坏什么

- **`MIK_LANG=en` 下逐字不变**——这是硬要求。`cli-english-surface.test.ts` 的 5 个 fixture 必须保持 5/5 绿；`help-en.txt` 若因**有意**改动而变化，须在报告里逐行说明。
- 选项**数量、顺序、对齐**不变；`--help` 退出码仍为 0。
- 既有 472 例测试全绿（G15 后可能 >472，以当时基线为准）。
- **不改命令的行为**，只改说明文本。

## 验收标准

- **A1**：`MIK_LANG=zh` 下，8 个子命令 `--help` 的**说明文本无英文散文残留**。判定口径（避免 R122 的粗糙度量）：**排除 flag 名、占位符与默认值路径后**，仍含 ≥3 连续字母英文单词的行数应为 **0**。
- **A2**：`MIK_LANG=en` 下与**改前基线逐字一致**（用同一调用方式对照；基线取自已发布产物）。
- **A3**：字典 zh/en **键对等**（两侧逐个对应，无单边键/空值）。
- **A4**：数据部分未译——断言 `--db <path>`、`env:VAR`、`~/.model-infra-kit/usage.db`、`-y, --yes` 等**仍原样存在**。
- **A5**：`tsc --noEmit` 0；全量测试在 **zh-CN 与 en-US 两种 locale** 下均全绿；`e2e` exit 0；`check-envs` 三环境 PASS；CI 三 OS 绿。

## 错误场景

- 未知选项/缺选项值等**错误路径**的文案本已本地化（G12），本卡不应改动其行为——但需确认**没有**因这次改动而回归（冻结面 5/5 即为守门）。

## 测试要求

- ≥6 新用例，全部注入 `MIK_LANG`：
  1. `init --help`（zh）说明为中文
  2. `provider add --help`（zh）说明为中文
  3. `serve --help`（zh）说明为中文
  4. 数据未译（断言 `env:VAR` / `<path>` / `-y, --yes` 原样）
  5. 一条 en 对照（说明仍为英文原样）
  6. 一条「说明文本无英文散文」的**扫描式**断言（覆盖全部 8 个命令，而非只测 3 个——**样本集要闭合**，G12 教训）
- **G43 自检**：每条断言在改前必须能红（本卡尤其容易写成恒真——例如只断言「输出含中文」在 `选项` 标题已中文化时**本来就是真**）。

## 范围外

`@ai-sdk/*` 依赖声明、`set-default` 命令、看板随包发布、`ExperimentalWarning` 抑制（G61）、`provider test` 重复文案（G60）、README 文档入口（G63）。
