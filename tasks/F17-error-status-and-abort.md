# F17 — `readStatus` 误读 DOMException 数字码 + AbortError 只认文案

**来源**：`docs/reviews/R02-final-review.md` S5 的后续（F16 实测发现）
**拥有文件**：`src/errors.ts`、`test/errors.test.ts`

## 缺陷（F16 实测）

1. `readStatus()` 会读任意数字型 `code` 键：`DOMException` 的 `AbortError`/`TimeoutError` 旧式数字码是 **20/23**，于是 `ModelInfraError.status` 被写成 20/23，对外语义被污染（不是 HTTP 状态）。
2. `AbortError` 只靠 message 文本识别：
   ```
   Object.assign(new Error("Request cancelled by caller"), { name: "AbortError" })
   → UNKNOWN / retryable:false
   ```
   只有真实 `AbortController` / `AbortSignal.timeout()` 的 DOMException 文案才命中 TIMEOUT。

## 修法

1. `readStatus()` 只接受**合理 HTTP 状态码**（`100 <= n <= 599`）；其它数字（如 DOMException 的 20/23、errno）不当作 status。
2. 分类增加 `name === "AbortError"` / `name === "TimeoutError"` 判定 → `TIMEOUT` 且 `retryable: true`（message 仍走固定文案 + `redact`）。

## 验收（逐条真跑并贴输出）

1. `Object.assign(new Error("Request cancelled by caller"), { name: "AbortError" })` → code `TIMEOUT`、`retryable === true`、`status === undefined`。
2. `DOMException` 的 AbortError/TimeoutError → code `TIMEOUT`、`status === undefined`（不再是 20/23）。
3. 真 HTTP 429/500/404 的 `status` 仍被正确读出（回归）。
4. `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/errors.test.ts test/hub.test.ts` 全绿，测试数只增不减。
5. 不改其它文件。
