# 项目交接与即时状态（Handover & Project Status）

> **给接管 Agent（Codex / Claude Code / OpenCode / Antigravity）的快速指南**：
> 当用户询问 **「进度如何、该做什么」** 时，直接读取本文件即可获取项目当前全貌与下一步清晰行动指令。

---

## 一、进度如何（Current Progress）

### 1. 当前版本与代码状态
- **Git HEAD**：`041a55d`（分支 `main`）
- **发布状态**：**本地已提交、未 push、未发布 npm**（严格遵循人类发布闸门铁律，待功能充分稳定后由用户裁决发布 `v1.1.0`）。
- **工作区代码**：干净（Clean），所有大熔炉核心代码已入库。

### 2. 最近完成的里程碑（G92 ~ G96 大熔炉演进全量交付）
吸收 models.dev、LiteLLM、New-API、Portkey、Langfuse、Vercel AI SDK 等开源基建能力，完成五大能力切片闭环：
1. **EVO-G92（点估计清零）**：
   - `UsageTrendPoint` 与 `UsageBucket` 扩展 `costLowUsd`/`costHighUsd` 区间；
   - 看板移除全部 5 处点估计遗留，最贵一天改为按下限真实排序。
2. **EVO-G93（模型机架与能力元数据）**：
   - 引入 `packages/mik/src/catalog/` 与 `mik.catalog` 查询门面；
   - 解耦模型事实（静态上下文/价格/能力）与 Provider 端点映射，内置 7 款前沿模型；
   - 交付 CLI `mik models catalog`、API `GET /api/catalog` 与看板 `/models` 页面。
3. **EVO-G94（动态价格同步与 GPT-6 阶梯计费）**：
   - 引入 `tiers.ts` 与 Schema v3 `pricing_cache`；
   - 支持 GPT-6 Luna 90% 缓存读取折扣（$0.01/1M）、1.25x 写入倍率、独立 Thinking Token 计费与长上下文阶梯费率；
   - 价格同步异步后台运行，失败仅告警，绝不阻塞应用初始化。
4. **EVO-G95（Agent 自愈路由与 Key 轮换）**：
   - 引入 `router/` 与内存态 `KeyPool`，多 Key 轮换，遭遇 429 自动进入 30 秒冷却；
   - 支持首字超时（TTFT > 120s）SSE `: thinking` 心跳保活与 fallback chain 模型降级管道；
   - 密钥永不落库，用量数据仅记录脱敏引用与 `is_fallback=true`。
5. **EVO-G96（Agent Trace 成本看板与多语言接入）**：
   - Schema v4 引入 `trace_id` 与 `usage_trace_rollups`，支持按 session/trace 聚合；
   - 交付 `/traces` 页面与任务调用链路视图；
   - 编写 OpenAI SDK、Python 与 LangChain 适配示例（`examples/langchain-python/`）。

### 3. 当前运行中的服务（持续监听中）
- **API 代理服务**：`http://127.0.0.1:3211`（Node PID 31420）
  - OpenAI 兼容调用：`POST http://127.0.0.1:3211/v1/chat/completions`
  - 模型目录查询：`GET http://127.0.0.1:3211/api/catalog`
  - Trace 链路查询：`GET http://127.0.0.1:3211/api/usage/traces`
- **Web 可视化看板**：`http://localhost:3210`（Next.js PID 14912）
  - 总览视图：`http://localhost:3210/`
  - 模型机架：`http://localhost:3210/models`
  - 任务链路：`http://localhost:3210/traces`

### 4. 门禁验证现状（全部 100% 通过）
- **类型检查**：
  - `pnpm --filter model-infra-kit typecheck` → **0 错误**
  - `pnpm --filter @mik/dashboard typecheck` → **0 错误**
- **单元与集成测试**：
  - `pnpm --filter model-infra-kit test` → **44 文件 / 731 例全绿**（在 `zh_CN.UTF-8` 与 `en_US.UTF-8` 双环境独立运行通过，未设 `MIK_LANG`）。
  - `pnpm --filter @mik/dashboard test` → **18/18 全绿**。
- **端到端测试**：
  - `node scripts/e2e/run.mjs` → **12/12 PASS，exit 0**（AC1~AC8、PRICE、EX1、DASH、DIST 全绿；看板 overview/trends 渲染真实价差区间 `$0.034301 ~ $0.044301`）。
- **打包构建**：
  - `pnpm --filter model-infra-kit build` → 成功产出 `dist/`。

---

## 二、该做什么（Next Steps & Action Plan）

### 第一优先级任务：EVO-G97 看板 UI 质感与浅色模式重塑
- **任务卡**：[`tasks/EVO-G97-dashboard-ui-redesign.md`](tasks/EVO-G97-dashboard-ui-redesign.md)
- **立项背景**：用户反馈当前看板纯暗色（Dark Only）过于单调生硬，存在 AI 模板感，白天或高亮光照下难以使用，需引入专业的 Light Mode 并重构视觉质感。
- **参考技能支持（Star Skill 库，只读引用）**：
  - 公共源库路径：`E:\dev-workspace\workspace\2026_08_25\`（**严禁修改源库，禁止将文件夹拷贝进本项目**）。
  - 已通过软链挂载至 Codex 环境的技能：
    1. `tailwind-design-system`：Tailwind v4 CSS-first 配置规范，OKLCH 语义化设计令牌。
    2. `frontend-design`：拒绝 AI 模板感的专业审美规范，调色、留白与字阶体系。
    3. `design-system-patterns`：React 主题 Context、LocalStorage 缓存与系统级切换。
    4. `kpi-dashboard-design`：监控指标排版、`tabular-nums` 数字对齐。
    5. `theme-factory`：高品质浅色调色板。
- **改动范围**：
  - `apps/dashboard/app/globals.css`：定义 `@theme` 变量，支持 `.dark` 变体与清晰浅色背景。
  - `apps/dashboard/components/nav.tsx`：增加 Light / Dark / System 三态切换开关。
  - `apps/dashboard/components/overview.tsx`、`trends.tsx`、`apps/dashboard/app/models/page.tsx`、`apps/dashboard/app/traces/page.tsx`：适配语义化类名。
  - **重要约束**：**不得删除任何 `data-testid` 锚点**（如 `overview-cost-span`、`trends-cost-span`），确保 E2E 断言始终通过。
- **验证命令**：
  ```bash
  pnpm --filter @mik/dashboard typecheck
  pnpm --filter @mik/dashboard test
  node scripts/e2e/run.mjs
  ```

### 第二优先级任务：外部 Agent 真实调用与链路验证
- 通过 `examples/langchain-python/agent.py` 或自研 Agent 客户端，向本地 `http://127.0.0.1:3211/v1` 发起真实复杂请求（包含 Reasoning / 429 降级 / 缓存命中场景）。
- 打开 `http://localhost:3210/traces` 检查任务耗时、思考 Token 与成本区间的实时记录。

### 第三优先级任务：发版与发布决策（人类闸门）
- 当 EVO-G97 完成、端到端与业务验证均充分稳定后：
  1. 更新 `package.json` 版本至 `v1.1.0`；
  2. 运行 `git push origin main`；
  3. 待 CI 三 OS 全绿后执行 npm 发布与 GitHub Release。

---

## 三、关键架构与开发铁律（必背）

1. **金额计算铁律**：所有成本金额在内存与 SQLite 中必须以**整数微美元（micros, 1 USD = 1,000,000 micros）**存储与累加，严禁浮点求和；最终展示由 `formatUsd` / `formatUsdSpan` 统一格式化。
2. **密钥安全铁律**：API 密钥只存脱敏引用（`api_key_ref`），永不入库，响应和日志统一走 `redact.ts`。
3. **环境与测试铁律**：测试在多语言下验证时，只设 `LC_ALL`/`LANG`，**绝不全局设置 `MIK_LANG`**（否则特定向导测试会因语言锁死而假红）。
4. **删除铁律**：所有删除操作一律走 Windows 回收站 API，严禁执行 `rm -rf`、`del /f` 或 `Remove-Item`。
5. **Star Skill 库只读铁律**：`E:\dev-workspace\workspace\2026_08_25\` 为系统公共中枢，只能通过符号链接（`stars.py deploy`）挂载使用，生成的所有代码文件必须保留在当前项目内。
