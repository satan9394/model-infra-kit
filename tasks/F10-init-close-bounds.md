# F10 — 阻断 B1 + 建议 S1：`init()` 无界阻塞 / `close()` 后抛裸错误

**来源**：`docs/reviews/R02-final-review.md` B1 / S1
**拥有文件**：`src/hub.ts`、`test/hub.test.ts`

## 缺陷

1. **B1**：`src/hub.ts:292` 的 `await pricing.init()` 无超时、无 signal（`pricing/service.ts` 内部也没有）。注入永不 settle 的 fetch 时 `ModelInfra.init()` 20s 仍未返回；注入 5s 才 reject 时 init 耗时 5015ms。违背 `AGENTS.md` 规则 6「不阻塞启动」。现有 e2e 全部带 `--offline` 或 unreachableFetch，永远测不到。
2. **S1**：`close()` 之后调用其它公开成员会抛裸 `ERR_INVALID_STATE`（不是 `ModelInfraError`），宿主难以统一处理。

## 修法

1. `init()` 里的 `pricing.init()` 用**有界等待**（复用 hub 里已有的 `settleWithin()`，上限 5s；超时继续启动，`pricing.state().status` 自然为 `stale`/`error`，并 `onWarn` 一次）。
2. `close()` 后调用公开成员 → 抛 `ModelInfraError`，code 新增或复用 `STORAGE`，message 明确「this ModelInfra instance has been closed」。

## 验收（逐条真跑并贴输出）

1. 注入永不 settle 的 `pricingFetch` → `init()` 在 **6s 内**返回（贴耗时数字），且 `pricing.state().status !== "fresh"`。
2. 注入 5s 才 reject 的 fetch → `init()` 仍在 6s 内返回且不抛。
3. `await hub.close()` 后调 `hub.generate(...)` → 抛 `ModelInfraError`（断言 `instanceof` 与 `code`）。
4. 嵌入式默认路径不回归：正常网络下 `init()` 仍会完成目录同步。
5. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/hub.test.ts test/server.test.ts test/cli.test.ts` 全绿，测试数只增不减。

## 注意

- 不要改 `README.md`、`packages/mik/package.json`（F11）、`scripts/**`（F12）。
