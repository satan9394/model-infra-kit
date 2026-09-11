# 成本对账（Cost Reconciliation）

> 只读资产。目的：让宿主人**自证**「为什么这笔是 $0.0002475」，并在供应商账单与本地账本不一致时，按本文的清单逐项定位差异来源，而不是靠猜。
> 相关契约：`docs/interfaces.md`（`CostInfo`、`budget`）、`docs/SPEC.md` §4（`TokenUsage` 语义）。
> 定位参考：LiteLLM 的 cost discrepancy 指南（同源做法：把口径与排查步骤写成文档，不引入其运行时依赖）。

本模块只做**本地计量与计价**：不读第三方应用的数据文件，不做网关级计费，也不改供应商账单。

## 1. 计量口径：哪些 token 计入成本

一次请求落库的行里有五个计数（`TokenUsage`）与一个金额（`CostInfo`）：

| 字段 | 来源（AI SDK） | 计价方式 |
|---|---|---|
| `input` | `usage.inputTokens` | 输入总量（**含**缓存部分），未命中缓存的输入按输入单价 `inputPerM` |
| `output` | `usage.outputTokens` | 输出总量（**含** reasoning），按 `outputPerM` |
| `cacheRead` | `inputTokenDetails.cacheReadTokens` | 缓存读取，按 `cacheReadPerM`；手动价未给该字段时回退到输入价（`pricing/service.ts:328`） |
| `cacheWrite` | `inputTokenDetails.cacheWriteTokens` | 缓存写入，按 `cacheWritePerM`；回退规则同上 |
| `reasoning` | `outputTokenDetails.reasoningTokens` | **通常不再单独计费**：MIK 传给 llm-pricing 时固定 `reasoningIncludedInOutput: true`（`pricing/service.ts:263`），即 reasoning 已含在 `output` 里，重复加价会高估 |

两条关键语义（`docs/SPEC.md` §4）：

- **公开的 `TokenUsage` 是总量**：供应商没报的计数记为 `0`。
- **送给计价器的 `Partial<TokenUsage>` 保留缺失**（`undefined` 不等于 0）。llm-pricing 能区分「没报」与「报了 0」，因此缺失计数不会凭空变成 0 价。
- `usage` 与 `cost` 相互独立：`cost` 由 `PricingService.estimate()` 在调用结束后算出并随行存储，**不重算历史行**。改价目表不会追溯改写已落库的金额。

计价单位：所有 `*PerM` 都是 **USD / 1,000,000 tokens**；`ModelPricing` 里的 `inputPerM`/`outputPerM`/`cacheReadPerM`/`cacheWritePerM` 即价目卡片换算后的每百万 token 价（`perMillion(card.*CostPerToken)`）。

## 2. 计价优先级与 `cost.source` / `cost.basis`

优先级（`pricing/service.ts:86`，高 → 低）：

1. **手动价**：`pricing_overrides` 表（`mik pricing set`），`source: "manual"`、`basis: "manual"`。
2. llm-pricing 自带 overrides（目录内嵌的官方调整）。
3. 在线目录：models.dev（`source: "modelsdev"`）。
4. 内置 archive 兜底（`source: "fallback"`）。

`estimate()` 先查手动价再 `warm()` 目录：手动价命中时**不会**触发任何网络加载（`pricing/service.ts:143-147`），所以断网也能得到确定金额。

`CostInfo.source`（价从哪来）：`"manual"` | `"override"` | `"modelsdev"` | `"openrouter"` | `"fallback"` | `"missing"`。
`CostInfo.basis`（价有多精确）：`"manual"` | `"exact"`（按当时有效的价目精确匹配）| `"flat"`（单一档位，不分时段/上下文）| `"blended"`（多档混合，例如长上下文阶梯）。
`CostInfo.pricingModel` 记录**实际用来定价的模型 id** —— 它可能与 `model_actual` 不同（别名/归一化），这是排查时最容易忽略的一列。
`cost.low` / `cost.high` 是不确定时的保守区间（另存 `cost_low_usd` / `cost_high_usd`）；对账以 `cost.usd` 为主口径。

**缺价行为**：目录里查不到该模型 → `cost = { usd: 0, low: 0, high: 0, basis: "flat", source: "missing", pricingModel: <请求的模型> }`，并按模型经 `onWarn` 提示一次（进程内去重，上限 1000 个模型，防止逐请求的日期化模型 id 撑爆内存）。**`source: "missing"` 的行金额 0 不代表这次调用免费**，只代表本地没有价。

## 3. 金额精度：为什么是整数微美元

- 账面单位是**整数微美元**（1 µUSD = 1e-6 USD），SQL 聚合一律
  `SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER))`。
- 禁止 `SUM(CAST(cost_usd AS REAL))`：浮点求和在几十万行量级会累积出可见的分位漂移，且同一份数据在不同聚合路径（明细行 / 日汇总 / 看板）下会得到不同结果。
- 行级换算同样是 `ROUND(usd * 1e6)`，与 SQL 的取整语义一致；累计只做**整数加法**（预算累计同理）。
- 展示层（`formatMoney`、看板）在最后一刻才除以 1e6 并四舍五入。**不要在中间步骤还原成美元浮点**。
- 量化的边界：单行成本小于 0.5 µUSD（约 $0.0000005）会被舍入到 0。只有当单价低于约 $0.0005 / 1M tokens 且单请求 token 极少时才会出现，届时本地会系统性**略低**于供应商账单。

## 4. 排查清单（可执行）

> 目标：给定供应商账单上的一个数字，定位到本地某一行并解释差额。

1. **定位那一行**
   ```bash
   mik usage logs --limit 20            # 可加 --provider <id> --model <id> --status ok|error
   mik usage logs --from 2026-03-01 --to 2026-04-01 --app <appId>
   ```
   记下 `requestId`、`model_requested` / `model_actual`、五个 token 计数、`cost_usd`、`pricing_model`、`pricing_source`、`pricing_basis`。

2. **导出原始行核对**（CSV 列顺序是契约，含 `pricing_source`/`pricing_basis`）
   ```bash
   mik usage export --format csv --out usage.csv --from 2026-03-01 --to 2026-04-01
   ```
   导出行数上限 240000；被截断时 CLI 会在 stderr 明确告警，请用 `--from/--to` 收窄。

3. **查当前生效价目**
   ```bash
   mik pricing list                     # 手动价清单 + catalogue 状态（fresh / stale / error）
   mik pricing sync                     # 目录过期时先拉一次（离线环境会降级为 archive）
   ```
   想用供应商协议价复现某一行：
   ```bash
   mik pricing set <modelId> --input <$/1M> --output <$/1M> [--cache-read <$/1M>] [--cache-write <$/1M>]
   ```
   `set` 至少要有 `--input` 或 `--output`（否则每次请求都会记成 $0，属于契约禁止的配置）。改完**重发一次同样的请求**再对比新行；历史行不会被改写。

4. **手算微美元**
   `micros = ROUND(input/1e6*inputPerM) + ROUND(cacheRead/1e6*cacheReadPerM) + ROUND(cacheWrite/1e6*cacheWritePerM) + ROUND(output/1e6*outputPerM)`；
   与行内 `cost_usd * 1e6` 比对（注意 `input` 已含 `cacheRead`/`cacheWrite` 时，非缓存输入应按 `input - cacheRead - cacheWrite` 理解）。
   若 `pricing_source = "missing"`，先回到第 3 步补价，其它比较都没有意义。

5. **时间对齐（月账单差异的头号来源）**
   - 行内 `ts` 是**毫秒 UTC** 时间戳；`usage summary/trends/logs` 的 `--from/--to` 由 `parseTime` 解析为同一时间轴上的毫秒值。
   - 账本与日汇总的分日一律按 **UTC 日界**：`strftime('%Y-%m-%d', ts/1000, 'unixepoch')`；预算窗口（`budget.window`）同样是 UTC。
   - 供应商账单通常按**其自身时区/账期**切分。跨零点、跨月的差额优先怀疑这里，而不是单价。

6. **常见差异来源（逐项排除）**

   | 现象 | 常见原因 | 怎么确认 |
   |---|---|---|
   | 本地偏低 | 命中缓存：`cacheRead` 单价通常是输入的 1/10，而某些供应商把缓存输入直接并入 input 计价 | 看 `cacheRead` 占比与 `pricing_source`；按第 3 步用手动价校准 |
   | 本地偏低 | 模型缺价：`source: "missing"`，本地记 0 | `mik pricing list` 是否覆盖该 `pricing_model` |
   | 本地偏高 | reasoning tokens 被供应商单列、不并入 output，而 MIK 按「已含在 output」处理（`reasoningIncludedInOutput: true`） | 对比行内 `output` 与 `reasoning`，以及供应商明细里的 output 口径 |
   | 任一方向 | 供应商折扣 / 阶梯价（企业协议价、长上下文 tier、批量价） | `pricing_basis` 是否为 `flat`/`blended`；用 `pricing set` 覆盖后复算 |
   | 任一方向 | 模型别名：`model_requested` 与 `model_actual`/`pricing_model` 指向不同价格档 | 三列一起看，别只看请求的模型名 |
   | 本地偏高/偏低 | 失败或中断的调用：本地按 `status: "error"` 记 `cost 0`，供应商可能按已产生的 token 计费 | `mik usage logs --status error` |
   | 本地偏低 | 同一逻辑请求被重试（SDK 重试各落一行），只对上其中一行 | 按 `requestId`/时间相邻行对照 |

7. **与预算告警的关系**
   - `budget` 用的是**同一套行级 `cost_usd`**（整数微美元）：`ModelInfraConfig.budget.usd` 是本窗口内本 appId 的阈值。
   - 因此「预算越阈」≠「供应商账单越额」，二者只共享口径，不共享账期：预算窗口是 **UTC** 日/月界，账单可能是别的时区或自然月。
   - 预算基数在 `init()` 时一次性汇总（`UsageRepository.costMicros()`，只统计明细行 `usage_events`，按 `ts` 落在 `[窗口起点, now)`）。已折叠进 `usage_daily_rollups` 的老数据不计入基数：这只可能让告警**晚一点**发生，不会误报。
   - 语义是**只告警、绝不硬拒绝**（不阻断、不排队、不限流），越阈每条窗口每个 appId 最多一条 `onWarn`；详见 `docs/interfaces.md` 的 `budget` 契约节。
