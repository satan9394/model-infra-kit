# 已验证事实（指挥探针产出，Worker 直接用）

> 这些都是本机实际跑出来的，不要再靠猜或联网查文档。

## 1. AI SDK v7 运行时 usage 形状（`.tmp/spike-ai.mjs`，2026-09-09 实测）

`createOpenAICompatible({ name, baseURL, apiKey })` + `generateText({ model: provider("m"), messages })`
对着本地 mock server（返回 `prompt_tokens:1200 / completion_tokens:300 / cached_tokens:800 / reasoning_tokens:64`）跑出来：

```json
{
  "inputTokens": 1200,
  "inputTokenDetails": { "noCacheTokens": 400, "cacheReadTokens": 800 },
  "outputTokens": 300,
  "outputTokenDetails": { "textTokens": 236, "reasoningTokens": 64 },
  "totalTokens": 1500
}
```

要点：

- `inputTokens` 是**含 cache 的总量** → 传给 llm-pricing 时 `inputIncludesCache: true`。
- **`cacheWriteTokens` 可能不存在**（本例就是 undefined）。映射时必须容忍缺失，不能 `?? 0` 之后再当 0 传给 llm-pricing——`cacheCreationInputTokens` 要能区分「缺失」与「0」。
- `reasoningTokens` 已含在 `outputTokens` 内 → `reasoningIncludedInOutput: true`。
- `generateText` 结果同时有 `usage` 与 `totalUsage`；单步时两者相等，多步时用 `totalUsage` 汇总。
- `steps` 数组长度 = 步数。

## 2. AI SDK 导出

- `createProviderRegistry(providers, { separator: ":" })`
- `generateText` / `streamText` / `tool` / `hasToolCall`
- `stepCountIs` 是别名，真名 `isStepCount`（导出表里 `isStepCount as stepCountIs`），用 `stepCountIs` 即可。
- `LanguageModelUsage` 里所有字段类型都是 `number | undefined`。

## 3. 已装依赖（`packages/mik/node_modules/@ai-sdk/`）

`openai`、`anthropic`、`google`、`deepseek`、`moonshotai`、`xai`、`openai-compatible`、`test-server` —— 全部就位（peer 自动安装），可以直接动态 import。

## 4. 本机环境坑

- **禁止 `Remove-Item`**：本机有钩子拦截，报「全局铁律：删除必须进回收站」。要清环境变量用 `$env:X=""`；要删文件走回收站 API。
- 代理端口 7897；本地 mock/服务调用前把 `HTTP_PROXY`/`HTTPS_PROXY` 置空，并设 `NO_PROXY=127.0.0.1,localhost`。
- `node:sqlite` 首次 import 会打一行 ExperimentalWarning，属正常。
