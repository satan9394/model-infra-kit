# 架构图（Archify 生成）

本目录由 [Archify](https://github.com/tt-a1i/archify) v3.0.1（MIT）生成，用于把 `model-infra-kit`
的整体逻辑架构、关键流程与状态机可视化。**每张图都带源码证据**：节点/参与者的 `sources`
指向仓库内真实文件与行号，并固定在以下提交上。

- **仓库**：`https://github.com/satan9394/model-infra-kit`
- **钉住的提交**：`267628ee741b44d5e9e188b833d6f643dd5864ce`（本地 `main`，EVO-G134）
- **版本**：1.7.0
- **生成工具**：`.agents/skills/archify/`（随仓库版本化）

每张图都用同一条命令产出，四个门（validate / deliver / check / browser-check）全绿：

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node .agents/skills/archify/bin/archify.mjs finalize <type> \
  .archify/<workdir>/candidate.json docs/diagrams/<name>.html \
  --repo-root . --quality showcase --json
```

## 索引

| 图 | 类型 | 回答的问题 | 定稿 HTML | 可编辑源 | PNG | 回执 |
|---|---|---|---|---|---|---|
| 整体逻辑架构 | architecture | 三种接入面如何汇聚到一个门面，门面下有哪些能力服务与持久化/出网边界 | [architecture-overview.html](architecture-overview.html) | [architecture-overview.json](architecture-overview.json) | [PNG](png/architecture-overview.png) | [finalize](architecture-overview.finalize.json) · [browser-check](architecture-overview.browser-check.json) |
| 一次生成请求的主流程 | sequence | `/v1/chat/completions` 从鉴权、选路、调用上游到计价落账的完整往返 | [sequence-generate-request.html](sequence-generate-request.html) | [sequence-generate-request.json](sequence-generate-request.json) | [PNG](png/sequence-generate-request.png) | [finalize](sequence-generate-request.finalize.json) · [browser-check](sequence-generate-request.browser-check.json) |
| 降级与轮换裁决 | workflow | 哪几类失败会换 Key / 换候选，哪几类直接判终局 | [workflow-failover-decision.html](workflow-failover-decision.html) | [workflow-failover-decision.json](workflow-failover-decision.json) | [PNG](png/workflow-failover-decision.png) | [finalize](workflow-failover-decision.finalize.json) · [browser-check](workflow-failover-decision.browser-check.json) |
| 用量与成本数据管线 | dataflow | 从一次调用到账本、折叠与只读出口的数据流向与里程 | [dataflow-usage-pipeline.html](dataflow-usage-pipeline.html) | [dataflow-usage-pipeline.json](dataflow-usage-pipeline.json) | [PNG](png/dataflow-usage-pipeline.png) | [finalize](dataflow-usage-pipeline.finalize.json) · [browser-check](dataflow-usage-pipeline.browser-check.json) |
| 供应商熔断器生命周期 | lifecycle | 被动健康的 CLOSED → OPEN → HALF_OPEN 状态机与单探针不变量 | [lifecycle-circuit-breaker.html](lifecycle-circuit-breaker.html) | [lifecycle-circuit-breaker.json](lifecycle-circuit-breaker.json) | [PNG](png/lifecycle-circuit-breaker.png) | [finalize](lifecycle-circuit-breaker.finalize.json) · [browser-check](lifecycle-circuit-breaker.browser-check.json) |

> 定稿 HTML 是自包含的（内联 SVG、深/浅主题、可导出 PNG/JPEG/WebP/SVG）。用浏览器直接打开即可，
> 不需要起服务。`.finalize*.json` / `.delivery.json` / `.browser-check.json` 是逐门的验证回执。

### PNG 位图（`png/`）

同时提供每张图的位图版，便于贴进文档、PR 或聊天工具。它们是**产物自身**「导出 → PNG」的
结果（同一 Chrome、浅色主题、含标题行与图例的图表卡样式），不是另画的一套：

| 文件 | 像素 | 体积 |
|---|---|---|
| `png/architecture-overview.png` | 3608 × 2264 | 450 KB |
| `png/sequence-generate-request.png` | 4736 × 3432 | 620 KB |
| `png/workflow-failover-decision.png` | 4736 × 3472 | 480 KB |
| `png/dataflow-usage-pipeline.png` | 4736 × 3192 | 566 KB |
| `png/lifecycle-circuit-breaker.png` | 4932 × 3048 | 575 KB |

> 架构图要比其余四张宽（viewBox 1700 × 954），在 4× 下会超过查看器自带的 16 M 像素画布上限，
> 所以它的导出自动降为约 2×（3608 px 宽），这是查看器 `pickSafeScale()` 的既定行为，非手工缩放。
> 需要更高分辨率时在浏览器里打开对应 HTML 点「导出 → SVG」，SVG 是无损矢量。

## 权威依据

图的语义来自仓库内已批准的文档，不是从代码猜出来的：

- [`../SPEC.md`](../SPEC.md)：定位、三种接入面（§2）、数据模型（§3）、关键口径（§4）、非目标（§5）
- [`../interfaces.md`](../interfaces.md)：跨 Worker 的接口契约与各 EVO 增量
- [`../decisions.md`](../decisions.md)：D1–D9 的取舍理由（协议层、计价、整数微美元、驱动、边界）
- [`../plans/architecture-improvement-plan.md`](../plans/architecture-improvement-plan.md)：基于本套架构图及代码现状分析产出的系统性整改与可靠性加固方案 (RFC)

## 本次可视化发现的文档 / 代码漂移（只报告，未改动权威文档）

做图时必须逐条把「文档里的说法」落到真实源码上，于是暴露出下面这些不一致。**均未自行修改**，
仅登记取证命令与事实，等待拍板。

1. **`docs/interfaces.md:400` 的导出计数已过时。**
   原文：`` `PROTOCOLS` … 未进公共面（`src/index.ts` 不 re-export，`dist` 导出数仍为 30） ``。
   实测 `Object.keys(await import('./packages/mik/dist/index.mjs')).length === 42`，且
   `scripts/release/check-release-battery.mjs:17` 的 `EXPECTED_RUNTIME_COUNTS` 也钉在 `".": 42`。
   `PROTOCOLS` 未导出的**结论仍成立**，但「30」这个数字已经漂了 12 个导出（G11 时代写下后未同步）。
   取证：`node --input-type=module -e "console.log(Object.keys(await import('./packages/mik/dist/index.mjs')).length)"`

2. **`docs/SPEC.md` 的标题与「V0.1 非目标」已经名不副实。**
   - `SPEC.md:1` 仍是 `# SPEC — Model Infra Kit V0.1`，但仓库已到 1.7.0，`CHANGELOG.md` 有 1.5/1.6/1.7 三段。
   - `SPEC.md:56`（§5 非目标）列了「智能路由、自动 failover、负载均衡、Key 池、预算限制、RPM/TPM 调度」，
     而当前代码里这些**都已实现**：`src/ai/smart-router.ts`、`src/router/key-pool.ts`、
     `src/router/load-balancer.ts`、`src/usage/budget.ts`、`src/quota/rate-limiter.ts` 均存在且已被
     `hub.ts` / `server/quota.ts` 接线。`decisions.md` 的 D9.3 也把它当作「已生效」。
   取证：`Test-Path packages/mik/src/router/key-pool.ts` 等（五个路径全部 EXISTS）

3. **`docs/SPEC.md:33` 的列名与实际 schema 不一致（同物三名）。**
   原文写 `usage_daily_rollups` 的金额列是 `cost_microusd INTEGER`，
   而实际该表三列是 `cost_microusd` / `cost_low_microusd` / `cost_high_microusd`（`schema.ts:102-104`），
   `usage_events` 上游明细列却叫 `cost_micros` / `cost_low_micros` / `cost_high_micros`（`schema.ts:239`）。
   同一份数据在两处用了 `micros` 与 `microusd` 两种拼写。取业务值时不受影响（每张表各自内聚），
   但跨表手写 SQL 或按 `SPEC.md` 猜列名会失败。
   取证：`Select-String -Path packages/mik/src/store/schema.ts -Pattern 'cost_micro'`

4. **`AGENTS.md:305` 指向一个不存在的 `HANDOVER.md`。**
   仓库根**没有** `HANDOVER.md`（`.gitignore` 只忽略 `RUN_STATE.md`），真实交接文档在 `memory/HANDOVER.md`
   （同文件前面第 8 行写的正是后者）。第 305 行是从旧名（Vessel 时期的根级 `HANDOVER.md`）遗留下来的。
   取证：`Test-Path HANDOVER.md` → `False`；`Test-Path memory/HANDOVER.md` → `True`

5. **仓库卫生（非文档问题）**：`apps/dashboard/app/` 下有 5 个**空目录**
   （`logs/`、`models/`、`pricing/`、`providers/`、`trends/`），真实路由已迁到 `app/(main)/` 下。
   它们不进版本控制也从未被删除，`git status` 看不见空目录，所以一直没人注意到。
   建议清理（走回收站），但属既有状态、非本次改动引入。

## 维护

改了 `packages/mik/src/**` 里与图相关的契约后，图的 `sources` 行号可能漂移。重跑方式：

1. 编辑 `docs/diagrams/<name>.json`（这是唯一的可编辑源）；
2. 用上面那条 `finalize` 命令重新产出 `<name>.html`，`exit 0` 才算通过；
3. 若诊断报 `repository-evidence/line-out-of-range`，说明证据行号已超出该文件行数——按诊断改回真实行号。

Archify 的工作目录（`.archify/`，含 `candidate.json` 与中间态）已加入 `.gitignore`，不入库。
