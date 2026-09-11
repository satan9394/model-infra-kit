# EVO-G11 — 架构整洁度：协议表合并 + 结构级守卫 + 小项收口（G10a/G18/G19/G16/G15）

> 来源：Product Evolution Orchestrator 第 11 轮 vertical slice（LATER 集群收敛）。
> 依据：`.tmp/audit-architecture.md` 4.1（协议扩展 5 处静态表）、`.tmp/eval-G03.md` 建议 ③（防环断言仅覆盖单写法）、G19（`runCommand`/`main` 重复前置段）、G16（README 版本号硬编码）、G15（非法语言二次重选无提示）。

## 目标

把「扩展成本」与「守卫强度」这两件结构性的事收口：① 协议表由两张合并为一张（新增内置协议的落点从 5 处降到 4 处，并给出配方文档）；② 防环守卫从「单文件单写法 grep」升级为**目录级 import 图环检测**；③ 收敛 `runCommand`/`main` 的重复前置段；④ 两个小项：README 版本号不再硬编码、`/lang` 非法输入二次失败给提示。

## 用户场景

- 贡献者想加一个内置协议：照 `docs/interfaces.md` 的配方改**4 处**（类型联合、合并后的协议表、包名表、预设表），而不是在两张几乎平行的表里来回对齐、容易漏一处。
- 任何人改动 `src/cli/` 引入**任何形态**的循环依赖（不只是 `from "./index.js"` 这一种写法），测试立刻红。
- 读 README 帮助样例的人看到的版本号永远与 `package.json` 一致（不再需要每次发版手工同步）。

## 当前问题（已核验）

1. **G10a**：`SDK_PROTOCOLS`（`ai/protocols.ts:37`）与 `MODEL_LIST_PROTOCOLS`（`:246`）是两张以 `Protocol` 为键的平行表；加上 `Protocol` 类型联合、`PROTOCOL_PACKAGES`、预设表 = 新增内置协议要动 **5 处**。
2. **G18**：`repl.test.ts` 的防环断言只检查 `repl.ts` 源码不含 `from "./index.js"` **这一种写法**（单引号、`await import()`、或从 commands 反向引用 index 都抓不到）。
3. **G19**：`cli/dispatch.ts` 的 `runCommand` 与 `cli/index.ts` 的 `main` 有约 10 行重复前置段（parseCliArgs → version → help）。
4. **G16**：README 帮助样例里的版本号是硬编码字符串（G08 后为 `0.2.4` 一类），每次发版都可能过期。
5. **G15**：`init.ts` 向导里非法语言输入重选一次后仍非法时无显式提示（静默取默认）。

## 理想行为（变更点）

1. **G10a 合并协议表**：在 `ai/protocols.ts` 内把两张表合并为**单一** `PROTOCOLS: Record<Protocol, { sdk: SdkProtocol; list: ModelListProtocol }>`，并**保留** `SDK_PROTOCOLS`/`MODEL_LIST_PROTOCOLS` 作为**派生只读视图**（`Object.fromEntries` 派生，导出名与类型不变，避免破坏 30 个公开导出）；在 `docs/interfaces.md` 补一节「**新增内置协议配方**」，逐条列出 4 处落点与顺序。
2. **G18 目录级环守卫**：新增测试（放 `guard.test.ts` 或新建 `test/module-graph.test.ts`）——扫描 `packages/mik/src/**` 的所有 `import ... from "..."` 与 `await import("...")`，构建模块图，断言**无环**；并断言 `cli/` 的入边方向（`index → repl → dispatch`）。
3. **G19 收敛重复前置段**：把 parseCliArgs → version → help 抽成 `cli/dispatch.ts` 内的一个函数（如 `prepareInvocation`）供 `runCommand` 与 `main` 共用；**行为零变化**（version/help 输出、退出码、无命令分支归属不变）。
4. **G16 README 版本动态化**：帮助样例中的版本号改为**占位说明**（如 `model-infra-kit (mik) <version>`）或由脚本注入；不得再硬编码具体版本。
5. **G15 非法语言二次重选提示**：`init.ts` 向导中若第二次输入仍非法，打印一次提示（复用既有 `wizard.langInvalid` 键）并采用默认，而非静默。

## 涉及模块

- `packages/mik/src/ai/protocols.ts`（合并 + 派生视图）
- `packages/mik/src/cli/dispatch.ts`、`packages/mik/src/cli/index.ts`（G19）
- `packages/mik/src/cli/commands/init.ts`（G15）
- `packages/mik/test/`（新守卫测试 + 既有用例）
- `docs/interfaces.md`（协议配方）、`README.md`（G16）

## 不能破坏什么

- **公开导出面**：`SDK_PROTOCOLS`/`MODEL_LIST_PROTOCOLS`/`PROTOCOL_PACKAGES`/`packageForProtocol`/`Protocol` 等名字与语义不变（合并只改内部实现）。
- `mik --help` / `-v` / 子命令 / 裸 `mik`（TTY→REPL、非 TTY→help）行为与退出码零变化（G19 是纯重构）。
- 既有 431+ 测试全绿（尤其 `guard.test.ts`、`registry.test.ts`、`cli.test.ts`、`repl.test.ts`）。
- 不引入新依赖。

## 验收标准

- A1 **协议表合并**：`ai/protocols.ts` 内只有一张源表（`PROTOCOLS`）；两张旧表由它派生；`grep -c "MODEL_LIST_PROTOCOLS: Record"` 为 0（不再是独立声明）；`tsc` 0 错误；`registry.test.ts` 等既有用例全过。
- A2 **配方文档**：`docs/interfaces.md` 含「新增内置协议配方」，逐条列出 4 处落点（含顺序）。
- A3 **环守卫有效**：新守卫测试**能抓住**人为引入的环——请自证：临时在 `dispatch.ts` 里加一行 `import { main } from "./index.js"`，跑该测试应**红**；恢复后**绿**（用 `git checkout` 恢复，不得留改动）。
- A4 **G19 行为不变**：`mik --version`、`mik --help`、`mik provider list`、裸 `mik`（非 TTY）输出与退出码与改前一致（可对照 `git stash` 前后输出）。
- A5 **小项**：README 不再含硬编码版本号（有断言或人工核验说明）；`init.ts` 二次非法语言输入有提示（有用例）。
- A6 全量：`tsc --noEmit` 0 错误、全量 vitest 全绿（基线 **435** 例起）、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS，且 **CI 三 OS 绿**（push 后 `gh run watch --exit-status`）。

## 错误场景

- 合并后若某协议只在旧表之一存在 → 派生视图缺项 → 该场景由既有 `registry.test.ts`/`ai-bridge.test.ts` 覆盖；若发现缺口请补用例。
- `await import()` 形态的环：新守卫必须覆盖（这是 G18 的存在理由）。
- G19 重构后 version/help 短路顺序变化 → A4 逐条对照兜住。

## 测试要求

- ≥4 新用例：环守卫（含 `await import()` 与 commands→index 两类人为环的自证）、派生视图与源表一致（键集合与内容）、G15 二次非法输入提示、README 无硬编码版本号。
- **不得为测试放宽生产默认**；测试不得读运行环境（G26）。

## 范围外

G10b（运行时协议注册，已裁定 NOT_NOW）、看板 i18n 全面化、任何新功能。