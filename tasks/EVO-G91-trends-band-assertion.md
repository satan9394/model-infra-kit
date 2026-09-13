# EVO-G91 — 看板 **trends** 成本区间单元格的页面级断言（+ 6 位精度页面级取证）

> 卡号 G91（P1，**验证片：预期无运行时变化**）· 来源：G90 的「未关闭①」（**同类盲区的另一半**）+ `DSH_RECOVERY_REPORT.md` §4.1（金额 6 位精度未取证）+ BACKLOG ⑧（可选）
> **同族先例**：`tasks/EVO-G90-dashboard-band-assertion.md`（G90 只关了 `overview` 那一半）
> 读卡前先读 `AGENTS.md`（硬性规则 + 复盘教训）与 `docs/interfaces.md`（用量契约）

## 状态（如实登记，**这一节是本卡最重要的部分**）

**本卡是「下一轮候选」，本轮（N4）只做登记：未实现、未验证、未派活、未改动任何代码或断言。**

- 本轮**只新增这一份卡文件**，没有改代码、没有跑测试、没有跑 e2e、没有 install、没有任何 git 状态变更。
- 之所以单独声明，是因为本项目记过教训 **R259：登记 ≠ 队列**（`docs/product-evolution.md` 的「未关闭（登记，不是待办）」原文即写明「按 R259，这些**不进待办**」）。**把本卡读成「已排期」或「已开工」都是误读**；是否开做、何时开做，由指挥/人类裁决。
- 本卡与 G90 卡的**状态不同**：G90 卡是「已实现 + 已验收 PASS + 已提交 + 已发布」的**追溯卡**；本卡是**前瞻性的候选卡**，其验收标准全部是**草案**，**尚未有任何一个门禁被实测过**。

## 一句话

把 G90 在 `overview` 上做过的三件事（**单元格锚点** + **真价差 fixture** + **fixture 真带区间吗**守卫），在 `trends` 的**成本区间单元格**上**再做一遍**；顺带给「金额 **6 位精度**」补一条**页面级**断言（当前只有 helper 级/表达式级取证）。

## 现状（问题；已在代码上逐字实读，见下「实读核对」）

**盲区①（主项）**：`trends` 视图的「区间成本」单元格渲染 `formatUsdSpan(...)`，与 G90 修掉的 `overview` 单元格**同一形状**，但**没有 `data-testid` 锚点、没有页面级断言**。

- 后果与 G90 完全相同：点定价 run（`low === high === usd`）下，「渲染记录的**区间**」与「渲染已被弃用的 `costUsd` **点估计**」印出**同一个字符串**；`scripts/e2e/run.mjs` 的 DASH 步骤**只锚定 `overview-cost-span`**，于是**即使 `trends` 回去读 G89 刚劝宿主别读的字段，e2e 照绿**。
- 即：**同类盲区只关掉一半**，BACKLOG ⑥ 只是**部分**闭合（G90 卡第 65 行已如此登记）。

**盲区②（6 位精度）**：`DSH_RECOVERY_REPORT.md` §4.1 自陈「**金额 6 位精度仍未做页面级/产物级取证**」。现有取证位置是**单元级**：`apps/dashboard/test/cost-span.test.ts:25/32` 断言 helper 的 6 位与区间形态；`apps/dashboard/lib/format.ts:25` 是「有微余数则 6 位、否则 4 位」的规则本体。**没有一条断言证明「页面真的把 6 位印出来了」**。

**盲区③（可选，BACKLOG ⑧）**：`formatUsdSpan` 的**单边缺失**（`low` 有 / `high` 无）。

## 目标

1. **单元格锚定（主项，等价于 G90 的 A1+A3）**：给 `trends` 的「区间成本」单元格挂 `data-testid`（复用 G90 已经建好的机制：`components/ui.tsx` 的 `StatCard` **可选** `testId`，其余视图不传即逐字不变），并在 `scripts/e2e/run.mjs` 的 **DASH** 步骤里，**只读该锚点的文本**做断言——**不再对整页做子串匹配**。
2. **改前必红（主项，本片的核心证据）**：把 `trends` 单元格临时改回点估计（`formatUsd(...)` 读 `costUsd` 那一路）后，`node scripts/e2e/run.mjs` **必须打印含 `trends` 的 FAIL 行且 exit code 1**；**逐字还原后**全绿、exit 0。交证 = **两次运行的原始输出 + 退出码**（项目纪律：不许只贴摘要）。
3. **6 位精度页面级取证（次项）**：e2e 写入一条**有余数**的用量行（微美元非整分），断言页面单元格文本匹配 `\$\d+\.\d{6}` **且**等于 `formatUsdSpan(...)` 的结果；并**必须**有一条**守卫断言该 fixture 本身确实带余数**（否则断言空洞 —— G90 的 A2 是同一手法）。
4. **可选纳入（BACKLOG ⑧）**：`formatUsdSpan` 单边缺失（`low` 有 / `high` 无）的覆盖。**是否纳入由派活时裁决**；若纳入，见下面「实读核对」第 3 条——这条 BACKLOG 的原文**已部分过期**，须按实读改写其口径。

## 范围与不做

**做**：只动 `apps/dashboard/**`（锚点所在的视图、必要时 `components/ui.tsx`）与其 **e2e 断言面** `scripts/e2e/run.mjs`（及 `scripts/e2e/README.md` 的描述行，按 G90 先例）。

**不做 / 硬边界**：

- **不改 `packages/mik` 的运行时行为**：`packages/mik/src/**` 预期**零改动**。**若某条断言只能靠改实现才成立 → 停下来上报，属新裁决**（G90 卡与侦察 §5.5 第 4 条同一取向：不许为了「让检查变绿」而顺手改产品）。
- **不回退 G89 的弃用取向**：看板**不得**为了「让这条检查变绿」而回去消费已被弃用的 `costUsd` 点估计。
- **不破坏既有呈现**：`formatUsd` / `formatUsdSpan` 的既有行为与其他视图输出**逐字不变**（`testId` 是可选项，不传即与改前一致）；**e2e 其余步骤不变**（当前基线 **12/12**）；`usage export` 的 22 列与前 15 列字面量锁不受影响。
- **金额仍以整数微美元为真源**；禁止 `SUM(CAST(cost AS REAL))`。
- **不清理 `.tmp/`**、不做无关重构、不改 `docs/**` 历史条目、不改 `tasks/` 既有卡。

## 验收标准（草案，**客观、可执行、本轮未实测**）

- **A1（单元格锚定，非整页子串）**：断言读的是**该锚点的单元格文本**（`testIdText(html, "<trends 的锚点>")`），不是整页 `html.includes(...)`；并断言**锚点存在**（缺失时给出「无法判断读的是哪个单元格」这类可诊断的失败信息，G90 的 `run.mjs:858` 是范式）。**改前必须能红**（G43）。
- **A2（改前必红 + 逐字还原全绿）**：把 `trends` 单元格临时改回点估计 → `node scripts/e2e/run.mjs` 打印**含 `trends` 的 FAIL 行**、**exit 1**；**逐字还原**后 **12/12（或届时基线）通过、exit 0**。交证 = 两次**原始输出 + 退出码 + 耗时**。
- **A3（fixture 非空洞，6 位精度项）**：断言 **fixture 本身确实带余数**（即 `micros % 100 !== 0`，页面应印 6 位）；否则该断言**空洞**。同时断言单元格文本匹配 `\$\d+\.\d{6}` 且**等于** `formatUsdSpan(...)` 的输出（期望值来自**独立来源**，不是把被测表达式再抄一遍——R231）。
- **A4（机械门禁，在「最后一次编辑之后」跑）**：两侧 `tsc --noEmit` **0**；`pnpm --filter model-infra-kit test` 全绿且**总数 ≥ 694、文件数 ≥ 39**（基线读数，届时以实测为准），并在 `LC_ALL=zh_CN.UTF-8` 与 `LC_ALL=en_US.UTF-8` **各跑一次**（**只设 `LC_ALL`/`LANG`，不设 `MIK_LANG`**，否则 3 例假红）；`pnpm --filter @mik/dashboard test` 全绿；`node scripts/e2e/run.mjs` exit 0。
- **A5（自检）**：新断言**改前必须能红**（G43）；报告须指出**未覆盖**的分支（R208）；凡断言「某处有/没有某写法」，**必须附 `grep` 命令与真实输出**（R258）；单边缺失项若纳入，须按实读改写 BACKLOG ⑧ 的口径（见下）。

## 实读核对（本轮 N4 逐字实读；**以实读为准**）

读法：`read` 文件逐行核对行号；`grep` 取锚点。**未**跑 build / test / e2e / typecheck。

| 引用 | 侦察报告的说法 | **实读结果** | 结论 |
|---|---|---|---|
| `apps/dashboard/components/views/trends.tsx:58` | 「同一形状的成本区间单元格」（侦察 §2.5 / §5.3 W2；G90 卡第 65 行） | **第 58 行正是** `value={formatUsdSpan(totals?.costLowUsd, totals?.costHighUsd)}`，位于 `<StatCard label="区间成本">`（**56–60 行**）之内；紧邻 53–55 行是 EVO-G89 的注释 | **一致，无需更正**；精确说法是「**第 58 行是单元格的 value 表达式，单元格本体是 56–60 行的那个 `StatCard`**」 |
| `apps/dashboard/components/ui.tsx` 的 `StatCard` | G90 新增**可选** `testId` | 实读：`StatCard` 定义在 **78 行**，`testId,` 形参在 **83 行**，`testId?: string` 类型在 **94 行**，`data-testid={testId}` 在 **107 行** | 复用机制**已就位**，G91 只需给 trends 传一次 |
| `apps/dashboard/components/views/overview.tsx` | G90 的锚点落点 | 实读：`testId="overview-cost-span"` 在 **80 行**，`value={formatUsdSpan(...)}` 在 **81 行**；74–77 行注释写明「锚点就是为了让 DASH 能分辨单元格」 | 同族先例可直接照抄结构 |
| `scripts/e2e/run.mjs` DASH 步骤 | G90 的断言本体 | 实读：DASH 步骤起于 **778 行**；`testIdText()` helper 在 **197 行**；真价差 fixture `band = { usd: 0.012345, low: 0.01, high: 0.02 }` 在 **791 行**；守卫在 **833 行**；单元格断言 `overview-cost-span` 在 **857–865 行**；离线态读 `—` 在 **907–908 行** | 现有断言**全部锚在 overview**；`trends` 字面量在 `run.mjs` 里**零命中** ⇒ 盲区①**已被实读证实** |
| `apps/dashboard/test/cost-span.test.ts` | —（N4 实读补充） | 实读：6 位点在 **25/32 行**；单边缺失在 **43–47 行**，即 `assert.equal(formatUsdSpan(0.01, undefined), "$0.01")` **确实存在** | **⚠ 与 BACKLOG ⑧ 的原文不一致**，见下条 |
| `apps/dashboard/lib/format.ts` | 精度规则 | 实读：`formatUsd` 在 **20 行**，精度分支 `digits ?? (micros % 100 === 0 ? 4 : 6)` 在 **25 行**；`formatUsdSpan` 在 **49 行**，单边缺失时**返回 floor**（`format.ts:51–52`） | 6 位规则本体在 helper；**页面级取证确实缺位**（盲区②成立） |

**两处必须如实说明的偏差（以实读为准）**：

1. **`trends.tsx:58` 一致**——侦察报告与 G90 卡的行号**正确**，无需按实读更正；但要写清「58 行是 value 表达式、单元格是 56–60 行」，避免下一个 Worker 把锚点挂错位置。
2. **BACKLOG ⑧ 的原文「`formatUsdSpan` 单边缺失（low 有 high 无）无数据覆盖」已部分过期**：`apps/dashboard/test/cost-span.test.ts:47` **已经有**一条 helper 级断言覆盖该分支（同文件 43–46 行注释还标注它是「API 类型下不可达、按 R208 声明为未覆盖分支」）。因此本卡若纳入该项，**须把口径改写为「缺的是数据级/页面级覆盖，不是 helper 级覆盖」**，否则会重复劳动。⚠ 这条改写属于对 `AGENTS.md` BACKLOG 措辞的更正，**本卡不做**（本轮禁止改既有文件）；留作开做时的附带裁决项。
3. **一处相邻观察（明确不在本卡范围）**：同文件 `trends.tsx:104` 的「按天明细」表右列渲染 `formatUsd(point.costUsd)`——**逐字是点估计**。它是否也该改用区间表达，**不是本卡要回答的问题**（本卡只针对 58 行的**区间成本单元格**）。此处仅记录实读所见，**不扩大范围、不预设结论**。

## 证据与指针

| 证据 | 落点 |
|---|---|
| 侦察报告 §2（「Dashboard 区间验证切片」到底是什么） | `E:\DeepSeek_Harness\workspace\2026_09_04\modelinfra-mission-01\recon-report.md`（§2.1/§2.5 明写「同类盲区只关掉一半」） |
| 侦察报告 §5（Mission 提案 / DoD / WorkSet） | 同文件 §5.1 一句话 Mission、§5.2 的 **E1/E2**、§5.3 的 **W2/W3/W4**（本卡即 W2+W3（+可选 W4）的登记） |
| 同族先例卡（**只读格式参考**） | `tasks/EVO-G90-dashboard-band-assertion.md`（其第 65 行就是本卡的来源登记） |
| 6 位精度未取证的自陈 | `DSH_RECOVERY_REPORT.md` §4.1（该文件**未跟踪**，**本卡不触碰它**） |
| 权威状态文件的「未关闭（登记）」 | `docs/product-evolution.md` 的 `## EVO-G90 收尾（R260）` 节（第 396 行起；未关闭项在第 408 行） |
| 断言与锚点本体 | `scripts/e2e/run.mjs`（DASH 步骤 778–930 行、`testIdText()` 197 行）、`apps/dashboard/components/ui.tsx`（`StatCard` 78–107 行）、`apps/dashboard/components/views/trends.tsx`（56–60 行） |
| 精度规则本体 | `apps/dashboard/lib/format.ts:20`（`formatUsd`）与 `:49`（`formatUsdSpan`） |

## 不能破坏什么（同 G90 的边界，逐条沿用）

- **G89 的弃用取向**不得回退（见「范围与不做」）。
- **`formatUsd` / `formatUsdSpan` 的既有呈现与其他视图逐字不变**；`testId` 保持**可选**。
- **e2e 其余步骤不变**；`usage export` 的 22 列与前 15 列字面量锁不受影响。
- **金额仍以整数微美元为真源**。
- **既有测试全绿**；两侧 `tsc` 0；字典 zh/en 对等；看板测试与 typecheck 不破。

## 范围纪律

- 本卡**只登记，不实现**。任何「顺手把 trends 也改了」的动作都属**越权**——它需要先由指挥把本卡从「候选」转为「在办」。
- 若开工时发现卡内现状与代码不符，**以代码为准并在报告中申报**（R197），**不要**按本卡的描述去改代码迎合卡。
- 若断言要成立必须改 `packages/mik` 运行时或公共契约 → **停下上报**（新裁决），不要在验证片里夹带功能变更。
