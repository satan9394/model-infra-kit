# DSH Recovery Report

> 项目：`model-infra-kit`（`E:\DeepSeek_Harness\workspace\2026_09_08\model-infra-kit`）
> 依据：Git 事实（**写下时** HEAD `ca37bf8`）+ 本目录 `DSH_RECOVERY_CHECKPOINT.md`。**未读取其他项目。**
>
> **最新事实（2026-09-12 收尾后）**：§7.2 的待办已作为 **G90** 收尾并发布为 **`v0.3.1`**——
> 提交 `285e23a`（代码 + 升版）与 `e0e0705`（文档收口），npm 与 GitHub Release 均已发布，
> 两次提交的 CI 三 OS 全绿，G36 已发布产物验证通过。当前 HEAD 是 `e0e0705`，
> 工作区只剩两个恢复点文件未跟踪（`DSH_RECOVERY_REPORT.md` 本身与 `DSH_RECOVERY_CHECKPOINT.md`）。
> **文末 §10 是最新状态；§1/§3/§4.1/§7.2/§9 里被它取代的说法已就地标注。**

## 1. 当前项目状态

本会话把该包从 `0.1.7` 推到 **`0.3.0`**，共 40 个已发布版本、34 个经独立验收的切片。当前工作区**干净**：无未暂存/已暂存改动、**0 个未推送提交**、唯一未跟踪文件是恢复点文件本身。
（**2026-09-12 已不成立**：见 §10——本节写的「工作区干净」「三处版本一致（`0.3.0`）」都是上一轮结束时的快照；收尾后 HEAD 为 `e0e0705`、版本为 `0.3.1`、工作区只剩两个恢复点文件未跟踪。）npm、GitHub Release、`package.json` 三处版本一致（`0.3.0`），`main` 上 CI 三 OS 全绿（代码提交 `d71c83b`、`0e1b3f4` 等）。产物已在生产可用的成熟度：成本可对账、未知不伪装成精确、CLI 与看板口径统一、跨平台门禁可用。**本次长运行因 token 消耗过大被人工止损**，未发现代码处于半成品状态。

## 2. 本次长运行实际成果

| 改动 | 证据 | 状态 |
|---|---|---|
| 成本确定性：未定价/折叠时降级为「至少」下限，绝不闭合成点 | G78 `f4f6414`+`d373c9e`，发布 `0.2.24` | KEEP |
| 金额精度：有余数时 4→6 位，导出逐行可对账（整数微美元渲染） | G81 `51d993d`（`0.2.27`）、G85 `ac56c68`（`0.2.29`） | KEEP |
| CLI 面可追溯：`usage logs --with-id` 使一行导出能对到一条 log | G86 `1cc1a21`（`0.2.28`） | KEEP |
| 弃用 `costUsd` 点估计（字段保留仍填充，内部改走两端） | G89 `d71c83b`（`0.3.0`） | KEEP |
| 渲染不误导：标签换行不再能伪造输出行；缺失值不再印成 `0 ms` | G82 `760ff72`（`0.2.25`） | KEEP |
| 冷启动承诺与落盘：`init` 不再推荐装包后必失败的命令；`--cache-dir` 真正落盘 | G84 `0e1b3f4`（`0.2.26`） | KEEP |
| 三处静默行为收敛：重跑 init 保住 `cacheDir`、`trends --to` 下沿可见、看板口径统一 | G88 `282a6ca`（`0.2.30`） | KEEP |
| 未定价覆盖率与折叠库可见性（含「不该沉默时沉默」的修正） | G74/G77（`0.2.x`） | KEEP |
| 跨平台门禁健壮性：管道提前关闭、三门禁诊断对齐 | G76/G72b（`0.2.x`） | REVIEW |
| 流程记忆：`AGENTS.md` 70 余条教训 + 明确标注的 BACKLOG | `AGENTS.md`（`ca37bf8`） | KEEP |
| 自动迭代循环本身（把评审「建议登记」当队列清） | 我自陈的流程错误，见 `AGENTS.md` R259 | DROP |

## 3. 未提交 / 半成品

1. `DSH_RECOVERY_CHECKPOINT.md` —— 上一份协议生成的恢复点，**刻意未提交**，供人工审阅。
2. `.tmp/`（`impl-*.md`、`eval-*.md`、`audit-R232.md`、红绿证据、release 说明）—— 均为 **gitignored** 的过程证据，不入库、不影响构建。
3. 除以上两项，**无任何未提交代码改动**。（**2026-09-12 已更新**：那批改动已随 `285e23a` 提交并发布为 `v0.3.1`，见 §10；本节前两项——恢复点文件与 `.tmp/`——仍然成立。）

## 4. 当前风险

1. **`0.3.0` 的验证有空白**：G36 只验到「CLI 可跑 / 类型里 `@deprecated` 在 / `costUsd` 仍在」；金额 6 位精度与看板区间显示**未做页面级（SSR）取证**，评审已申报。
   （**2026-09-12 部分关闭**：看板区间显示已在 overview 那个成本单元格上完成页面级取证（§9 做、§10 收尾发布）；**金额 6 位精度仍未取证**。）
2. **`0.3.0` 有用户可见变化**：金额在有余数时位数变多；次微金额由 `0.0000` 变为非零；**按字符串解析金额列的宿主脚本应改按数值解析**（契约已写明迁移）。
3. **CI 对纯文档提交显示 `cancelled`**（被后续推送取代）——非失败，但也**不等于已验证**。
4. 网络搜索后端已按用户要求关闭（`tool-web` 的 `search: false`），后续外部信息只能 `web_fetch` 直取。
5. 治理风险：若不明确「登记项 ≠ 待办」，本轮的自再生队列问题会重演。

## 5. 建议保留

1. 全部 35 个已发布切片与 41 个版本历史（`0.1.7` → **`0.3.1`**），均经独立验收且 CI 绿。
   （**注**：第 35 片 **G90**（`0.3.1`）是**验证片**——它补的是断言，产品运行时零变化；且它**没有独立 Evaluator**，是该片与铁律的唯一偏差，见 §10。）
2. `AGENTS.md` 的硬性规则 + 复盘教训（尤其 R208/R231/R258/R259 四条方法论）。
3. `AGENTS.md` 中**明确标注「非必做」的 BACKLOG 段**——保留其记录价值，不作为待办。
   （**注**：⑥ 已被 G90 部分闭合——overview 那个单元格现在有页面级断言，`trends.tsx` 那格仍无；**按指令原样保留、未勾除**，闭合程度记在 `docs/product-evolution.md` 的 EVO-G90 节。）
4. `docs/interfaces.md`（契约）与 `tasks/EVO-G8x-*.md`（任务卡），接手者的入口。
5. `~/.dsh/profiles/web/cordis.patch.yml.bak-before-toolweb-override-20260912-092637`（搜索后端关闭前的可回退备份）。

## 6. 建议暂缓或丢弃

1. **DROP：继续「清空登记项」的自动迭代**——队列自我再生，产品行为已无缺口。
2. **暂缓：BACKLOG ①**（开发种子脚本 `seed.mjs:306` 印点估计）——不影响用户可见面。
3. **暂缓：BACKLOG ③④⑤**（空串 `--cache-dir`、重跑 init 丢手写键、`--to X --days 7` 缺断言）——边界场景，价值低但**不必做**。
4. **暂缓：BACKLOG ⑥⑨**（看板测试镜像副本、注释轻量守卫）——仅在下次触碰看板时顺手处理。
   （**2026-09-12 更新**：⑥ 的 overview 那一半已由 G90 关掉（`data-testid` + 页面级断言），剩下的 `trends.tsx` 同类单元格与 ⑨ 仍按此条暂缓。）
5. **丢弃：本会话使用过的 `git apply -R` 式临时取证手法在无 commit 隔离时复用**——证据边界不清。

## 7. 下一步

1. **人工验收 `0.3.0` 的迁移说明**：读 `docs/interfaces.md` 的 EVO-G89 节与 GitHub Release `v0.3.0` 说明，确认金额格式变化可接受；若接受则**无需任何代码动作**（可验证：读完即结）。
2. **（可选，独立可完成）给看板成本区间那格加页面级断言**：`data-testid` + 渲染测试，断言印的是区间而非单值；改前必红。
   → **2026-09-12 已完成**：改动清单与改前必红证据见 §9，收尾（提交 / `v0.3.1` / CI / G36）见 §10。
3. **（可选，独立可完成）BACKLOG ③**：空串 `--cache-dir ""` 不再静默删掉配置里既有的 `cacheDir` 键；附一条改前能红的断言。

## 8. 恢复原则

下一次开发：

1. 新开干净会话。
2. 先读本报告（再按需读 `AGENTS.md` → `docs/product-evolution.md`）。
3. 一次只选择一个任务。
4. 不自动恢复旧 Goal。
5. 不重新启动此前的开放式产品审计循环。

## 9. 更新（2026-09-12，续做本轮）

> **本节的状态行已被 §10 取代**：切片已于当日收尾并发布（`v0.3.1`，提交 `285e23a` + `docs` `e0e0705`）。
> 下面保留的是**收尾之前**的快照，供对照；「未提交、未升版、未发布」「4 个未提交文件」等说法**已不成立**。

**本轮只做一件事**：§7.2 的「给看板成本区间那格加页面级断言」（`data-testid` + 渲染测试，断言印的是区间而非单值，改前必红）。*（写下时：未提交、未升版、未发布。）*

**改动（4 个文件，当时均未提交）**

| 文件 | 改了什么 |
|---|---|
| `apps/dashboard/components/ui.tsx` | `StatCard` 增加可选 `testId` → value 元素的 `data-testid`（不传时属性不渲染，其余 5 个视图不受影响） |
| `apps/dashboard/components/views/overview.tsx` | 总花费单元格挂 `testId="overview-cost-span"`，并说明它为何需要单元格级锚点 |
| `scripts/e2e/run.mjs` | 新增 `testIdText()`；DASH 步骤先经公开计量 API 写一条**真实价差行**（`low 0.01 < usd 0.012345 < high 0.02`，仓库既有 fixture 形状），再断言单元格文本 === `formatUsdSpan(costLowUsd, costHighUsd)`、不含被弃用的 `costUsd`、fixture 本身确实带 `~`；上游不可达那一趟断言同一锚点读到 `—` |
| `scripts/e2e/README.md` | DASH 行补上这条断言的说明 |

**为什么必须加那条价差行**：本轮之前该 run 写下的每一行都是点定价（`low === high`），此时「渲染区间」与「渲染被弃用的点估计」印出的是**同一个字符串**，而原断言 `home.includes(expected.cost)` 又是全页子串匹配——两者叠加正好构成 R258 ⑥ 的盲区（看板区间用例不会因生产回归变红）。合成行 + 单元格锚点 + 「fixture 真是区间吗」的守卫，三件事缺一不可。

**验证（均为本轮实测）**

1. 改前必红：临时把单元格改回 `formatUsd(summaryData?.costUsd)` → `node scripts/e2e/run.mjs` → `FAIL  DASH  the overview money cell prints "$0.036645", expected the recorded band "$0.0343 ~ $0.0443"`，退出码 1（62.8 s）。已逐字还原，`git diff` 只剩预期改动。
2. 恢复后全量：`node scripts/e2e/run.mjs` → **All checks passed，退出码 0**（83.8 s）；DASH 行 `/ shows $0.0343 ~ $0.0443 / 10 requests / 24.6K tokens`，`numbers.DASH.cost` = `$0.0343 ~ $0.0443`（区间，非单值）。
3. `pnpm --filter @mik/dashboard typecheck` → 0 错误；`pnpm --filter @mik/dashboard test` → 15/15 通过。

**发现但未处理（只记录）**

1. `apps/dashboard/components/views/trends.tsx:58` 是同一形状的成本区间单元格（同样走 `formatUsdSpan`），仍无 `testId`、无页面级断言——同类盲区只关掉了一半（任务只点名 overview 那格）。
2. `AGENTS.md` BACKLOG ⑥ 只是**部分**闭合：现在覆盖 overview 的这一个单元格，`lib/format.ts` 的辅助函数单测仍停留在辅助函数级。
3. `apps/dashboard/scripts/seed.mjs:306` 仍用 `summary.costUsd.toFixed(4)` 印点估计（BACKLOG ①，同源）。
4. `docs/product-evolution.md` 与 `AGENTS.md` 的 BACKLOG **未更新**：本轮按指令只做实现 + 验证，未走收尾铁律（独立评审 → 逐文件点名提交 → 升版 → 全量 → 发布 → CI → 产物验证），故没动编排者的状态文件。**这个切片尚未记账。**
   → **2026-09-12 已解决**：`docs/product-evolution.md` 追加 EVO-G90 留痕、`AGENTS.md` 当前状态升到 v0.3.1 / 切片 G01–G90 / 基线 694 例（39 文件）并补 R260 两条教训；**BACKLOG 段按指令原样保留**（⑥ 只部分闭合，记在 product-evolution 里，不勾除）。见 §10。
5. 新增的合成用量让该 run 的合计从 9 行 / `$0.0243` 变为 10 行 / `$0.0343 ~ $0.0443`；所有既有断言都由 `hub.usage.summary()` 派生、无硬编码，但今后若有人对总行数或总额写死字面量会受影响。
6. **环境事实**（本轮探针实测，仅本机/Node 24 语义）：`node --experimental-transform-types` **不能加载 `.tsx`**（无 JSX 变换），所以看板无法用 `node --test` 直接渲染 React 组件——这正是「渲染后 HTML 的断言」落位在 e2e DASH 的原因。若将来真要做组件级渲染测试，需先引入 JSX 变换 loader，不在本轮范围。

**下一轮入口**：`git status` 有 4 个未提交文件，先决定是走收尾铁律（评审 + 提交 + 升版 patch + 发布）还是先继续 §7.3（空串 `--cache-dir`）。**不要**把 §9 的第 1 条当成待办去做——按 R259，登记项不是队列。
→ **已被 §10 取代**（那 4 个文件已随 `285e23a` 提交并发布为 `v0.3.1`）。

## 10. 收尾（2026-09-12）——G90 已作为独立切片发布

**结论**：切片正常收尾。§9 的 4 个文件已提交，按项目既有规范 patch 升版并发布，机械门禁、CI 三 OS、G36 已发布产物验证**全部通过**。

**提交**（`main`，已推送）
- `285e23a` — `v0.3.1: the dashboard money cell asserts on itself, against a real spread (G90)`：§9 的 4 个文件 + `packages/mik/package.json` 版本号（5 文件，87+/4-）。
- `e0e0705` — `docs: G90 closure, status v0.3.1; ...`：`AGENTS.md` + `docs/product-evolution.md`。
- **未提交**：`DSH_RECOVERY_REPORT.md`、`DSH_RECOVERY_CHECKPOINT.md`（按 §3，恢复点文件刻意不入库，供人工审阅）。

**版本与发布**：`packages/mik/package.json` `0.3.0` → **`0.3.1`**（根 `package.json` 是私有的 `0.0.0`，不参与发版）；`npm publish` 成功（`model-infra-kit@0.3.1`，163.7 kB，12 文件）；`gh release create v0.3.1` 成功并**独立复核**（`gh release view` → tag=v0.3.1、target=main、非 draft）。

**验证（全部实测）**
1. 机械门禁（升版**之后**复跑，R99）：`tsc --noEmit` 0；vitest **694/694**，**zh-CN 与 en-US（`LC_ALL`/`LANG`，不设 `MIK_LANG`）两种 locale 均全绿**；看板 15/15；`node scripts/e2e/run.mjs` **12/12 exit 0**（DASH 单元格读 `$0.0343 ~ $0.0443`）；`node scripts/check-envs.mjs` 三环境 PASS。
2. **CI 三 OS 全绿**：run [34717302263](https://github.com/satan9394/model-infra-kit/actions/runs/34717302263)（`285e23a`）ubuntu/macos/windows 三个 job 均 `success`。
3. **G36 已发布产物**：全新隔离目录（**先写自己的 `package.json`**）`npm i model-infra-kit@0.3.1` → `import.meta.resolve()` **自证解析落在该目录内** → ① `mik 0.3.1`；② 30 个导出含 `ModelInfra`；③ `dist/server.mjs` + `dist/server.d.mts` 随包；④ 宿主示例冒烟 **14/14**（mock → init → test → discover → default → generate → stream → tool call → usage：文本、`requests 3`、`generate=2 stream=1`、token 4800/1200/3200）。

**本轮的两处操作失误（已记录为 R260，未造成产品影响）**
1. **G36 第一次跑错位置（R113 原样重演）**：临时目录 `%TEMP%\mik-g36-031` 没有 `package.json`，`npm i` 向上找到 `C:\Users\Satanchen\package.json` 并**对账了父目录整棵树**（npm 日志：retire/替换 ai、model-infra-kit、tokscale、zod 等 8 项，含把那里的 `model-infra-kit` 升到 0.3.1）。更危险的是随后 `import('model-infra-kit')` **仍然成功**（Node 从祖先目录解析），于是「导出可用」这条**在临时目录什么都没装的情况下显示通过**。**已重做**：新目录先写 `package.json`，并打印 `import.meta.resolve()` 自证位置，14/14 全过。事后核实：该父目录**不在 PATH 上**，`claude 2.1.267`、`tokscale 4.16.0`、`npm 11.9.0` 均正常，`@deepseek-ai` 为空且**早于**本次（非本次所为）。
2. **en locale 复跑一度假红**：我额外注入了全局 `MIK_LANG=en`，而 `cli.test.ts:585` / `repl.test.ts:203` **故意只钉 `LC_ALL=zh_CN.UTF-8`、不带 `MIK_LANG`** 来断言向导与拒绝文案，于是 3 例失败。**项目文档要求的是设 `LC_ALL`/`LANG`**；改成只设它们后 694/694 全绿。已写进 `AGENTS.md`。

**明确未做（按本轮指令）**：`trace` 未动 §7.3 的 `--cache-dir`；未处理 §9「发现但未处理」的任何一条（`trends.tsx` 同类单元格、BACKLOG ①/⑥、seed 脚本）；**未清理 BACKLOG**；未做独立 Evaluator 验收（本轮禁止子代理，故这一环缺位——**这是与收尾铁律的唯一偏差**，所有结论均为编排者自证）。


