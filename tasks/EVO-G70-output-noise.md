# EVO-G70 — 输出噪声与重复（G60 + G61）

> 暂存于 `.tmp/`，待前序卡关闭后转正。**证据**：`.tmp/g60-evidence-R133.md`（G60 产物实测）+ R113 审计 F6（G61）。

## 目标

用户第一眼看到的输出**只说他需要的那一句**：
- `provider test` 失败时**不重复同一句话**（G60）；
- 每条命令**不再无条件刷出 `node:sqlite` 实验警告**（G61）——且**不用「隐藏」来达成**。

## 用户场景

**G60**：中文用户跑 `mik provider test <id>`，凭据缺失。他真正需要的是「该设哪个环境变量」。实测（已发布 0.2.11）得到**同一句英文出现三次**：
```
警告： Provider check failed for "probe2": Environment variable NO_SUCH_VAR_X is not set for this provider's API key. (
Environment variable NO_SUCH_VAR_X is not set for this provider's API key.)
供应商  结果    延迟  模型  信息
------  ------  ----  ----  --------------------------------------------------------------------------
probe2  failed  4 ms  -     Environment variable NO_SUCH_VAR_X is not set for this provider's API key.
```
即：摘要行正文 + **同行括号内逐字重复**（还因过长折行）+ 表格「信息」列。

**G61**：`init`/`provider list`/`provider test`/`usage summary`/`usage logs`/`serve` 等**几乎所有命令**都向 stderr 打印：
```
(node:23840) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```
首次使用第一眼就看到「实验特性、随时可能变」，与「用量/计价可信」的定位相冲；管道化输出时也污染 stderr。

## 理想行为

### G60（只改「呈现」，**不碰库层**）
1. **去掉括号内重复**：括号本意是附加上下文（`cause`），当 cause 与 message 相同时**不打印括号**（或在 CLI 层做去重）。
2. **表格「信息」列用本地化短句**：如「凭据缺失：环境变量 %s 未设置」「连接失败」「鉴权被拒」，**环境变量名保持原文**。
3. **摘要行**：保留一句，**正文仍可来自库层**（按 G50 边界不翻译），但**不再重复三遍**。
4. **不改库层文案、不改退出码**（失败仍 exit 1）。

### G61（**优先「解释」，不是「隐藏」**）
**硬约束**：**不得**用「全局吞掉警告」的方式静默它。可选做法按优先级：
1. **首选**：在**首次运行**（或 `init` 完成时）用一句本地化说明解释这是 `node:sqlite` 的既有提示、不影响正确性——**保留**警告本身（诚实）；
2. 次选：若确实要抑制，**必须只针对这一条**（按消息内容过滤，而非 `removeAllListeners('warning')` 全禁），且**在 README/`--help` 中写明已抑制及原因**；
3. 无论哪种，**不得**影响其它 Node 警告（尤其是今后可能出现的安全警告）。
**建议**：本卡先做「解释」（方案 1），把「抑制」留作将来有用户抱怨时再议——**理由**：该警告是 Node 对 `node:sqlite` 实验状态的诚实提示，隐藏它会让用户失去一条真实信息。

## 重复的确切来源（R144 定位，非猜测）

**三处出现来自三个不同位置**：

| # | 出现位置 | 产生者 |
|---|---|---|
| 1 | `警告： Provider check failed for "X": <原因>` 的正文 | **库层** `src/ai/bridge.ts:178`：`deps.onWarn?.(`Provider check failed for "${providerId}": ${message}`, error)` —— **把 cause 的 message 嵌进正文，同时又把 `error` 作为第二参传出** |
| 2 | 同一行的**括号内** `<原因>` | **CLI 层** `src/cli/context.ts:175` 的 `onWarn`：`` io.err(`warning: ${redact(message)}${error ? ` (${redact(messageOf(error))})` : ""}`) `` —— **又把 cause 追加一次**，而 cause 的 message 与正文里那句**逐字相同** |
| 3 | 表格「信息」列 | `provider test` 自己的渲染（同一 cause message） |

**根因（一句话）**：库层**同时**做了「把原因写进正文」与「把原因作为 cause 传出」两件事，而 CLI 层的 `onWarn` 会**无条件**把 cause 追加到括号——于是同一句话被打印两次。

**推荐修法（保持「只改呈现」的边界）**：
- 在 **CLI 的 `onWarn`** 里**先去重再追加**：若 `messageOf(error)` 已经被 `message` 包含（或与之相等），**不再追加括号**。
- **不动 `bridge.ts`**（库层 API 的第二参对宿主有用；按 G50 边界不在本卡）。
- 表格「信息」列按理想行为 2 改为**本地化短句**，并保留变量名原文。
- 这样「重复 3 → 1」在不碰库层的前提下达成，且 **A2 反例（cause≠message 时括号保留）自然成立**。

## 涉及模块

`packages/mik/src/cli/commands/provider.ts`（G60 摘要与表格）、可能 `packages/mik/src/ai/`（错误的 `cause` 传递，需**先读后判**）、`packages/mik/src/cli/i18n/{zh,en}.ts`、`packages/mik/src/cli/index.ts`（G61 的启动钩子，若采用）、`README.md`（若采用抑制需写明）

## 不能破坏什么

- **`MIK_LANG=en` 逐字不变**（除 G60 刻意删除的重复括号、G61 刻意新增的说明行——**须在报告里逐条列出**）。
- `cli-english-surface.test.ts` 5/5 绿。
- **退出码语义不变**（`provider test` 失败 = 1）。
- **不吞掉其它警告**；**不隐藏错误**。
- 既有 484+ 例测试全绿。
- **密钥不泄漏**：G60 涉及错误文本，任何改动后仍需经 `redact`（可用带 token 形状的假 message 构造反例）。

## 验收标准

- **A1（G60）**：zh 下 `provider test`（凭据缺失）输出中，**同一句原因的重复次数从 3 降到 1**；表格「信息」列为**中文短句**且含**原文环境变量名**。断言：`(grep -c "NO_SUCH_VAR_X") == 2`（表格一次 + 摘要一次，且二者**语义不同**）**或**明确说明你达成的次数并给理由。
- **A2（G60 反例）**：当 `cause` **确实不同于** message 时，括号**仍然出现**（否则你只是粗暴删了括号，丢了真实信息）。**这条必须有测试**。
- **A3（G61）**：按所选方案给出**可断言的证据**：
  - 若「解释」：`init` 或首次运行输出含**一句本地化说明**（zh/en 各一条断言），且**原警告仍在**（断言 stderr 仍含 `ExperimentalWarning`）；
  - 若「定向抑制」：断言该警告**不再出现**、**且**其它警告（构造一条测试警告）**仍然出现**。
- **A4**：`tsc --noEmit` 0；全量测试在 **zh-CN 与 en-US** 下均全绿；`e2e` exit 0；`check-envs` 三环境 PASS；CI 三 OS 绿。
- **A5**：字典 zh/en 键对等（当前 285，若本卡增键则两侧同步）。

## 错误场景

- 凭据缺失、鉴权失败、连接失败、模型不存在——各自给**中文短句**，**变量名/模型 id 保持原文**。
- 长错误文本**不得**再次折行成难看的括号重复。
- `redact` 仍生效（构造含 token 的假错误，断言被脱敏）。

## 测试要求

- ≥6 新用例：① zh 的凭据缺失摘要不重复；② zh 的表格信息列为中文；③ **cause≠message 时括号保留**（A2 反例，**最重要**）；④ G61 方案对应的断言（按所选方案）；⑤ en 对照一条；⑥ redact 反例一条。
- 全部注入 `MIK_LANG`。
- **G43 自检**：每条断言改前必须能红。**本卡特别提醒**：断言「输出不再重复」时，别写成恒真——要**数次数**，或断言**旧括号形态不存在**。

## 范围外

G58（选项说明本地化，已立卡）、G69（dashboard 诚实性与本地化）、G50（库层文案翻译——本卡**只改呈现**，不扩大 G50）、把 `node:sqlite` 换成其它存储（**NOT_NOW**：无收益）。
