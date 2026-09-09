# F01 — T02 修复卡（评审 B2 / S8 / S9 / S12）

**来源**：`docs/reviews/T02-T04-review.md`
**依赖**：无
**拥有文件**：`src/registry/**`、`src/ai/**`、`test/registry.test.ts`、`test/ai-bridge.test.ts`

## 必修

1. **B2 密钥解析语义**（`src/registry/registry.ts:131` 附近）
   - `resolve(id)`：无 `apiKeyRef` 时，若 `preset?.envKey` 有值 → `credentials.tryResolve("env:" + preset.envKey)` 兜底。
   - 兜底仍为 null 且 preset 声明了 `envKey` → 抛 `ModelInfraError`，code `CREDENTIAL`，文案要说明「设置 <ENV> 或配置 apiKeyRef」。
   - `ResolvedProvider` 新增 `apiKeySource: "ref" | "env" | "none"`（已进契约）。
   - 补测试：preset+env 兜底成功（source `env`）、preset+env 缺失抛 CREDENTIAL、无密钥需求的本地 provider 仍是 `none` 且 `test()` 文案不误导成「密钥被拒」。

2. **S8 provider id 校验**
   - `add()` 校验 `/^[A-Za-z0-9._-]{1,64}$/`，含 `:` 直接抛 `INVALID_REQUEST`（`:` 是 `provider:model` 分隔符）。
   - `setDefaultModel(ref)` 校验 provider 存在，否则抛 `PROVIDER_NOT_FOUND`。
   - 补测试：`id: "my:proxy"` 被拒；`setDefaultModel("ghost:m")` 被拒。

3. **S9 401/403 不带上游 body**
   - `failureMessage`：状态码 401/403 时只用映射文案 + 状态码，不拼接响应体。

4. **S12 清理过时注释与强转**
   - 删除 `registry.ts:73-75`、`registry.test.ts:38-51` 里「protocol 仍是必填」的过时注释（`types.ts` 已改为可选）。
   - 删除不再必要的 `as unknown as ProviderConfig`（`registry.test.ts` 8 处、`ai-bridge.test.ts` 5 处）。

## 补漏测（S11）

- `loadProviderFactory` 的缺包错误分支：用临时 mock（如把包名换成不存在的包）覆盖，断言错误信息里出现 `npm i` 提示。
- 其余 6 个协议（anthropic / google / deepseek / moonshotai / xai / openai）的 `factoryOptions`：断言能建出模型对象且关键选项（baseURL/apiKey/headers）正确。可只做工厂调用，不发网络请求。

## 验收

- `pnpm exec tsc --noEmit` 0 错误。
- `pnpm exec vitest run test/registry.test.ts test/ai-bridge.test.ts` 全绿，且测试数只增不减。
- 不得改动其它卡的文件。
