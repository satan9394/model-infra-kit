# EVO-G71 — 让装包用户点得动文档（G63）

> 暂存于 `.tmp/`，待前序卡关闭后转正。**证据**：`.tmp/g63-correction-R120.md`（R120 取证更正）+ R138 复测（已发布 0.2.11 的包内 README）。

## 目标

**npm 用户能在不离开包页面的情况下，点开项目文档**——具体说：包内 README 的所有 Markdown 链接**指向真实可打开的位置**，且**成本最高的那份文档（成本对账）有入口**。

## 用户场景

一个从 npm 装包的开发者，读到 `packages/mik/README.md` 末段：

```
## 相关文档
- 接入示例：[`../../examples/`](../../examples/)
- 项目 README：[`../../README.md`](../../README.md)
- 契约：[`../../docs/interfaces.md`](../../docs/interfaces.md)；取舍：[`../../docs/decisions.md`](../../docs/decisions.md)
```

他点「项目 README」→ **404**（详见下）。

## 当前问题（R138 实测于已发布 `0.2.11` 的**包内** README）

包内 README（283 行）的 Markdown 链接清单——**5 个全是相对路径，全部失效**：

| 行 | 链接 | 解析结果 |
|---|---|---|
| L31 | `../../README.md#看板` | `node_modules/README.md` → **不存在**（且这是 **G15 新增**的链接） |
| L281 | `../../examples/` | `node_modules/examples/` → **不存在** |
| L282 | `../../README.md` | 同上 |
| L283 | `../../docs/interfaces.md` | `node_modules/docs/` → **不存在** |
| L283 | `../../docs/decisions.md` | 同上 |

**根因**：这些 `../../` 路径**假设读者位于仓库的 `packages/mik/`**。而装包后实际位置是
`node_modules/model-infra-kit/`，`../../` 解析到 `node_modules/` —— **实测 `node_modules/docs` 不存在**。

**更重要的连带事实（R120 取证更正）**：**仓库根 README（483 行，含快速开始 / 升级说明 / 边界声明）不进 npm 包**。
npm 访客只看到**包级 README（283 行）**。所以对 npm 用户而言：
- 那份项目级总览**看不到**；
- **`cost-reconciliation.md`（成本对账，G07 交付）在包内 README 与 CLI `--help` 中「两处 0 命中」**（R110/R133 实测）——**唯一发现路径是手动浏览 GitHub 的 docs/ 目录**；
- 而它正是「为什么我的账和供应商账单不一致」时最需要的东西。

## 理想行为

1. **把 5 处相对链接改为指向 GitHub 的**绝对 URL**（仓库公开，零包体积代价；仓库里已有绝对链接先例）。形如
   `https://github.com/<owner>/<repo>/blob/main/docs/interfaces.md`（用 `<owner>/<repo>` 占位，**不要**写死个人账号——本仓库 docs 一贯用占位符）。
2. **在包内 README 里补一条指向「成本对账」的绝对链接**（并说明它解决什么问题），使 G63-① 的「零入口」消失。
3. **是否把 `docs/` 纳入 `package.json` 的 `files`**：**默认不做**（会增包体积，且 README 绝对链接已足够）；若将来有证据表明用户需要离线文档，再议。**这一取舍要写进卡里，避免实现者顺手加 `files`。**

## 涉及模块

`packages/mik/README.md`（主要）、`README.md`（仓库根，若其中也有对包内 README 的相对引用需一并核对）、`packages/mik/package.json`（**仅在不修改 `files` 的前提下确认**）

## 不能破坏什么

- **不改 `package.json` 的 `files`**（保持包体积）；**不改版本号**。
- 包内 README 的**既有正文不改**（只改链接目标；除刻意新增的成本对账入口）。
- **不做 npm 无法验证的承诺**：README 里不得出现指向「包内不存在」的路径。
- 既有 484+ 例测试全绿；`tsc` 0；e2e/电池不受影响（本卡不碰代码路径）。

## 验收标准

- **A1（可机检）**：**包内 README 中不存在相对路径的 Markdown 链接**（即 `](` 后不以 `http`、`#`、`mailto:` 开头的链接数 = **0**）。判定命令示意：
  ```bash
  # 从"发布产物"取，不是仓库根（R120 教训）
  npm pack && tar -xzf *.tgz && grep -oE '\]\([^)]+\)' package/README.md
  ```
  **必须用打包产物验证，不得只看仓库文件**——这正是 G63 被误判过一次的原因。
- **A2**：5 个链接**逐个**能在 GitHub 上解析到真实文件（人工确认或 HTTP 200 检查；至少给出每个 URL 与目标路径的对应表）。
- **A3**：包内 README **含指向 `docs/cost-reconciliation.md` 的入口**，且该 URL 可打开。
- **A4**：`package.json` 的 `files` **未变**（用 `git diff` 证明）。
- **A5**：无代码路径改动 → 但仍需 `tsc --noEmit` 0、全量测试在 **zh-CN 与 en-US** 下全绿（防误改）。

## 错误场景

- 仓库将来改名/迁移 → 绝对 URL 会失效。**缓解**：在卡里注明「若仓库改名，需同步 README」——不要为此引入构建期注入（成本大于收益）。

## 测试要求

- **本卡主要是文档**，但**A1 可机检**，建议加一个**真测试**（`packages/mik/test/readme-links.test.ts` 或并入既有 docs 一致性测试）：
  - 读 `packages/mik/README.md`，断言**不存在**以 `../../` 开头的 Markdown 链接；
  - 断言至少存在一条指向 `docs/cost-reconciliation.md` 的 `https://` 链接。
  - **G43 自检**：该断言在改前必须为红（改前有 5 个相对链接）——**这条天然非恒真**。
- 注意：`README.md` 会被 npm 打包，测试读的是**源码树里的那份**——两者内容相同（npm 打包的就是它），这一点与 R120 的「仓库根 vs 包内」不同，**但请在报告里说明你核对了这一点**，别想当然。

## 范围外

G69（dashboard 诚实性/本地化）、G70（输出噪声）、G58（选项说明本地化）、把 `docs/` 打进包（**默认 NOT_NOW**，见理想行为 3）、为链接失效引入构建期注入（成本 > 收益）。
