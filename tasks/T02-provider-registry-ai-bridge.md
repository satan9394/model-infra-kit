# T02 — ProviderRegistry + AI SDK 桥接

**优先级**：P0（阻塞 T05）
**依赖**：T01
**契约**：`docs/interfaces.md` → T02 段，签名不得改动
**拥有文件**：`src/registry/**`、`src/ai/**`、`test/registry.test.ts`、`test/ai-bridge.test.ts`

## 目标

宿主能把「供应商 + API Key 引用」配进来，并用统一的 `provider:model` 拿到 AI SDK 模型；能测试连接、能发现模型。

## 验收标准

1. `PROVIDER_PRESETS` 至少覆盖：openai / anthropic / google / deepseek / moonshotai / xai / openrouter / custom-openai-compatible。每条含 `id,name,protocol,defaultBaseUrl?,npmPackage,envKey?,docUrl?`。
2. `ProviderRegistry.add()`：给了 `presetId` 时自动补全 `protocol`/`npmPackage`/`baseUrl`；未给 `presetId` 且给了 `baseUrl` 时按 `openai-compatible` 处理。
3. `resolve()` 从 `CredentialStore` 拿密钥；密钥缺失抛 `ModelInfraError`，code 为 `CREDENTIAL`；provider 不存在抛 `PROVIDER_NOT_FOUND`。
4. `createAiBridge().languageModel("deepseek","deepseek-chat")` 返回可用的 AI SDK `LanguageModel`；**协议选择必须是数据映射**（查表），代码里不得出现 `if (providerId === "...")`。
5. `test(id)` 返回 `ProviderStatus`，401 → `ok:false` 且 message 已脱敏；网络失败 → `ok:false`，**不抛异常**。
6. `discoverModels(id)` 优先走 provider 的 `/models`（用 AI SDK 或直接 fetch 均可），失败返回 `[]` 并 `onWarn`，**不抛异常**。
7. 单测用 `@ai-sdk/test-server`（已装）起 mock server 覆盖：正常模型列表、401、500、超时。
8. `pnpm typecheck` 0 错误，`pnpm test` 全绿。

## 硬性约束

- 遵守 `AGENTS.md` 九条；特别是：不按 provider 分支写协议、密钥不落库不进日志、不阻塞启动。
- `@ai-sdk/*` 提供者是可选 peer，**必须动态 import**，缺失时给出可读错误（提示装哪个包），不要顶层 import。

## 交证

按 `AGENTS.md` 的交证格式回报。
