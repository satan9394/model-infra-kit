# EVO-G10 — 技术债清理轮：i18n 残留 + 死导出裁定 + 电池稳健性（G29/G30/G23/G20）

> 来源：Product Evolution Orchestrator 第 10 轮 vertical slice（技术债收敛，非新功能）。
> 依据：`.tmp/eval-G08.md` 建议 1/5/6、`.tmp/eval-G06.md` 建议项、G23（电池偶发假阴）、G20（CI 补强）。

## 目标

把前几轮验收累积、且**互相耦合**的四条技术债一次收敛：① CLI 面残留的硬编码英文文案（双语承诺不完整）；② `dictFor`/`hasKey` 两个无 `src/` 调用方的导出给出明确裁定；③ 三环境电池的偶发假阴（有界重试）；④ G20 的 CI 覆盖面结论（说清哪些已由 CI 覆盖、哪些降级）。

## 用户场景

- 非中文用户看到「双语 CLI」时，不会在 `/lang` 提示、`/chat` 用法、`mik init` 输出里再撞到硬编码英文。
- 读 `docs/interfaces.md` 的人能查到 `dictFor`/`hasKey` 是否属于稳定面，而不是靠猜。
- 编排者/CI 跑三环境电池时，偶发的端口/进程抖动不再产生假红，但**真失败仍然红**。

## 当前问题（已核验）

1. **G29**：`packages/mik/src/cli/repl.ts` 的 `"Select language (zh / en): "`（`/lang` 无参提示）与 `"Usage: /chat <prompt>"`，`packages/mik/src/cli/commands/init.ts` 的 `Wrote …`/`appId`/`db` 输出行与两处英文 `CliUsageError` 文案——均未走 i18n 字典（Evaluator 逐行列出，见 eval-G08 建议 6）。
2. **G30**：`dictFor`（`i18n.ts`）与 `hasKey` 在 `src/` 内**无调用方**，仅测试与公开面使用；卡片曾要求「无调用方则删」，但 G08 已把「11 个既有导出齐全」写进契约，二者口径冲突。
3. **G23**：`scripts/check-envs.mjs` 偶发假阴——G07 轮 `wsl-ubuntu` 曾 FAIL、直接复跑即 PASS（疑为端口/进程残留抖动）。
4. **G20**：G04 遗留的「非 win32 分支仅假件验证」事实上**已由 CI 三 OS 全量单测覆盖**（G08 之后 CI 会跑 `child-supervision.test.ts`）；剩余「真实 SIGINT 端到端」成本高、价值低。

## 理想行为（变更点）

1. **i18n 补齐（G29）**：把上述文案全部改为 i18n 字典键（zh/en 各补键），保持既有行为不变；`repl.ts` 的 `/lang` 提示在注入 `ask` 的路径上也要本地化（沿用 G03 的 ask 注入）。
2. **死导出裁定（G30）**：**保留** `dictFor`/`hasKey`，并在 `docs/interfaces.md` 的 F16 小节把它们标为 **`@internal` 风格**（宿主便利、不承诺 semver），写明「`src/` 内无调用方，仅测试与宿主使用」；如你判断删除更好，请在报告中给出删除后公开面与契约的同步改法。
3. **电池有界重试（G23）**：`scripts/check-envs.mjs` 对**失败的环境**自动重试**一次**；重试成功则记为 `PASS (retried)` 并在摘要中标注；**重试仍失败则 FAIL**（不得掩盖真失败）。重试前先清理该环境的动态端口（沿用既有 `pickPort`）。
4. **G20 结论**：在 `docs/product-evolution.md` 记录「非 win32 分支已由 CI 全量单测覆盖；真实 SIGINT 端到端降级为 LATER（理由：需真实 TTY/信号注入，成本高于收益）」。

## 涉及模块

- `packages/mik/src/cli/i18n/{zh,en}.ts`（补键）、`cli/repl.ts`、`cli/commands/init.ts`
- `packages/mik/test/{i18n,repl,cli}.test.ts`（zh/en 对等测试自动覆盖新键；受影响用例同步）
- `docs/interfaces.md`（F16 标注 `dictFor`/`hasKey`）、`docs/product-evolution.md`（G20 结论）
- `scripts/check-envs.mjs`（有界重试 + 摘要标注）

## 不能破坏什么

- 既有 i18n 行为与 11 个导出（**只增不减**）、键对等测试、locale 注入约定（G26：测试不得读运行环境）。
- `mik init` 的**输出结构与内容顺序**（只把文案换成字典键，命令示例、路径、变量名不变）。
- 三环境电池的既有语义：真失败必须红（重试不得吞掉失败）。
- 不得引入新依赖。

## 验收标准

- A1 **文案本地化**：`repl.ts`/`init.ts` 中用户可见文案不再有裸英文字面量（可用源码断言：不在 `i18n/` 之外出现 `"Select language`、`"Usage: /chat`、`Wrote `、`application id` 一类串）；新增键在 zh/en 两侧齐全（parity 测试覆盖）。
- A2 **契约裁定落地**：`docs/interfaces.md` 明确写出 `dictFor`/`hasKey` 的标签（`@internal` 风格或删除说明）与「`src/` 无调用方」的事实。
- A3 **电池重试语义**：人为制造某环境失败（例如临时把 battery 版本断言改错）→ 重试后仍 FAIL、退出码非 0；**不得**出现「重试后假 PASS」。正常情况三环境 PASS（可含 `retried` 标注）。
- A4 **G20 结论入档**：`docs/product-evolution.md` 含该结论与降级理由。
- A5 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **431** 例）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS，且**CI 三 OS 绿**（本机跑完必须 push 并 `gh run watch --exit-status`）。

## 错误场景

- 词典缺键（新增键漏在 en）→ parity 测试必须红（自证方式：临时删一个键）。
- 重试逻辑自身异常（spawn 失败）→ 按失败处理并打印原因，不得静默。
- `init` 文案改动导致既有测试断言（如 `Wrote ` 前缀）失败 → 属**预期翻转**，同步更新断言并在报告说明，不得放宽断言强度。

## 测试要求

- ≥4 新用例：`/lang` 无参提示的本地化（注入 ask + 指定 lang）；`/chat` 用法提示；`init` 输出在 zh/en 下的差异；电池重试语义（可用单元级注入或用脚本层面的 dry-run 断言，二选一并说明）。
- 不得为测试放宽生产默认；不得新增读真实 locale/env 的断言（G26）。

## 范围外

G10a（协议表合并）、G10b（运行时注册）、任何新功能/新路由、看板 i18n 全面化。