# AGENTS.md — model-infra-kit

> 本文件是项目级规则。任何 Worker（子代理/子会话）动手前必须读本文件 + `docs/SPEC.md` + 自己的任务卡。

## 项目定位

`model-infra-kit` 是一个**可嵌入任意 AI 项目的模型层**：装进宿主项目后，立刻获得多供应商调用、模型目录、token 用量、模型计价与成本统计，外加一个独立看板。

它不是网关平台、不是企业级 AI Gateway、也不读任何第三方应用的数据文件。

## 技术栈（不要换）

- Node ≥ 22（本机 24.14），ESM，TypeScript strict
- 包管理 pnpm 11（workspace）
- 构建 tsdown，测试 vitest，类型检查 `tsc --noEmit`
- 核心依赖：`ai`（Vercel AI SDK v7）、`llm-pricing`（MIT）、`node:sqlite`
- 看板：Next.js App Router + Tailwind + Recharts

## 目录结构

```
model-infra-kit/
├─ packages/mik/          主包（唯一要发布的包）
│   ├─ src/registry/      供应商注册表 + 预设
│   ├─ src/credential/    凭据引用解析
│   ├─ src/ai/            AI SDK 桥接（协议/模型解析/连接测试/模型发现）
│   ├─ src/pricing/       llm-pricing 封装
│   ├─ src/usage/         计量与查询
│   ├─ src/store/         SQLite 仓储与迁移
│   ├─ src/fetch.ts       mik.fetch / mik.baseUrl
│   ├─ src/server/        子路径导出 mik/server
│   └─ src/cli/           子路径导出 mik/cli
├─ apps/dashboard/        Next.js 看板
├─ examples/              接入示例
├─ docs/                  决策与契约（SPEC.md / interfaces.md / decisions.md）
└─ tasks/                 任务卡（看板）
```

## 端口约定

- 看板 **3210**，HTTP 服务 **3211**（均可在配置覆盖）
- 已被本机其它项目占用、禁止使用：3080 / 3001 / 3111 / 8899
- 起服务前先 `netstat -ano | findstr :<端口>` 确认

## 命令

```bash
pnpm --filter model-infra-kit typecheck   # 必须 0 错误
pnpm --filter model-infra-kit test        # 必须全绿
pnpm --filter model-infra-kit build       # tsdown 打包
```

## 硬性规则（违反即打回）

1. **不读第三方应用的数据**。不扫描 `~/.codex`、`~/.local/share/opencode`、`~/.claude` 等目录。用量数据由本模块自己产生。
2. **金额一律整数微美元累加**。禁止 `SUM(CAST(cost AS REAL))` 这类浮点求和；SQL 聚合用 `CAST(ROUND(x*1000000) AS INTEGER)`。
3. **协议是一等公民**。适配器按 `protocol` 数据映射选，禁止 `if (providerId === "deepseek")` 这类分支；供应商差异只能进 `provider.meta`。
4. **密钥永不落库、永不进日志**。provider 只存 `api_key_ref`；日志/响应统一走 `src/util/redact.ts`。
5. **不改公共接口而不改契约**。`docs/interfaces.md` 是跨 Worker 的接口契约；需要变更先在卡里说明并更新该文件。
6. **不阻塞启动**。目录/价格上游拉取失败只降级 + 告警，不能让 `ModelInfra.init()` 抛错。
7. **`_research/` 只读**。那是参考仓库克隆，不修改、不依赖、不打包。
8. **删除必须进回收站**，禁止 `rm -rf` / `Remove-Item -Force` 彻底删除。
9. **每个 Worker 必须自证**：改完跑 `tsc --noEmit` + **自己那张卡的测试文件**，并把命令与真实输出贴进交证报告。没有证据视为未完成。
10. **并行 Worker 只跑自己的测试**：`pnpm exec vitest run test/<你的卡>.test.ts`。全量套件由指挥在卡收齐后统一跑，避免互相看到对方半成品。
11. **禁止 `Remove-Item`**：本机钩子会拦截（报「删除必须进回收站」）。清环境变量用 `$env:X=""`；删文件走回收站 API。

## 交证格式（Worker → 指挥）

```
【卡号】T0X
【改动】文件清单 + 一句话说明
【证据】typecheck 输出摘要 / test 输出摘要 / 关键 SQL 或行为验证
【偏差】与契约或卡片的差异，没有就写“无”
【风险】需要指挥决策的点，没有就写“无”
```

## 复盘（教训，别重犯）

- **契约缺陷会以强转的形式暴露**：T02 测试里出现 `as unknown as ProviderConfig`，根因是我在 T01 把 `ProviderConfig.protocol` 定成了必填，而 preset 本来就会补。已改成可选 + 存储层兜底。**看到 `as unknown as` 就去查契约，别在调用点打补丁。**
- **并行 Worker 不要跑全量测试**：T02 写一半时指挥跑 typecheck 被它的半成品测试报错污染，误判 T04。规则已进第 10 条。
- **重派子代理要补前提**：首次派 T02/T03 两个 Worker 均无产出即失败（通道本身正常，探针验证过）。补上「`@ai-sdk/*` provider 已随 peer 自动安装」后一次通过——**派活时把本机事实写进简报，能显著降低失败率**。
- **先探针再派活**：派 T05 前用 `.tmp/spike-ai.mjs` 实测出「`cacheWriteTokens` 可能 undefined」这类关键事实，避免了 T05 猜错映射。
- **并发上限 = 2**：一次派 5 个实现 Worker（F01–F04 + T07）**全部立即失败、零产出**；同一批卡单发或 2 并发则正常。派活规则：**最多 2 个实现 Worker 同时在线**，超出就排队。
- **阻断级先修**：评审出的 B1/B2 要单独发卡、单独验证，不要和一堆建议级混在一张卡里（会被稀释）。

## 当前状态

见 `tasks/BOARD.md`。T01–T04 已完成并通过指挥独立验证（全量 81/81，`tsc --noEmit` 0 错误）。
