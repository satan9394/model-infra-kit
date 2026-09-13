# EVO-G90 — 看板金额单元格的页面级断言（补卡：已完成切片的追溯卡）

> 卡号 G90（P1，**验证片：无运行时变化**）· 来源：BACKLOG ⑥（「看板断言是整页子串匹配」）
> **补卡**：本卡在 `e0e0705` 之后由 **Mission 1 的 N3** 事后补写。依据是项目自己的教训 `43d74e6`：「只活在状态文件里的交接项**不可执行**，因为每个 Worker 必须读自己的卡」——G90 在补卡前**没有任务卡**（当时 `tasks/` 无 `*G90*`；本文件即补上的那张卡）。全仓 `G90` 字样共 **4 文件 7 处**：`AGENTS.md`×2、`docs/product-evolution.md`×1、`scripts/e2e/README.md`×1、`scripts/e2e/run.mjs`×3（**N6 核验实测口径**；本行初稿曾误写为"只在 product-evolution.md 出现 1 次"，已按 N6 阻断建议订正）。
> 读卡前先读 `AGENTS.md`（硬性规则 + 复盘教训）与 `docs/interfaces.md`（用量契约）

## 状态（如实登记）

**已实现 + 已验收 PASS + 已提交 + 已发布（`model-infra-kit@0.3.1`）**。本卡是**追溯记录**，**不是待办**。

**唯一偏差（必须如实标注）**：本轮 G90 **没有独立 Evaluator**——当时**禁止子代理**，所有结论均为**编排者自证**（`DSH_RECOVERY_REPORT.md` §10 自陈「这是与收尾铁律的唯一偏差」）。独立对抗核验由 **Mission 1 的 N6**（全新上下文、只见产物与验收标准反向挑错）承担：**N6 判决 PASS（置信度约 0.9）**；N6 独立重跑了 `node scripts/e2e/run.mjs` 得 **12/12、exit 0**，并复现了 DASH 单元格的区间串 `$0.0343 ~ $0.0443`，另用零写入探针验证「改回点估计必红」的机制成立。报告：`modelinfra-mission-01/evidence/N6-verdict.md`。N6 同时指出本卡初稿第 4 行有 1 处假说法，已在提交前订正（见上）。

## 一句话

修掉 `DASH` 断言的「**整页子串匹配**」**假通过** ⇒ 改为**单元格锚定** + **真价差 fixture** + 「**fixture 真带区间吗**」守卫。

## 现状（问题，已在产物上核验）

`DASH` 原先的断言是 `home.includes(expected.cost)`——**整页子串匹配**；而该 run 写下的每一行都是**点定价**（`low === high === usd`），`expected.cost` 因此**永远是一个单值**。点定价下「渲染记录的**区间**」与「渲染已被弃用的 `costUsd` **点估计**」印出**同一个字符串**：**即使看板回去读 G89 刚劝宿主别读的那个字段，这条检查照绿。** 这就是 BACKLOG ⑥ 的内容，而它**是真的**。

## 目标与范围

1. **单元格锚定**：`StatCard` 新增**可选** `testId`（其余视图都不传）；`overview.tsx` 总花费单元格挂 `data-testid="overview-cost-span"`。断言改为**只读该锚点的文本**，不再对整页做子串匹配。
2. **真价差 fixture**：e2e 经**公开计量 API** 写一条**真实价差行**（`low 0.01 < usd 0.012345 < high 0.02`），使「区间」与「点估计」在**字面上必然不同**。
3. **守卫**：断言 **fixture 本身真是区间吗**（即 `low !== high`），否则断言**空洞**；另在**离线态**用同一锚点断言读 `—`。
4. **范围**：只动 `apps/dashboard/components/ui.tsx`、`apps/dashboard/components/views/overview.tsx`、`scripts/e2e/run.mjs`、`scripts/e2e/README.md` 四个实现文件 **+ `packages/mik/package.json` 升版**。`packages/mik/src/**` **一行未动**，看板不在 tarball 内 ⇒ **本版无运行时变化**。

## 不能破坏什么

- **G89 的弃用取向**：看板**不得**为了「让这条检查变绿」而回去消费已被弃用的 `costUsd` 点估计。
- **`formatUsd` / `formatUsdSpan` 的既有呈现**与其他视图**逐字不变**（`testId` 是**可选**参数，不传即与改前一致）。
- **e2e 其余 11 步不变**；`usage export` 的 22 列与前 15 列字面量锁不受影响。
- **金额仍以整数微美元为真源**；禁止 `SUM(CAST(cost AS REAL))`。

## 验收标准（客观门禁，均已实测）

- **A1（改前必红，可复核）**：把单元格**临时改回** `formatUsd(costUsd)` → `node scripts/e2e/run.mjs` 必须打印

  ```
  FAIL DASH the overview money cell prints "$0.036645", expected the recorded band "$0.0343 ~ $0.0443"
  ```

  且**退出码 1**（实测 62.8 s）。**逐字还原后** 12/12 通过、**exit 0**（实测 83.8 s），单元格读 `$0.0343 ~ $0.0443`。交证 = **两次运行的原始输出 + 退出码**（不许只贴摘要）。
- **A2（守卫非空洞）**：断言 `low !== high`（fixture 本身确实是区间）；并断言锚点文本等于 `formatUsdSpan(...)` 的结果。**改前必须能红**（G43）。
- **A3（锚点唯一）**：断言读的是 `data-testid="overview-cost-span"` 的**单元格文本**，不是整页 HTML；离线态同一锚点读 `—`。
- **A4（机械门禁）**：两边 `tsc --noEmit` **0**；vitest **694 例**在 zh-CN 与 en-US（`LC_ALL`/`LANG`，**不设 `MIK_LANG`**）下均全绿；看板 **15/15**；`e2e` **12/12 exit 0**；三环境电池 **PASS**；**CI 三 OS 全绿**（run `34717302263`，三个 job 均 success）；**G36 已发布产物验证通过**。
- **A5（收尾铁律）**：升版后**重跑全量**（R99：CLI `--help` 横幅含版本号，冻结快照会因版本变化翻红）；G36 式验证的临时目录**必须先写自己的 `package.json`** 并打印 `import.meta.resolve()` 自证解析落点（R260 血案）。

## 关联提交与版本

| 项 | 值（实读核对） |
|---|---|
| 实现提交 | **`285e23a`** = `285e23afe3c59a643c1ff0be94449eeff34ab833` — `v0.3.1: the dashboard money cell asserts on itself, against a real spread (G90)`，**5 文件 87+/4−**（4 个实现文件 + `packages/mik/package.json` 升版；`docs/product-evolution.md` 记「改动（4 个文件）」= **不含升版**，两者不矛盾） |
| 文档收口提交 | **`e0e0705`** = `e0e070522bfbd6658717983a9adc0aab7c4c168b` — `docs: G90 closure, status v0.3.1; …`，2 文件 30+/4− |
| 版本 | **`model-infra-kit@0.3.1`**（`packages/mik/package.json`）；npm `dist-tags.latest = 0.3.1`；远端 `refs/tags/v0.3.1 → 285e23a` |
| 发布理由 | **以版本号作为每个切片的记账单位**（既有 41 个版本无一例外） |

## 证据指针

| 证据 | 落点 |
|---|---|
| 产品演进留痕（**权威**） | `docs/product-evolution.md` 的 **`## EVO-G90 收尾（R260）`**（**第 396 行**，标题原文 `## EVO-G90 收尾（R260）——看板金额单元格的页面级断言`；改前必红在 402 行，门禁在 404 行，未关闭项在 408 行，教训 R260 在 410–414 行） |
| 实现与验证全过程（含改前必红、门禁、教训 R260） | **`DSH_RECOVERY_REPORT.md` §9 / §10**（该文件**未跟踪**，**本卡不触碰它**） |
| 运行时断言本体 | `scripts/e2e/run.mjs`（DASH 步骤、`testIdText()`、区间守卫）、`apps/dashboard/components/ui.tsx`（`StatCard` 的 `testId`）、`apps/dashboard/components/views/overview.tsx`（`data-testid="overview-cost-span"`） |
| **未关闭（登记，不是待办）** | ① `apps/dashboard/components/views/trends.tsx:58` 是**同一形状**的金额单元格，仍无锚点、无页面级断言 ⇒ **同类盲区只关掉一半**；② 因此 BACKLOG ⑥ 只是**部分**闭合；③ `apps/dashboard/scripts/seed.mjs:306` 仍印点估计（BACKLOG ①）。按 **R259**，这些**不进待办** |

## 范围纪律

本卡是**补卡**，**不产生任何新的实现要求**；`packages/mik/src/**` 与看板运行时行为**均不改**。若后续要在 `trends.tsx:58` 关掉「同类盲区的另一半」，那是**新的一张卡**（Mission 1 的 W2），不在本卡范围内。
