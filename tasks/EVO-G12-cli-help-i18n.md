# EVO-G12 — CLI 入门面本地化：`--help` 横幅 / 用法 / 未知命令报错（G37 子集）

> 来源：Product Evolution Orchestrator 第 12 轮 vertical slice。
> 依据：**从已发布 0.2.6 产物的实测证据**（见 `docs/product-evolution.md` 的 R59 路线图调整）。

## 背景证据（发布产物实测，非源码推断）

在全新目录 `npm i model-infra-kit@0.2.6` 后实测：

- `MIK_LANG=zh` 与 `MIK_LANG=en` 下裸 `mik`（非 TTY）输出**完全相同且为英文**：`model-infra-kit (mik) 0.2.6` + `Embeddable model layer: multi-provider access, model catalog, token usage and cost tracking.`
- `MIK_LANG=zh` 下 `mik nonexistent-cmd` 仍为英文：`error: Unknown command "nonexistent-cmd". Run "mik --help" for the list of commands.` / `usage: mik --help`

**这是「承诺 vs 体验」不一致**：G02/G08 已把 CLI 宣称 zh/en 双语，但用户最常见的第一个命令 `mik --help` 仍是英文。

## 目标

让中文用户执行 `mik`、`mik --help`、`mik -v`、以及任何用法/未知命令错误时，看到的**框架级文案**随 `MIK_LANG → cli.lang → OS locale → en` 解析（与 REPL 同口径）。

## 用户场景

- 中文用户第一次 `npm i model-infra-kit` 后跑 `mik --help`：命令表与说明是中文，能直接找到 `provider add` / `usage summary` / `dashboard`。
- 打错命令时看到中文提示，而不是英文 `error: Unknown command`。
- 英文环境（或 `MIK_LANG=en`）体验与现在**逐字一致**（不得回归）。

## 当前问题（已核验）

- `packages/mik/src/cli/args.ts` 的 `--help` 横幅与用法行、`packages/mik/src/cli/dispatch.ts` 的错误前缀（`error:` / `usage:`）与未知命令文案，均为硬编码英文，**不走 i18n**。
- 注意：CLI 入口解析发生在**开 hub 之前**，拿不到 `cli.lang`；语言只能取 `MIK_LANG` + OS locale（与 `repl.ts` 非 TTY 分支、`init.ts` 早期守卫同口径，用 `resolveCliLang(env, undefined)`）。

## 理想行为（变更点）

1. **框架文案进字典**：在 `cli/i18n/{zh,en}.ts` 补键（两侧逐个对等），覆盖：横幅标题与描述、`usage:` 行、`error:` 前缀、未知命令、缺参数/未知选项等用法错误、`--help` 的命令表标题与各命令一行说明。
2. **命令表本地化**：`mik --help` 列出的每个命令说明走字典；**命令名、参数名、示例保持原样英文**（它们是可复制的字面量）。
3. **解析顺序一致**：一律 `resolveCliLang(process.env, undefined)`（`MIK_LANG → OS locale → en`）；不得为测试在解析层开注入后门（可在函数签名上接受 `env` 参数以便单测注入，与 `resolveCliLang` 现有风格一致）。
4. **en 零回归**：`MIK_LANG=en` 下的输出与改前**逐字节相同**（可用 `git stash` 前后对照验证）。

## 涉及模块

- `packages/mik/src/cli/args.ts`（帮助与用法）
- `packages/mik/src/cli/dispatch.ts` / `packages/mik/src/cli/index.ts`（错误前缀与未知命令）
- `packages/mik/src/cli/i18n/{zh,en}.ts`（补键）
- `packages/mik/test/cli.test.ts`（新增用例）

## 不能破坏什么

- `--help` 的**结构**（命令分组、顺序、缩进）与退出码；`-v`/`--version` 输出格式（`model-infra-kit (mik) <version>` 可保留英文品牌行，但描述行应本地化）。
- 既有 435 例测试全绿；`mik --help` 的既有断言（若有基于英文字符串的）按**预期翻转**同步，**不得放宽**。
- 别名/缩写语义（`-h`、`-v`、子命令解析）不变。
- 不引入新依赖。

## 验收标准

- A1 **中文可见**：`MIK_LANG=zh` 下 `mik --help` 输出含中文说明、不含英文 `Embeddable model layer`（可 grep 断言）；未知命令错误为中文。
- A2 **en 逐字不变**：`MIK_LANG=en` 下 `mik --help` 与改前逐字节一致（提供对照证据）。
- A3 **键对等**：zh/en 新增键逐个对等（既有 parity 深等测试自动覆盖，请确认其覆盖到新键）。
- A4 **测试注入**：新用例一律注入 `MIK_LANG`（或注入 `env` 参数），**不得读运行环境 locale**（铁律 G26）。
- A5 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **435**）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS，push 后 **CI 三 OS 绿**。

## 错误场景

- 未知子命令 / 缺必需参数 / 未知选项（`--nope`）三类错误都要本地化，且**退出码语义不变**（用法错为 2 或既有值，不得改）。
- 无 `MIK_LANG`、无 locale 线索 → `en`（与既有口径一致）。
- `mik dashboard` 等子命令的既有输出**不在本卡范围**（属 G37 其余部分，留 LATER）。

## 测试要求

- ≥4 新用例：`MIK_LANG=zh` 的 `--help` 中文；`MIK_LANG=en` 的 `--help` 与基线一致；未知命令中文错误 + 退出码；缺参数中文错误 + 退出码。
- 不得为测试放宽生产默认或读真实 locale。

## 范围外

G37 的其余部分（各子命令输出文案：`usage`/`models`/`pricing`/`serve`/`provider`/`dashboard`）、G10b、看板 i18n 全面化、新功能。