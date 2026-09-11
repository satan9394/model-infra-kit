# EVO-G07 — 成本对账文档 + 软预算告警（G14）

> 来源：Product Evolution Orchestrator 第 7 轮 vertical slice（竞品调研论证的价值项）。
> 依据：`.tmp/audit-competitor.md` 3.1（软预算：只做告警不做硬执行）与 3.7（成本对账：以文档与口径验证为主，不新增运行时复杂度）。

## 目标

① 让宿主人能**自证**「为什么这笔是 $0.0002475」——把计量与计价口径写成可核对的文档；② 提供**软预算告警**：按 appId 设阈值，累计用量越过阈值时经既有 `onWarn` 告警一次（默认关闭、失败静默、绝不阻塞调用、不做硬拒绝）。

## 用户场景

- 成本敏感的自研项目开发者月底对账时，发现供应商账单与本地账本不一致 → 按 `docs/cost-reconciliation.md` 逐项排查（token 类别、缺价降级、手动价覆盖、时区日界），能自己定位差异来源。
- 开发者希望「这个月别超 20 美元」，又不想被硬限额打断 → 配置 `budget`，越过阈值时在日志/回调里得到一次清晰告警。

## 当前问题（已核验）

- 计价与计量口径存在（整数微美元、`CostInfo.basis/source`、cacheRead/cacheWrite/reasoning 拆分、手动价优先），但**只有零散注释**，没有任何「对账/排查」文档；`cost_source:"missing"`、`0.0000` 这类输出没有解释入口。
- 用量只有事后统计，**没有任何主动信号**；`onWarn`/`onEvent` 通道已存在但未用于阈值告警。

## 理想行为（变更点）

1. **软预算（新增能力，默认关闭）**：
   - `ModelInfraConfig` 新增可选字段（公共接口变更 → 必须同步 `docs/interfaces.md`）：
     ```ts
     budget?: {
       usd: number                  // 阈值（美元，正数）
       window?: "day" | "month"     // 默认 "day"，UTC 边界
       onExceed?: "warn"            // 目前只支持 "warn"（默认）
     }
     ```
   - 语义：每次用量记录后，累计「本窗口内该 appId 的成本」；**首次**越过阈值时经 `onWarn` 告警一次（每进程每窗口最多一次），消息含阈值、当前累计、窗口与 appId（过 `redact`）。
   - **成本实现要求**：累计值必须走项目既有的整数微美元口径（禁止浮点求和）；为守住「不阻塞调用」，累计用内存运行值 + init 时一次性从库汇总（`SUM(CAST(ROUND(cost_usd*1000000) AS INTEGER))` 语义），**不得**在每次调用路径上做全表 SUM。
   - **绝不做**：硬拒绝/RPM/TPM 限流/多进程中心化限额——库形态无法可靠执行，且违反规则 6。
   - 任何失败（配置非法、库汇总失败、运行值异常）→ 静默降级为「不告警」，不影响调用与记录；非法配置在 init 时经 `onWarn` 提示并可忽略该配置。
2. **成本对账文档**（新建 `docs/cost-reconciliation.md`，只读资产）：
   - 计量口径：哪些 token 计入成本（input/output/cacheRead/cacheWrite/reasoning 各自如何计价）、`usage` 与 `cost` 的关系。
   - 计价优先级：手动价 > models.dev 目录 > 内置 fallback；`cost.source`/`basis` 取值含义与「缺价 → cost 0 + source missing + onWarn」行为。
   - 金额精度：整数微美元累加，为什么不做浮点求和；显示层如何四舍五入。
   - **排查步骤清单**：如何用 CLI 复现某一行成本（`usage logs`/`usage export` + `pricing list`）、时间对齐（UTC vs 本地、日界）、常见差异来源（缓存命中未单独计费、reasoning tokens、供应商折扣/阶梯、模型别名指向不同价格档）。
   - 与竞品对照的定位说明（LiteLLM 的 cost discrepancy 指南同源做法，但不引入其运行时依赖）。
3. **文档一致性**：把 `budget` 追加进 `docs/interfaces.md` 的 `ModelInfraConfig` 字段清单与「配置优先级总表」的说明（属 config 入参层，最高优先级）。

## 涉及模块

- `packages/mik/src/types.ts`（`budget` 字段）
- `packages/mik/src/usage/service.ts`（阈值累计与一次性告警；**不改变** `record()` 的返回值与既有事件语义）
- `packages/mik/src/hub.ts`（init 时汇总本窗口基数、把 budget 配置传给 usage 服务）
- `packages/mik/test/usage.test.ts`（或新增 `test/budget.test.ts`）
- `docs/cost-reconciliation.md`（新）、`docs/interfaces.md`（契约同步）

## 不能破坏什么

- 无 `budget` 配置时：**零行为变化、零额外查询**（默认关闭）。
- `record()` 现有契约（返回值、`usage.recorded` 事件、失败不影响调用）与既有 382 例测试。
- 金额口径（整数微美元）与 `CostInfo` 字段语义。
- 启动不阻塞（规则 6）：init 时的汇总失败只告警不抛错。
- 密钥/日志卫生：告警消息过 `redact`，不得泄露密钥或完整 base URL 之外的信息。

## 验收标准

- A1 **越阈告警一次**：配置 `budget:{usd:0.001}`，写入若干用量越过阈值 → `onWarn` 恰好被调用一次，消息含阈值与当前累计；后续再写入**不重复告警**。
- A2 **默认关闭**：不配置 `budget` → 无告警、无新增查询（可用 spy 统计 SQL 次数或注入计数断言）。
- A3 **窗口边界**：`window:"day"` 使用 UTC 日界（可用注入 `now` 或冻结时间测试跨日重置）；`window:"month"` 同理。
- A4 **失败静默**：汇总失败/非法 `budget`（负数、NaN）→ 不抛错、不影响 `record()` 与调用，非法配置经 `onWarn` 提示后可忽略。
- A5 **文档**：`docs/cost-reconciliation.md` 覆盖上述四块口径与排查清单；`docs/interfaces.md` 已补 `budget` 字段（含类型与默认值）。
- A6 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **382** 例起）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

- 库汇总 SQL 失败 → 静默（可选一次 onWarn），预算功能退化为不告警，调用与记录不受影响。
- `budget.usd` 为 0 或负数 / `NaN` → 视为非法，忽略并 `onWarn` 一次。
- 跨日/跨月瞬间写入 → 以 `now` 归属窗口，不得出现「两次告警」或「永不告警」。

## 测试要求

- ≥5 个新用例：A1（含「只告警一次」）、A2（无配置零开销）、A3（日界/月界重置）、A4（非法配置与汇总失败静默）、以及金额口径断言（累计值等于整数微美元换算，不用浮点求和）。
- 时间相关用例必须用注入的 `now`/假时钟，不得依赖真实时间。
- 不得为测试放宽生产默认值。

## 范围外

G09（i18n 扩展）、G10（协议运行时注册）、看板端的预算可视化（可在后续 slice 做）、任何硬限额/限流、任何计量或计价口径变更。