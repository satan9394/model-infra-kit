# 任务看板

最后更新：2026-09-09

| 卡 | 标题 | 优先级 | 依赖 | 状态 |
|---|---|---|---|---|
| T01 | 骨架 / 存储 / 凭据 | P0 | — | ✅ 已验证 |
| T02 | ProviderRegistry + AI SDK 桥接 | P0 | T01 | ✅ 已验证 |
| T03 | 定价层（llm-pricing 封装） | P0 | T01 | ✅ 已验证 |
| T04 | UsageService（计量门面） | P0 | T01 | ✅ 已验证 |
| T05 | ModelInfra 主类 + fetch 适配器 | P0 | T02,T03,T04 | ✅ 已验证 |
| T06 | CLI | P1 | T05 | ✅ 已验证 |
| T07 | HTTP 服务 + OpenAI 兼容端点 | P0 | T05 | ✅ 已验证 |
| T08 | 用量看板 | P1 | T07 | ✅ 已验证 |
| T09 | 接入示例 + 端到端验收 | P0 | T05,T07 | ✅ 已验证（e2e 10/10） |
| T10 | README 与发布准备 | P2 | T05-T09 | ✅ 已验证 |
| R01 | 对抗日志评审 T02–T04 | P0 | T02-T04 | ✅ 完成（2 阻断 + 15 建议） |
| F01 | T02 修复（B2/S8/S9/S12/漏测） | P0 | R01 | ✅ 已验证 |
| F02 | T03 修复（S1/S2/S3/S4/S14/S10） | P0 | R01 | ✅ 已验证 |
| F03 | T04 修复（B1/S5/S6） | P0 | R01 | ✅ 已验证 |
| F04 | T01 修复（S15 回收站语义） | P1 | R01 | ✅ 已验证 |
| F05 | T05 流式记账时机修复 | P0 | T07 实测 | ✅ 已验证 |
| F06 | `mik serve` dist 路径修复 | P0 | T08 实测 | ✅ 已验证 |
| F07 | OpenAI 端点 system/tools | P0 | T09 实测 | ✅ 已验证 |
| F08 | 后台目录同步噪声 / close 竞态 | P0 | T10 实测 | ✅ 已验证 |
| R02 | 最终对抗日志评审（全量） | P0 | 全部 | ✅ 完成（4 阻断 + 14 建议） |
| F09 | 阻断 B2 + S7：错误/响应密钥泄漏 | P0 | R02 | ✅ 已验证（message 脱敏、cause 保留） |
| F10 | 阻断 B1 + S1：init 有界等待 / close 契约 | P0 | R02 | ✅ 已验证（5s 上限 + STORAGE） |
| F11 | 阻断 B3 + S11/S13：README 与发布物不实 | P0 | R02 | ✅ 已验证（tarball 实装） |
| F12 | 阻断 B4 + S10：e2e 覆盖看板与 dist | P0 | R02 | ✅ 已验证（12/12） |

状态图例：⏳ 待派 / 🔄 进行中 / ✅ 已验证 / ❌ 打回

## 当前指标（最终）

- 主包源码 54+ 个文件；测试 4300+ 行
- `pnpm --filter model-infra-kit test` → **287 passed / 12 files**
- `pnpm --filter model-infra-kit typecheck` → 0 错误
- `pnpm --filter @mik/dashboard test` → 7/7
- `node scripts/e2e/run.mjs` → **12/12 PASS，exit 0**（含 DASH 看板场景与 DIST 发布产物冒烟）
- `pnpm pack` tarball 含 LICENSE + shebang，临时工程安装后 `npx mik --help` 可用

## V0.2 待办（R02 建议级未做的部分）

- S2 删除 provider 不清 `default_model`（悬空后省略 model 的请求 404）
- S3 `enabled:false` 只影响目录同步，仍会被路由
- S4 只读库首次写抛裸 `ERR_SQLITE_ERROR` 且被静默
- S5 429/超时映射缺测试
- S6 放弃的流记成 `ok` + `$0`
- S8 契约漂移：`currentAppId`/`isEnabled`/`splitModelRef`/`PROTOCOL_PACKAGES`/`readOpenAiUsage`/`createMikFetch` 未进 `interfaces.md`
- S9 协议守卫测试只扫 3 个文件
- S13 看板未随包发布（README 已如实说明；`apps/dashboard` 未用 devDep、`check-port.mjs` 的 `PORT=` 仍无效）
- S14 `schema_migrations` INSERT 无 `OR IGNORE`（8 进程冷启动未复现）

## 指挥决策记录

- **T03 注入口**：批准 `PricingServiceDeps` 追加可选 `catalog`/`fetch`。
- **T04 `get()` app 隔离**：批准收紧（B1），`{appId:""}` 才放开。
- **T04 `rollupAndPrune()`**：保持全局语义，仅文档化。
- **T02 providers 表**：全局共享，`list()` 不过滤 appId，仅文档化。
- **T07 追加 `DELETE /api/pricing/:modelId`**：批准。
- **T05 增量成员**（`ai`/`setBaseUrl`/`resolveModel`/`catalogSync`/`ModelInfraOptions.*`）：批准并入契约。
- **F02 `priceFor(model, at?, facts?)`**：批准并入契约。
- **F08 `close(): Promise<void>`**：批准并入契约。
- **看板 appId 过滤缺口**：接受（HTTP 面无 appId 参数，看板只显示当前 app），V0.2 再议。
- **并行纪律**：实现 Worker 并发上限 2；同批 5 个全部失败过一次，已写入 AGENTS.md 复盘。

## 规则

- 一张卡一个隔离 Worker，Worker 只拥有卡里写明的文件。
- Worker 交证后由指挥**独立复跑**验证；大改动另派对抗日志评审。
- 卡完成 → 更新本表 → 由用户验收拍板。
