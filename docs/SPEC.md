# SPEC — Model Infra Kit V0.1

> 已由用户批准。Worker 只读，不要改动本文件；有异议在交证里提。

## 1. 定位

`npm i model-infra-kit` → 宿主项目（自研 CLI Agent、AI 项目、量化项目）立刻获得：

| 能力 | 由谁提供 |
|---|---|
| 多供应商 / 多协议 / 流式 / 工具调用 / usage | Vercel AI SDK `ai@7` + `@ai-sdk/*` |
| 模型目录（能力位、上下文、价格） | models.dev（经 llm-pricing 的 modelsDevSource） |
| 模型名归一化 + 成本计算 | `llm-pricing@0.17` |
| 用量存储与聚合 | SQLite（`node:sqlite`） |
| 可视化 | 自研 Next.js 看板 |

自研只有四块：**ProviderRegistry / CredentialStore / UsageRecorder / UsageRepository**（后两者落在 `src/usage` + `src/store`）。

## 2. 三种接入面

1. **嵌入式库**（主路径）：`ModelInfra.init()` → `mik.generate()` / `mik.stream()` / `mik.usage.summary()`
2. **fetch 适配器**：`new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })` —— 已有代码零改动被计量
3. **本地服务 + OpenAI 兼容端点**：`mik serve --port 3211`，跨语言项目改 `base_url` 即接入

看板 `mik dashboard` 起在 **3210**。

## 3. 数据模型

见 `packages/mik/src/store/schema.ts`。要点：

- `providers` 只存 `api_key_ref`，不存密钥
- `usage_events` 每请求一行，`request_id` 幂等；含四类 token + reasoning、cost/low/high、pricing_source、pricing_basis
- `usage_daily_rollups` 按 (date, app_id, source, provider_id, model) 聚合，金额列是 `cost_microusd INTEGER`
- `pricing_overrides` 用户手动价，优先级最高

## 4. 关键口径（不可自行更改）

**AI SDK usage → llm-pricing 入参**

| llm-pricing | 来源 |
|---|---|
| `inputTokens` | `usage.inputTokens`（含 cache → `inputIncludesCache: true`） |
| `cacheReadInputTokens` | `usage.inputTokenDetails.cacheReadTokens` |
| `cacheCreationInputTokens` | `usage.inputTokenDetails.cacheWriteTokens` |
| `outputTokens` | `usage.outputTokens` |
| `reasoningOutputTokens` | `usage.outputTokenDetails.reasoningTokens`（`reasoningIncludedInOutput: true`） |
| `perRequest` | `true`（逐请求，启用长上下文分档与思考模式） |
| `at` | 请求发起时刻（时间敏感价格精确计价） |

- 字段缺失一律降级为 `undefined`，**不得当作 0**
- 价格优先级：`pricing_overrides（手动）> llm-pricing overrides > 上游目录 > 内置 archive`
- 历史永不重算：事件落库即固化 cost / pricing_source / pricing_basis

## 5. 非目标（V0.1 明确不做）

智能路由、自动 failover、负载均衡、Key 池、预算限制、RPM/TPM 调度、团队管理、云同步、PostgreSQL、embedding、CC Switch 相关能力（跨 agent 导入 / 特殊 cache 计费 / 去重）。

## 6. 验收（唯一场景）

全新安装 → `mik init` → 添加供应商 → 测试连接 → 拉模型 → 设默认 →
① curl 打代理端点完成 generate/stream/tool call；
② `examples/openai-sdk` 用 SDK 零改动被计量；
③ `mik dashboard` 看到记录、成本拆解与价格来源；
④ 断网重启仍可计价（快照兜底，状态 `stale`）；
⑤ 手动改价后历史成本不变、新请求用新价；
⑥ Python 示例打代理端点同样被计量。
