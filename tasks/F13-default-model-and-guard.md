# F13 — S2 删除供应商留下悬空默认模型 + S9 协议守卫测试太窄

**来源**：`docs/reviews/R02-final-review.md` S2 / S9
**拥有文件**：`src/registry/registry.ts`、`src/registry/index.ts`、`test/registry.test.ts`、`test/guard.test.ts`（新建）

## 缺陷

1. **S2**：`ProviderRegistry.remove()` 删掉 provider 后不清 `default_model`，留下悬空引用；之后任何省略 `model` 的请求都会 `PROVIDER_NOT_FOUND`（404），宿主很难定位。
2. **S9**：`test/ai-bridge.test.ts` 的「无协议分支」守卫只扫 3 个文件，`switch (id) { case "deepseek": }`、`["deepseek"].includes(id)` 这类写法逃得掉，且新文件不在扫描范围内。

## 修法

1. `remove(id)` 时，若 `defaultModel()` 指向被删的 provider，则清空默认模型（并 `onWarn` 一次说明原因）。同时 `setDefaultModel()` 已校验 provider 存在（F01），保持不变。
2. 守卫测试改为扫描 `src/**/*.ts` **全部文件**（去掉注释后匹配），并额外覆盖 `switch`/`includes`/`===` 三类写法；把守卫测试单独放到 `test/guard.test.ts`，用「故意造一个违规临时字符串」反证它能抓到（红→绿）。

## 验收（逐条真跑并贴输出）

1. `remove()` 后 `defaultModel()` 为 null；`onWarn` 恰好一次；再调用省略 model 的请求得到明确错误而非 404 悬空。
2. 守卫测试扫描文件数 ≥ 40（贴数字），且**反证**：临时在 `src/` 下加一个 `case "deepseek":` 的文件 → 守卫必须失败；移除后通过。
3. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/registry.test.ts test/guard.test.ts test/ai-bridge.test.ts` 全绿，测试数只增不减。
4. 不改 `src/hub.ts`（F14 拥有）。
