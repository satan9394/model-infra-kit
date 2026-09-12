# EVO-G72 — 工具的错误路径本身要可靠（`battery.sh` 的 `fail()`）

> 暂存于 `.tmp/`，待前序卡关闭后转正。**证据**：R146–147 编排者核实（`.tmp/evidence-G58.md` §6.6）+ 交付者在 R146 的现场撞见。

## 目标

`scripts/check-envs/battery.sh` 在**任何步骤失败时**都能**干净退出并打印真实失败原因**，不再以一条误导性的 bash 错误终止。

## 当前问题（已核实）

`battery.sh:15` 是 `set -euo pipefail`（**`-u` 开启**）。
`battery.sh:41`：
```bash
fail() { echo "STEP $1 fail"; echo "FAIL[$NAME] $1"; echo "$2" 2>/dev/null || true; exit 1; }
```
**调用点参数个数不一致**：
- `L60`：`… || fail "bin-symlink"` —— **1 个参数**
- `L97`：`… || fail "summary"` —— **1 个参数**
- `L84`：`fail "health" "$HEALTH"` —— 2 个
- `L96`：`fail "chat" "$BODY"` —— 2 个
- `L101`：`fail "csv" "header: …"` —— 2 个

→ 在 1 参调用点上，`echo "$2"` 在 `set -u` 下触发 **`$2: unbound variable`**，**`exit 1` 都不会执行到**；用户看到的是 bash 的中毒错误，**而非**「哪一步失败了」——真实原因被掩盖。

## 用户场景（谁受影响）

不是终端用户，而是**维护者**：三环境电池是发布前的门禁之一。当它失败时（例如 R146 那次 wsl-ubuntu 的瞬时失败），**排查方向会被「unbound variable」带偏**，浪费一轮。

## 理想行为

```bash
fail() { echo "STEP $1 fail"; echo "FAIL[$NAME] $1"; echo "${2:-}" 2>/dev/null || true; exit 1; }
```
（`${2:-}` 在未传第二参时展开为空串，`set -u` 不再触发。）

**并逐条检查同类风险**：
1. 全脚本 `$1`…`$N` 的使用是否都可空（`set -u` 下的位置参数）；
2. **`battery.ps1` —— 编排者已实测，结论：无同类问题，不要改它。**
   ```powershell
   function Fail([string]$Step, [string]$Message = "") {   # 已有默认值 ""，1 参调用安全
   ```
   PowerShell 版**作者已正确处理**（`$Message = ""` 默认值），且脚本未设 `Set-StrictMode`。**这是 bash 与 ps1 的非对称缺陷**——正是不该假定的地方。**修 `.sh` 时请以 ps1 的 `$Message = ""` 为范本写法**。
3. `pass()` 是否也有类似隐患（bash 版 `pass()` 只用 `$1`，**已核：安全**）。

## 涉及模块

`scripts/check-envs/battery.sh`（主要）、`scripts/check-envs/battery.ps1`（**实测后再定**）

## 不能破坏什么

- **不得改变电池的判定语义**：正常路径（三环境 PASS）必须仍然 PASS，失败路径必须仍然**退出码 1**（`exit 1` 要真的执行到）。
- 不得改动 `scripts/check-envs.mjs` 的解析逻辑（它按 `FAIL[...]` / `STEP ... fail` 文本读结果——**若本卡改动这些文本，必须同步改解析方**；建议**不改文本**，只修 `${2:-}`）。
- 三环境电池实跑仍须三 PASS。

## 验收标准

- **A1**：**构造一次失败**，断言：
  - 输出含 `FAIL[<env>] <step>`；
  - **不再出现** `unbound variable` 字样；
  - **退出码为 1**（而非 bash 因 `set -u` 崩溃的退出码——两者可能都是 1，**故必须同时断言「无 unbound 字样」**，否则该断言不成立）。
- **A2**：正常路径三环境仍 PASS（`node scripts/check-envs.mjs`）。
- **A3**：`battery.ps1` 经**实测**后给出结论：若有同类问题一并修，若无则在报告里**写明实测方式与结果**（不得只写「应该没问题」）。
- **A4**：不运行 git 写操作（由编排者提交）。

## 错误场景

- 任一 `fail` 调用点在 `set -u` 下都必须能打印并退出。
- 若某步骤失败且**确实有**第二参（如 `health`/`chat`/`csv`），该详情**仍须打印**（不能被 `${2:-}` 误伤成一律空）。

## 测试要求

- 电池是**脚本**而非 vitest 用例，故本卡的「测试」是**实测证据**：
  - 提供**构造失败的命令与真实输出**（改前含 `unbound variable`，改后不含且退出码 1）；
  - 提供**改前**的证据（证明断言非恒真——改前确实出现 `unbound variable`）。
- **G43 自检**：`A1` 的断言在**改前**必须为红。

## 范围外

产品代码、CLI 文案（G69/G70/G71 各自的范围）、`check-envs.mjs` 的判定逻辑（除非本卡确实改了文本约定），以及「顺带重构电池脚本」这类无收益改动。
