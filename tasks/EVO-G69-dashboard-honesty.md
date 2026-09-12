# EVO-G69 — 看板命令的诚实性与本地化（G57 + G68）

> 暂存于 `.tmp/`，待 G58 关闭后转正。**证据**：`.tmp/g68-dead-i18n-keys-R129.md`（G68 实测）+ R129 产物复现（G57）。

## 目标

`mik dashboard` 在 npm 安装场景下的**两条承诺都不再误导**：
1. **帮助不再把它当"开箱可用"**（G57）；
2. **失败信息说中文**（G68）——译文已存在，只是没接线。

## 用户场景

中文用户读完 `--help`（其中 `dashboard` 与 `serve` 并列、无任何限定），照做：
```
$ mik dashboard
错误： Could not find the dashboard app (apps/dashboard).
The dashboard is not published with the npm package: … ships the library, the CLI and the HTTP server only.
  Installed from npm? Run the dashboard from a clone of the repository, or deploy apps/dashboard yourself.
  …
EXIT=1
```
两个问题同时发生：**命令本不该被那样宣传**（G57），**且错误正文是英文**（G68）——**中英混排**。

## 当前问题（R129 实测于已发布 `0.2.11`；R138 补充边界声明现状）

### G57：帮助把不可用的命令当常规命令（**缺口比初判更窄**）
- `mik --help` 列出：`dashboard   启动看板应用（默认 3210）`——**无限定语**；
- 包内**确无** `apps/`（`Test-Path node_modules/model-infra-kit/apps` → False）；
- 错误信息本身写得很好（解释了原因并给三条出路）——**缺的是「事前告知」，不是「事后解释」**。

> **R138 补充（重要，必须写进卡里）**：G15 **已在两份 README 中声明该边界**，且写得清楚——
> > **本包不含看板。** `files` 只有 `dist` 与 `LICENSE`（库 + CLI + HTTP 服务）；Next.js 看板在仓库的 `apps/dashboard`，`mik dashboard` 只在 monorepo 内可用，装包环境会报错并给出指引。
>
> 因此 **G57 的剩余缺口收窄为「`--help` 与 `init` 引导未提示」**，**不是**「整个产品都没说」。
> 这会影响本卡的**成本判断**（更小）与**表述**（`--help` 里加一句与 README 一致的限定即可，**不要**另起一套说法）。
> 另注：那句「详见[项目 README 的「看板」一节](../../README.md#看板)」是**相对链接**，npm 用户点不动 → 见 G63（且这是 G15 新引入的第 5 个相对链接）。

### G68：6 个死键（译文就绪但未接线）
| 字典键 | 代码实际（硬编码英文） | 位置 |
|---|---|---|
| `dashboard.error.missingApp` | `` `Could not find the dashboard app (…)` `` | `commands/dashboard.ts:58-59` |
| `dashboard.error.notAPackage` | `` `${dir} does not look like a package (no package.json).` `` | `:119` |
| `dashboard.error.noEntryPoint` | `` `Could not start the dashboard: no local next install…` `` | `:133-134` |
| `dashboard.error.spawnFailed` | `` `Could not start the dashboard: ${error.message}` `` | `:155` |
| `dashboard.hint.packaging` | 英文常量 `DASHBOARD_PACKAGING_HINT` | `:23` |
| `wizard.nextStepsTitle` | **无任何引用** | （`init` 向导） |

**关键**：这些键 **zh/en 双语都已写好**，只是**调用点没接**。因此**键对等测试、键数检查、以及"扫硬编码英文字面量"的检查全部会通过**——典型的"看起来做完了"。

## 理想行为

1. **G57**：`--help` 与 `init` 引导里给 `dashboard` 加**如实限定**，例如
   `dashboard   启动看板应用（默认 3210）——需仓库克隆或自部署，npm 包不含`；
   en 侧对应一句。**不删除该命令**（`--dir` 指向自备副本时仍可用，且该能力真实存在）。
2. **G68**：把 5 处 `dashboard` 文案 + 1 处向导标题改为经 `tr(lang, key, …)` 输出；`missingDashboardError()` 等需要**补 `lang` 参数**（当前无参），调用点传入 `contextLang(context, options)`。
3. **数据不译**：路径（`apps/dashboard`、`<dir>`）、命令（`pnpm --filter @mik/dashboard dev`）、`package.json`、`PATH`、`next` 等保持原文。
4. **新增死键守卫测试**：把 `.tmp/find-dead-i18n-keys.mjs` 的思路做成真测试——**排除已知模板拼接模式**（`cmd.*.summary` 走 `text(lang, \`cmd.${name}.summary\`)`）后，**断言死键为 0**。这把"未接线"变成 CI 可拦的回归。

## 涉及模块

`packages/mik/src/cli/commands/dashboard.ts`、`packages/mik/src/cli/commands/init.ts`（`wizard.nextStepsTitle` 的去留）、`packages/mik/src/cli/args.ts`（`dashboard` 的 summary/details）、`packages/mik/src/cli/i18n/{zh,en}.ts`、`packages/mik/test/cli.test.ts`（或新增 `test/i18n-wiring.test.ts`）

## 不能破坏什么

- **`MIK_LANG=en` 逐字不变**（除 `dashboard` 帮助新增的限定语，须在报告里逐条列出）。
- `cli-english-surface.test.ts` 的 5 个 fixture 保持 **5/5 绿**（若因 `dashboard` help 变更需同步，须说明是**有意**变更）。
- `mik dashboard --dir <有效副本>` 的**成功路径不变**；`--help` 退出码仍 0；未知命令/选项行为不变。
- 既有 484 例测试全绿。
- **不动 `DASHBOARD_PACKAGING_HINT` 的英文内容**——它若被 en 侧字典引用，en 输出必须保持逐字一致。

## 验收标准

- **A1**：zh 下执行 `mik dashboard`（npm 安装场景）→ **错误正文为中文**，且**不再出现** `Could not find the dashboard app` 英文句。
- **A2**：zh 的 `mik --help` 中 `dashboard` 一行**含限定语**；en 侧含对应英文限定语。**两处都能被断言**。
- **A3**：**死键扫描 = 0**（排除模板拼接模式）；该断言在**改前必须为红**（改前 6 个死键）。
- **A4**：`dashboard` 成功路径（`--dir` 指向自备 Next 副本）未被破坏——若难以在测试中构造，**请在报告里明确声明未覆盖及原因**，不要写成"已覆盖"。
- **A5**：`tsc --noEmit` 0；全量测试在 **zh-CN 与 en-US** 下均全绿；`e2e` exit 0；`check-envs` 三环境 PASS；CI 三 OS 绿。
- **A6**：字典 zh/en **键对等**（当前 229；本卡若删/加键，两侧同步）。

## 错误场景

- npm 安装（无 `apps/`）→ 中文错误 + 指向三条出路（保留既有出路的**内容**，仅译语言）。
- `--dir` 指向非包目录 → `dashboard.error.notAPackage` 中文。
- `--dir` 指向有包但无 next/pnpm → `dashboard.error.noEntryPoint` 中文。
- 启动子进程失败 → `dashboard.error.spawnFailed` 中文。
- **以上四条都应能被断言**，且**数据部分（路径）保持原文**。

## 测试要求

- ≥6 新用例：① zh 的 missingApp 为中文且英文句不出现；② zh 的 notAPackage；③ zh 的 noEntryPoint；④ zh 的 spawnFailed（或说明为何难构造）；⑤ `--help` 的 `dashboard` 限定语（zh 一条、en 一条）；⑥ **死键扫描为 0**。
- 全部注入 `MIK_LANG`；**不得**读真实 locale。
- **G43 自检**：每条断言在改前必须能红。**特别注意**：断言"输出含中文"在错误前缀 `错误：` 本就中文时**可能恒真**——必须断言**正文**为中文（例如断言含「找不到看板应用」而**不含** `Could not find`）。

## 范围外

`--help` 的**选项说明**本地化（**G58**，已立卡）、`set-default` 命令、`providers.setDefaultModel` 的 CLI 写入路径（G56 补充项）、看板随 npm 包发布（**NOT_NOW**：体积与构建成本远大于收益）、`node:sqlite` 实验警告（G61）。
