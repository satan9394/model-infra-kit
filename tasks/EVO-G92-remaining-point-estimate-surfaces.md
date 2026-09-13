# EVO-G92 — 看板仍有三类「点估计」成本面，且「最贵的一天」用点估计做排序键

> 卡号 G92（**候选卡：本卡只登记，未实现、未验证、未排期**）· 来源：G91 收尾（Mission 2）时的新发现——M3 独立评审建议 ③ + 指挥实读
> **同族先例**：G89（弃用 `costUsd` 点估计）、G78（未定价不得闭合成点）、`docs/product-evolution.md` 的 `## EVO-G91 交付（R261）`

## 状态（如实登记，**这一节最重要**）

**本卡是候选卡。** 由 Mission 2 在 G91 收口时开卡，**没有实现、没有验证、没有派活、没有改任何代码**。
按本项目教训 **R259「登记 ≠ 队列」**：把本卡读成"已排期"或"已开工"都是误读；是否开做由人类/下一轮 Mission 裁决。
**G91 当轮不修的理由见下「为什么不能顺手修」**——不是遗漏，是它需要产品语义与契约决策。

## 一句话

G89 让产品**自己**不再读被弃用的 `costUsd`，但那只覆盖了 `overview` 的两处**汇总**金额；(G91 补掉了 `trends` 的**区间汇总**格) 之后，看板还有 **5 处成本单元格**在读点估计，其中一处还**用点估计当排序键**。

## 事实（逐条实读，行号为 2026-09-13 的 `f21e785`）

| # | 位置 | 代码 | 性质 |
|---|---|---|---|
| 1 | `apps/dashboard/components/views/trends.tsx:29–30` | `busiest = points.reduce((best, point) => … point.costUsd > best.costUsd …)` | **用点估计做排序键** |
| 2 | `apps/dashboard/components/views/trends.tsx:70` | `value={busiest ? formatUsd(busiest.costUsd) : "—"}`（「最贵的一天」） | 读点估计 |
| 3 | `apps/dashboard/components/views/trends.tsx:111` | `formatUsd(point.costUsd)`（按天明细「成本」列） | 读点估计 |
| 4 | `apps/dashboard/components/views/overview.tsx:182` | `formatUsd(bucket.costUsd)`（按供应商「成本」列） | 读点估计 |
| 5 | `apps/dashboard/components/views/overview.tsx:215` | `formatUsd(bucket.costUsd)`（按模型「成本」列） | 读点估计 |

`grep` 取证（可复核）：

```
$ Select-String -Path apps\dashboard\components\views\trends.tsx -Pattern 'costUsd|busiest'
trends.tsx:29:  const busiest = points.reduce<{ date: string; costUsd: number } | null>(
trends.tsx:30:    (best, point) => (best === null || point.costUsd > best.costUsd ? … : best),
trends.tsx:70:          value={busiest ? formatUsd(busiest.costUsd) : "—"}
trends.tsx:111:                    <Td className="text-right font-mono tabular-nums">{formatUsd(point.costUsd)}</Td>
$ Select-String -Path apps\dashboard\components\views\overview.tsx -Pattern 'costUsd'
overview.tsx:182: {formatUsd(bucket.costUsd)}     # 按供应商
overview.tsx:215: {formatUsd(bucket.costUsd)}     # 按模型
```

## 根因（**在数据层，不在看板**——这条决定了修法）

`packages/mik/src/server/openapi.ts`：

```
UsageTrendPoint (263–271): { date, requests, costUsd, tokens }      ← 没有 low/high
UsageBucket     (272–280): { key, requests, costUsd, tokens }        ← 没有 low/high
```

看板镜像类型同形（`apps/dashboard/lib/types.ts:126` `UsageTrendPoint`、`:122` `costUsd`）。
⇒ 这三类面**在 API 契约里就没有区间**，看板**无法**改成两端表达——想改必须**扩展契约**。

## 为什么它算「缺陷类」而不是纯登记

G89 的取向（`docs/product-evolution.md` 的 EVO-G89 节）是「**产品自己也不再用它**」。上面 5 处仍在用，其中 #1 更糟：**用点估计当排序键**。
在有未定价/被折叠请求的库里，`costUsd` 会**低估**（未定价行记 0、折叠行不可见，见 G78），于是「最贵的一天」**可能选出错的那一天**——与 G78「把未知说成精确」同族，只是载体从汇总变成了排序。

## 为什么不能顺手修（G91 当轮不修的理由）

1. **修法要动 API 形状**：给 `UsageTrendPoint`/`UsageBucket` 加 `costLowUsd`/`costHighUsd` ⇒ 触及 `docs/interfaces.md` 契约与 `packages/mik` 运行时，**不是"验证片"能夹带的改动**。
2. **「最贵的一天」在区间下没有唯一含义**：按 low 排？按 high 排？还是显示成区间并承认"最贵"不可判定？**这是产品语义决策**，G91 卡明确写了"若断言要成立必须改运行时 → 停下上报"。

## 建议（供下一个 Mission 二选一，**本卡不预设结论**）

- **(a) 契约扩展**：`UsageTrendPoint` / `UsageBucket` 各增 `costLowUsd`/`costHighUsd`（**只增不改**，向后兼容）；三处明细改走两端；「最贵的一天」的判据显式写出来（例如按 low 排并在 hint 里给出 high）。需同步 `docs/interfaces.md`、`packages/mik/src/store/usage-repository.ts` 的按天/按桶聚合（金额仍走**整数微美元**铁律）。
- **(b) 呈现层收缩**：明确"按天/按桶的明细只承诺点估计"并把理由写进包内 README 与契约（承认这些面不表达不确定性），同时把「最贵的一天」改成按 `requests` 或直接给区间。

**明确不做**：为未定价请求插值/估算（R232 审计已明确拒绝）。

## 范围与硬边界（若开做）

- 若动契约 → **必须**同步 `docs/interfaces.md`（硬性规则 5）。
- **不回退 G89 的弃用取向**；不改 `costUsd` 的既有填充行为（字段保留、只是不再被产品读取）。
- 金额仍以**整数微美元**聚合（硬性规则 2：禁止浮点求和）。
- 既有断言不得失真；`usage export` 的 22 列与前 15 列字面量锁不受影响。
- 相邻但不属本卡：`/trends` 的**离线态**断言、`testId` 唯一性的机械断言（见 `RUN_STATE.md` 的 Deferred Backlog）。

## 证据与指针

| 证据 | 落点 |
|---|---|
| G91 收尾记录（含本卡的来源） | `docs/product-evolution.md` 的 `## EVO-G91 交付（R261）` |
| M3 独立评审建议 ③ | `modelinfra-mission-02\evidence\M3-verdict.md` |
| 指挥侧实读与红跑 | `modelinfra-mission-02\evidence\{M2-conductor-check.md, M2-anchor-red-run.md}` |
| Mission 2 状态与 Deferred Backlog | `E:\DeepSeek_Harness\workspace\2026_09_08\RUN_STATE.md` |
| 契约本体 | `packages/mik/src/server/openapi.ts:263–280` |
