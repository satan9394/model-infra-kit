# F09 — 阻断 B2 + 建议 S7：错误与响应里的密钥泄漏

**来源**：`docs/reviews/R02-final-review.md` B2 / S7（指挥已复现 B2）
**拥有文件**：`src/errors.ts`、`src/util/redact.ts`、`test/errors.test.ts`（新建）、`test/redact.test.ts`（新建）

## 缺陷

1. **B2（指挥复现）**：`src/errors.ts` 兜底分支 `new ModelInfraError(raw || "Unknown provider failure.")` 直接把上游原文当 `message`，全程无 `redact()`。
   复现：
   ```
   node -e "import('./packages/mik/dist/index.mjs').then(m=>{const e=m.toModelInfraError(new Error('upstream said: invalid key sk-abcdefgh12345678 for org'));console.log(e.message)})"
   → upstream said: invalid key sk-abcdefgh12345678 for org
   ```
   而 `packages/mik/README.md` 声称 message「已脱敏，可直接展示给用户」，README 示例还 print 它。违反 `AGENTS.md` 规则 4。
2. **S7**：`src/util/redact.ts` 的 `redactDeep` 键名正则 `/^(authorization|api[_-]?key|token|secret|password)$/i` 不匹配 `x-api-key`、`api-key`、`openai-api-key` 等带前缀的自定义头，`/api/providers` 会把它们原样返回。

## 修法

1. `toModelInfraError`：**所有分支**的 message 出站前过 `redact()`；`cause` 保留原文（只进 debug）。
2. `redactDeep`：键名判定改为「包含 `authorization`/`api[-_]?key`/`token`/`secret`/`password`/`cookie`」即脱敏（大小写不敏感）。
3. 补测试：`test/errors.test.ts`（每个错误码分支的 message 都不含 `sk-`/`Bearer`/自定义头值；UNKNOWN 分支必须有断言）、`test/redact.test.ts`（`x-api-key`、`api-key`、`X-Api-Key`、`openai-api-key`、嵌套对象、数组）。

## 验收

- 复现命令的输出中密钥变成 `sk-****`（贴前后对比）。
- `pnpm exec tsc --noEmit` 0 错误；`pnpm exec vitest run test/errors.test.ts test/redact.test.ts test/hub.test.ts test/server.test.ts` 全绿，测试数只增不减。
- 不改其它文件（尤其不要改 `README.md`，那在 F11）。
