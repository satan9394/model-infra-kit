# EVO-G14 — 收完 CLI 层剩余英文 + 框架前缀一致性（G37 收尾）

> 暂存于 `.tmp/`，待 G13 关闭后提交为 `tasks/EVO-G14-i18n-final.md`。
> 依据：R95 精确度量（CLI 层 18 处 / 5 文件）+ R95 新发现（`warning:` 前缀被漏）。

## 目标

把 CLI 层剩余的**用户可见英文说明文案**全部纳入 zh/en 字典，使「CLI 支持双语」这一承诺**不留半本地化段落**；并补齐 G12 遗漏的**框架前缀**（`warning:`）。

## 背景（R95 实测，G13 完成后）

| 文件 | 裸英文 `io.out/err` 处数 | 内容示例 |
|---|---|---|
| `cli/commands/models.ts` | 5 | 模型列表/同步输出 |
| `cli/commands/serve.ts` | 5 | `Listening on …` / `OpenAI-compatible base URL: …` / `Bearer token required (value not shown).` / `Press Ctrl+C to stop.` / `Stopped.` |
| `cli/commands/pricing.ts` | 4 | 手动价与目录状态 |
| `cli/context.ts` | 3 | **`warning: …` 前缀三条**（配置读取警告） |
| `cli/commands/dashboard.ts` | 1 | 看板启动提示 |
| **合计** | **18** | |

**R95 新发现（本卡要一并处理）**：`context.ts` 的三处全是 **`warning:` 前缀**——G12 只本地化了 `error:`/`usage:`，**漏了 `warning:`**。属**模式性遗漏**，应与 `error:` 同口径处理。

## 用户场景

- 中文用户跑 `mik serve`：`正在监听 …`、`OpenAI 兼容基址：…`、`需要 Bearer token（不显示值）。`、`按 Ctrl+C 停止。`、`已停止。` —— **URL / token 占位 / 端口仍是字面量**。
- 中文用户看到配置警告时是 `警告：…`，与 `错误：…` 同一套前缀风格。
- 英文环境输出与改前**逐字节相同**。

## 理想行为（变更点）

1. **补字典键**（zh/en 两侧逐个对等），覆盖上表 18 处说明性文案。
2. **框架前缀统一**：`warning:` 与既有 `error:`/`usage:` 同口径（zh 为 `警告：`）。**顺带全库搜索**其它未进字典的框架级前缀（`note:`/`hint:`/`tip:` 之类），一次性收口——**同类问题不要分多次发现**（G09/G43 的恒真断言、R95 的 `warning:` 都属此类）。
3. **数据值保持原文**：URL、端口、token 占位、模型 id、金额、时间戳、计数、`app=`/`provider=`/`model=`/`status=` 键名**一律不译**；CSV 列名不动。
4. **模型列表的列名可译、行数据不译**（与 G13 对 provider 表的处理一致）。

## 涉及模块

- `packages/mik/src/cli/commands/{models,serve,pricing,dashboard}.ts`
- `packages/mik/src/cli/context.ts`（warning 前缀）
- `packages/mik/src/cli/i18n/{zh,en}.ts`
- `packages/mik/test/cli.test.ts`

## 不能破坏什么

- **`serve` 的启动契约**：`Listening on <url>` 这一行被 e2e（DIST 检查点）与三环境电池断言；若本地化，**必须同步更新那些断言并保持英文路径不变**（e2e/电池已是 `MIK_LANG=en`，故英文字串应原样保留）。
- 表格列数/顺序/对齐（含 G13 新引入的 CJK 宽度补偿）、退出码语义、CSV/结构化输出。
- 既有 466 例测试全绿；`battery.{ps1,sh}` 与 e2e 的钉语言设置不变。

## 验收标准

- A1 **zh 可见**：上表 18 处在 `MIK_LANG=zh` 下无英文残留（**用黑名单探针 + 抽查未被探针覆盖的路径**，两者都要，避免 G12 的样本集不闭合）。
- A2 **en 零回归**：`MIK_LANG=en` 下与**改前基线逐字节相同**——**必须用同一调用方式对比两个构建**（`probe-g13-en-parity.mjs` 的模式可复用；R94 的教训：基线采集方式必须与对照一致）。
- A3 **框架前缀一致**：zh 下 `warning:`/`error:`/`usage:` 三类前缀均为中文，且**风格统一**；全库搜索确认无其它英文框架前缀残留。
- A4 **数据值未译**：URL/端口/token 占位/CSV 列名/键名保持原文（可断言）。
- A5 **键对等**：zh/en 新增键逐个对等（既有 parity 深等测试覆盖）。
- A6 **两种 locale 全量**：`tsc --noEmit` 0 错误、全量 vitest **在 zh-CN 与 en-US 下均全绿**（基线 466）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS、push 后 **CI 三 OS 绿**。

## 错误场景

- `serve` 端口被占用 / token 缺失 / Ctrl+C 中断：文案要本地化，**退出码与既有行为不变**。
- `models sync` 离线降级：警告同样走 `warning:` 口径。
- 若某文案含动态拼接，保持占位符顺序，勿改数据部分。

## 测试要求

- ≥6 新用例：`serve`（可注入 io 的话）、`models list`、`pricing list`、`dashboard` 各 1 条 zh 断言；1 条 `warning:` 前缀中文断言；1 条 en 对照。
- **不得**为测试放宽生产默认；**不得**新增读真实 locale 的断言（G26）。

## 范围外

**库层** 11 处错误文案（`registry` 4 / `credential` 4 / `ai` 2 / `server` 1，如 `Invalid provider id …`）——它们由库层抛出、被 CLI 透传；处理需先定「CLI 是否统一包装库层错误」的策略（改库层会影响 API 使用者对错误文案的匹配）。**登记为独立技术债（候选 G50）**。看板 i18n 全面化、G10b、新功能亦在范围外。
