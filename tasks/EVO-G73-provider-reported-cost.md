# EVO-G73 — 让成本口径能对上账单：供应商回传成本（第六种价格来源）

> 来源：**独立竞品调研**（`.tmp/competitor-refresh-2026-09-11.md`）+ 编排者综合（`.tmp/competitor-synthesis-R155.md`）
> 覆盖 GAP：**G73**（编排者裁决 **P1**；研究者主张 P0，见下「为何不是 P0」）

## 目标

当供应商/聚合端点**自己回传了计费额**时，本模块**以它为准**记账，并**明确标注这一笔的口径是「账单」而非「目录估算」**——使「成本对账」（`docs/cost-reconciliation.md` 承诺的能力）在**结构上可闭合**。

## 用户场景

本产品的主用户**大量走聚合/中转端点**（OpenAI 兼容 + 本机 NewAPI 类中转是典型形态）。这类端点的**实际计费价常不等于 models.dev 目录价**——外部实测：目录里 `deepseek-v4-pro` 是 $1.32/M 输入，而 OpenRouter 页面是 $1.12/M（[BerriAI/litellm#39845](https://github.com/BerriAI/litellm/pull/39845)）。

更要紧的是**同类最贵的事故形态**不是「没有成本」，而是「**成本看着对但其实是错的**」：
- Langfuse [#10322](https://github.com/langfuse/langfuse/issues/10322)：把 Gemini 的 `total` 当成 `completion` → **报价高 8.7 倍**
- vercel/ai [#13907](https://github.com/vercel/ai/issues/13907)：缓存 token **按全价计费** → 实际 6 倍

→ 对本产品（卖点是「用量与成本可信」），**「谁说的这个价」必须可见**。

## 当前问题（R158 探到的事实）

- `packages/mik/src/types.ts:20`：`export type PriceSource = "override" | "modelsdev" | "openrouter" | "fallback" | "missing"`
- 该类型经 `packages/mik/src/index.ts:69` **从公共 API 导出** → **加一个取值属于公共 API 变更**（硬性规则 5：必须同步 `docs/interfaces.md`）
- `hub.ts:117` 有 `MISSING_COST`（`source: "missing"`）；`hub.ts:203` 把 `cost: CostInfo` 挂到响应上
- **认知风险（必须一并处理）**：`"openrouter"` 这个取值指的是**价格目录的来源**（价格取自 OpenRouter 的 catalog），**不是** OpenRouter **实际计费额**（`usage.cost`）。**同名不同义**，用户/维护者会误以为「对账已支持」。
- `packages/mik/src` 全量检索 `providerMetadata|costInUsd|total_cost|usage.cost|nativeTokens|reportedCost` → **零命中**（研究者实测）→ 现在**只有算出来的价**。

## 理想行为（最小形态，不得扩大）

1. 适配器解析响应时，**若协议回传了计费额**（OpenAI 兼容体的 `usage.cost`、或 AI SDK 的 provider metadata 中的计费字段），**以它为准**写入该次用量的成本，并标 `source: "provider"`。
2. **未回传时保持现状**（目录价/override/fallback 计算）——**不得**因为「可能不准」而改变现有行为。
3. **单位与币种必须显式归一化，并保留原始值**：
   - 已知形态不统一（LiteLLM 的整数 ticks、OpenRouter 的十进制美元字符串）；
   - **必须**把归一化后的**整数微美元**用于累加（硬性规则 2），**同时**保留原始回传值（用于排查与对账）——**否则「ground truth」会引入新的静默误差**。
4. **异常值不得静默归零**：回传值缺失/非有限/为负/无法解析时，**回落**到现有计算，并把该情形记为 `missing` 或保留原来源——**不得**写 0 当作「免费」。
5. **澄清命名歧义**：在 `docs/interfaces.md` 与 `types.ts` 的注释里写清 `"openrouter"`（目录来源）与 `"provider"`（供应商回传的账单额）的区别。
6. **不引入新概念**：只是 `PriceSource` 多一个取值 + 一条赋值路径，**不加表、不加列**（若确需保留原始值，优先复用既有字段/附加到既有 JSON 列，并在报告中说明）。

## 涉及模块

`src/types.ts`（`PriceSource`）、`src/hub.ts`（成本挂载与 `MISSING_COST`）、`src/ai/`（响应解析，可能 `bridge.ts`）、`src/usage/service.ts`（写入）、`src/pricing/service.ts`（既有 `CostInfo` 通路）、`docs/interfaces.md`（**必须同步**）、`packages/mik/test/`

## 不能破坏什么

- **金额仍以整数微美元累加**（硬性规则 2）；**禁止** `SUM(CAST(cost AS REAL))`。
- **`cost_source` 既有取值语义不变**（`override`/`modelsdev`/`openrouter`/`fallback`/`missing`/`manual`）——只**新增** `provider`。
- **`usage export` 的 CSV 表头不变**（`pricing_source` 列语义不变；新取值只是该列的新值）。
- **未回传计费额时行为逐字不变**（对照基线：改动前的同命令输出）。
- **不静默归零**：缺价仍须显式标 `missing`（既有价值观）。
- 既有 **493** 例测试全绿；`tsc --noEmit` 0。
- **公共导出面**：`PriceSource` 已在公共 API 中；**不得**顺手改其它导出名（G11 教训：用 `dist/index.mjs` 实际导出名核对契约）。

## 验收标准

- **A1（核心）**：用 **mock 供应商回传 `usage.cost`** → 断言该次用量的成本**等于回传值**（按微美元），且 `cost_source === "provider"`；同时断言**原始回传值被保留**（可查）。
- **A2（回落）**：mock **不回传**计费额 → 断言行为与改前**逐字一致**（仍走目录计算，`cost_source` 为原值）。
- **A3（异常值）**：回传 `null` / `"abc"` / 负数 / 极大值 → **不得**写 0 冒充免费；断言回落到目录计算或显式 `missing`，**且不抛异常**（不阻塞宿主，硬性规则 6）。
- **A4（契约）**：`docs/interfaces.md` 已更新（`PriceSource` 取值表 + `"openrouter"` 与 `"provider"` 的语义区别），且**用 `dist/index.mjs` 的实际导出核对**。
- **A5（口径可见）**：`usage summary`/`export` 能区分「目录估算」与「供应商回传」两类笔数（最小形态：`cost_source` 可直接筛）。
- **A6**：`tsc` 0；全量测试在 **zh-CN 与 en-US** 下均全绿（基线 493）；`e2e` exit 0；`check-envs` 三环境 PASS；CI 三 OS 绿。

## 错误场景

- 回传值单位异常（如已是微美元却按美元处理）→ **必须有测试锁定一种已知形态**，并在报告里写明你如何判定单位。
- 回传值与目录价差异巨大 → **仍以回传值为准**（这正是本卡的目的），但需在 `pricing_source`/日志中可辨。
- 流式响应（`stream()`）中的计费额出现在最后一个 chunk → 需覆盖（若难以构造，**明确声明未覆盖及原因**）。

## 测试要求

- ≥6 新用例：① 回传值被采纳（A1）；② 未回传时逐字不变（A2）；③ 异常值不静默归零（A3，**至少 3 种异常**）；④ 单位归一化（同一金额的两种形态 → 同一微美元结果）；⑤ `cost_source === "provider"` 在 `usage logs` 中可见；⑥ 契约测试（`interfaces.md` 与 `PriceSource` 一致）。
- 全部注入 `MIK_LANG`；**不得**读真实 locale。
- **G43 自检**：每条断言在改前必须能红。

## 为何不是 P0（编排者的裁决，须保留理由）

按本仓优先级定义，P0 = 阻碍核心使用 / 严重安全 / 数据风险。本项**不阻碍使用**（产品照常工作、成本照常估算），故定 **P1**。
但它**触及产品核心承诺**（对账可闭合），且有「同类最贵事故形态」的外部证据 → **排在所有 P2/P3 之前**。

## 范围外（明确拒绝，含理由）

- **硬预算拦截/配额调度**（R1）、**智能路由/failover/Key 池**（R2）、**内建 trace/OTel**（R3）、**多租户/团队/充值**（R4）、**embedding/图像/音视频计价**（R5，语义未收敛）、**虚拟 Key/云同步**（R6）——六条均由独立竞品调研给出**针对本产品定位**的理由与证据，编排者全部采纳为 **NOT_NOW**（详见 `.tmp/competitor-synthesis-R155.md` §3）。
- 归属标签（G75）与未定价覆盖率（G74）**各自独立成卡**，不在本卡。
