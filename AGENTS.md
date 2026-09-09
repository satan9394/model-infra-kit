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

## 当前状态

见 `tasks/`。T01 已完成（骨架 + 存储 + 凭据，16/16 测试绿）。
