# 产品演进状态（Product Evolution Orchestrator）

> 本文件由 Orchestrator 维护：记录 GAP_MAP、路线图、每轮 vertical slice 与 PRODUCT_STATE。
> 每轮审计结论存放于 `.tmp/audit-*.md`（gitignored，跨轮保留）。

## PROJECT_BRIEF（v0.1.6 基线）

- **产品**：model-infra-kit——可嵌入任意 AI 项目的「模型供应商中心 + 用量计费中心」（npm 单包 + CLI mik + Next.js 看板 + OpenAI 兼容端点）。差异化：可嵌入库 API、密钥永不落库（api_key_ref）、离线优先、轻量单包、整数微美元审计精度、双语 CLI/REPL、看板 embed。
- **用户**：自研 AI/CLI/量化项目的开发者（四种接入：嵌入式库/子路径/fetch 适配器/本地服务）。
- **成熟阶段**：v0.1.6；功能面完整（13 任务卡 + 19 修复卡闭环），CI 三 OS 全绿；刚加入 REPL+向导+i18n 雏形。

## 四视角审计结论（R1 发起，R6 收齐；只读，未改代码）

| 视角 | 报告 | 核心结论 |
|---|---|---|
| UX | `.tmp/audit-ux.md` | 无首次使用 P0 断点；P1×2（REPL 提示符漏键、文档三处自相矛盾）、P2×3（向导选中文后提问仍英文、装包用户看用量出口未前置、看板零 i18n/223 处中文硬编码）、P3×6 |
| 竞品 | `.tmp/audit-competitor.md` | 类别=可嵌入应用层模型网关+计量计费基础设施；🟢 值得：成本对账文档、软预算告警（默认关）、Day-0 可选价格同步；❌ 不做：虚拟 key、限额硬执行、观测性、路由/failover、多租户、云同步、充值计费（DON'T 清单 8 条） |
| 架构 | `.tmp/audit-architecture.md` | P1×4（cli↔repl 循环依赖、i18n 三入口分裂、配置三源两套相反优先序、语言读取契约 init 偏离）、P2×4（协议扩展仅编译期静态表、as unknown as 6 处、契约字段缺清单、env 未全进契约）、P3×3 |
| 可靠/安全 | `.tmp/audit-reliability.md` | **P0×1**（默认无鉴权可写 API + SSRF 原语 + 计量伪造）、P1×2（dashboard 孤儿进程、REPL /lang 双 readline 抢 stdin）、P2×3、P3×3；核心降级路径（ABANDONED/close 有界/401 常量/迁移事务）验证良好 |

## PRODUCT_GAP_MAP（综合去重、冲突裁决、依赖与成本判断）

| ID | 问题 | 证据（已核验） | 用户影响 | 根因 | 优先级 |
|---|---|---|---|---|---|
| G01 | serve 默认零鉴权可写 API + SSRF 原语 + 计量伪造 | server.ts:129/173；api.ts:195/237/277；http.ts readJsonBody 不校验 Content-Type | 本机进程/恶意网页可改配置、伪造账单、外带宿主密钥 | 鉴权门整体依赖 token 是否配置；写端点无默认拒绝；baseUrl 无出站校验 | **P0** |
| G02 | dashboard 子进程孤儿化（父死子存，占 3210） | cli/commands/dashboard.ts:84-95 无信号转发/kill | 强杀产生僵尸开发服务器、二次启动报端口占用 | 无进程生命周期托管 | P1 |
| G03 | REPL /lang 无参数时双 readline 抢 stdin | repl.ts:87 + prompt.ts:14-21 | REPL 交互确定性缺陷 | REPL 内嵌独立 prompt() | P1 |
| G04 | cli↔repl 循环依赖未收敛 | repl.ts:16 ↔ index.ts:22 | tree-shaking/可测性地雷、顶层化的隐患 | main/runRepl 相互引用 | P1 |
| G05 | i18n 三入口分裂 + 语言读取契约被 init 偏离 | init.ts:52 跳读 cli.lang；init.ts:57 硬编码 zh；看板 0 i18n | 首次向导自覆写语言设置；看板非中文不可读 | i18n 仅在 CLI 单层薄字典；契约未被执行 | P1 |
| G06 | 文档与实机自相矛盾（版本 0.1.1/发布状态/--cors/端点存在性） | README:318、agent-cli-guide:248、playbook:29/154/196/220/270 | 新用户读文档即作出相反决策 | 文档未随发版更新 | P1 |
| G07 | REPL 提示符显示字面量 "repl.prompt" | i18n.ts 无此键（已核验缺失） | 第一屏观感像 bug 泄漏 | tr() 缺键原样返回 | P1（UX） |
| G08 | 配置三源无统一优先级表，context↔hub 两套优先序相反 | context.ts:140-143 vs hub.ts:315 | CLI 与嵌入用法 env 优先级不同 | 优先级只存在于两处注释 | P2 |
| G09 | i18n 扩展成本线性、无语言检测、dictFor 死代码 | i18n.ts 单字典/LANGS 硬编码 | 新增语言三处改 | 未建模 per-lang | P2 |
| G10 | 协议扩展仅编译期静态表，无运行时注册 | types::Protocol + 两张协议表 | 宿主无法新增协议 | "协议一等公民"只对内置成立 | P2 |
| G11 | 缺 DB 损坏恢复路径 | store/database.ts 无 integrity_check/重建 | 坏库即启动失败无自救 | 见审计 | P2 |
| G12 | redact 短/<8 字符密钥漏网 | redact.ts 最小长度限制 | 特殊编码 key 可能透出 | 正则长度限制 | P2 |
| G13 | 契约漂移：env 清单/ModelInfraConfig 字段未进 interfaces.md | interfaces.md vs context.ts:75/142/143、types.ts:247-263 | 新 Worker 按文档实现会漏行为开关 | 文档"引用型"非"真值型" | P2 |
| G14 | 值得做能力（竞品论证）：成本对账文档 / 软预算告警(默认关) / Day-0 可选价格同步(默认关) | audit-competitor 第三节（带来源 URL） | 补「计费可信度」「超支预警」 | — | P2/P3 |

## 路线图（R22 更新，含已开卡切片）

- **已完成切片**：G01（→0.1.7）、G02（→0.1.8）、G03（→0.1.9）、G04（→0.2.0）。P0+P1 集群清零。
- **已完成**：G01-G06 全部验收并发布（0.1.7 → 0.2.2）。
- **进行中**：G07（tasks/EVO-G07-cost-budget.md）= G14 成本对账文档 + 软预算告警（只告警不硬执行）。
- **已开卡待派**：G08（tasks/EVO-G08-i18n-locale.md）= G09 i18n 按语言分文件 + 键对等测试 + 系统语言检测 + 看板边界声明。
- **后续候选（未开卡）**：G10（协议运行时注册——需评估宿主扩展价值与公共面成本）、G15-G24 技术债清理。
- **技术债队列**：G15 非法语言二次重选提示、G16 README 版本动态化、G17 index.ts 换行（已在 G04 顺带修）、G18 防环断言升级为目录级 import 图检测、G19 runCommand/main 抽公共前置段、G20 G04 残余（真实 SIGINT 端到端 / 非 win32 分支 / 孙进程链——建议在 ubuntu+macos CI runner 补强）、G21 流程债（子代理失败率与既定对策）。
- **NOT_NOW（拒绝清单，维持）**：虚拟 key/key 池、RPM/TPM 硬限额、观测性深度（trace/eval/playground）、智能路由与自动 failover、多租户/团队、云同步/多实例聚合、兑换码与面向终端的充值计费、任何纯装饰功能（主题色等）。

## PRODUCT_STATE（R99，G01-G13 已验收关闭）

- **当前成熟度**：v0.2.9，P0+P1 清零，P2 九项完成（…、G11 架构整洁度、G12 CLI 入门面本地化、G13 `provider`/`usage` 输出本地化 + CJK 表格对齐）；**466 测试在 zh-CN 与 en-US 两种 locale 下均全绿、CI 三 OS 绿、e2e exit 0、三环境电池 PASS、发布产物经 G36 实测可用（含产物双语实测）**。
- **下一步**：**G14**（收完 CLI 层剩余 18 处英文 + 框架前缀一致性，卡片已备于 `.tmp/staged-G14-card.md`）；其后启动**一轮「当前状态」UX 复审**（旧审计为 `0.1.x` 时代，此后 12 个 slice 已显著改变产品）。
- **技术债**：已清 G20/G23/G29/G30（G10）、G10a/G18/G19/G16/G15（G11）、G37 入门面子集（G12）、G47（en 冻结面进版本控制）；待清 G37 其余（G14）、G38–G44、G45/G46/G48/G49，**新增候选 G50**（库层 11 处错误文案的包装策略）。
- **风险**：无阻塞级；**R99 新增两条流程铁律**：① 改 `package.json` 版本后必须重跑全量测试（否则冻结快照类测试必红）；② 文件级 fixture 必须做换行归一化 + `.gitattributes` 双保险（Git for Windows 检出 CRLF 会让 Windows-only 失败）。

## G13 验收留痕（R99）

- **判定：独立 Evaluator 判定 ACCEPT**（0 阻断、5 条建议）。判定过程曲折：第一位 Evaluator 运行 7 轮无产出（远超历史最长 5 轮）→ 编排者**先 interrupt 再重派极小任务**（≤4 文件/≤3 命令/≤100 行），重派者交付 64 行判定并核对快照无漂移。
- **Evaluator 的四项结论**：① **M2 类风险不存在**——全 src 27 处 grep 证实所有调用点显式传 `options`，无 `invocationLang({})`；`context.ts` 的 `contextLang(context, options)` 同时带上 `cli.lang`，链条 `MIK_LANG → cli.lang → OS locale → en` 正确。② **键对等精确相等**（zh 162 / en 162，无单边键、无重复、无空值）。③ **A2 基本可信但对照集不闭包**——`usage trends` 的 6 个表头键从未进对照集（**已由编排者当场闭合**，见下）。④ **范围无越界**（恰 10 文件、无未跟踪文件）。
- **R-A2 当场闭合**：编排者造一行 `usage_events` 数据后用「已发布 0.2.8 vs 当前构建」对照 `usage trends` → 表头（`DATE / REQUESTS / INPUT / OUTPUT / CACHE READ / COST USD`）与数据行**逐字相同、0 差异**。
- **编排者的 9 项独立验证**（全部实测）：tsc 0；全量 **466 在两种 locale 下全绿**；zh 探针由「改前 4/4 英文」转「改后 4/4 中文」；A2 同调用方式对照 6 路径 0 差异；冻结面交叉护栏 5/5（未越界碰错误路径/help）；**电池钉语言的反向验证**（移除即在 zh-CN 的 `summary` 步骤 FAIL）；**M2 语言优先级三测**（显式压过 OS locale）；**A3 结构化输出**（CSV 表头与 SHA256 一致、`--json` 该命令不存在属空真）；diff 质量（无调试残留、无 skip/only、`contextLang` 透传 options）。
- **R99 事故：CI 连红两轮，均由「本卡之外的测试基建」引发，且是编排者自己引入的**：
  1. **版本号被冻结**：G47 的 `cli-english-surface.test.ts` 把 `0.2.8` 写进快照 → 升到 `0.2.9` 后 `--help` 横幅变化 → CI 三 OS 全红。**我本地没发现是因为改完 `package.json` 只跑了 `build` 没跑测试**。
  2. **换行符敏感**：`.txt` 快照被 Git for Windows（`core.autocrlf=true`）检出为 CRLF，CLI 输出是 LF → **只有 `windows-latest` 全红**。
  修法（双保险）：测试内归一化**版本号与 `\r\n`**，并新增 `.gitattributes` 固定 `*.txt text eol=lf`。修复后**模拟 CRLF fixture 仍 5/5 绿**，CI 三 OS 全绿（34635827049）。
- **G36 发布产物验证**：`mik 0.2.9`、30 导出、`server.mjs` 在包内、**产物双语实测生效**（zh「还没有配置任何供应商。」/ en `No providers configured.`）。
- **编码过程**：`cd7375e`（功能）+ `b578570`/`c54853a`（CI 修复）+ `84e1244`（规则与状态）；npm `0.2.9` + Release v0.2.9。

## G13 进行中的准备工作（R85–R89，编排者只读产出）

- **4 份改前基线**（取自**已发布 0.2.7**，且 `provider.ts`/`usage.ts` 当时未被触碰，故等价改前 HEAD）：`baseline-g13-{provider-list,provider-help,usage-summary,usage-logs}-en.txt`。
- **验收探针** `.tmp/probe-g13-surface.mjs`：扫描 zh 面是否残留英文说明文案（`Requests`/`No providers configured`/`Add one with:`/`needs network access` 等，**标记集由实测输出反推**）。**已自证非恒真**：改前 4/4 全检出英文；且对**发布产物**同样有效。
- **冻结面交叉护栏**：新建的 `test/cli-english-surface.test.ts` 只覆盖**错误路径与 help**（5 类形状），实测**不含** `provider list`/`usage summary` 的正常输出文案 → 与 G13 改动面**不重叠**。因此 G13 完成后冻结面应**仍然全绿**；若它反而变红，即说明 G13 **越界改动了错误路径/help 面**——这给验收提供了一条独立的交叉验证。
- **冻结面测试已自证能红**：改坏一个 fixture → 精确 1 例失败；恢复 → 5/5 绿。

## G12 验收留痕（R82）

- **判定：两位独立 Evaluator 先后给出 REJECT（结论一致），编排者修完两项阻断后 CI 三 OS 全绿**。两次 REJECT 都**指出了编排者（=本卡实现者）的盲区**，是本项目迄今最有价值的评审之一。
- **阻断项 1（A2 违规）**：`i18n/en.ts` 的 `cli.flagNotAllowed` 英文值比 0.2.7 多一对引号——实测 `usage summary --port 1234`：0.2.7 为 `error: --port is not valid for "usage summary".`，当前为 `error: "--port" is not valid for …`。
  **为何漏网**：我的 4 条基线 + 9 条探针**全用未知选项 `--nope`**（由 `node:util` 先抛错、走 en 透传分支）；而 `flagNotAllowed` 只在「**已知但属于别的命令**的选项」（如 `--port`）时触发——**第三种错误形状**。修法：字典值去掉第一对引号；并**补第 5 条基线**（放错位置的已知选项）闭合样本集。
  **附注**：第一位 Evaluator 建议改成 `--%s is not valid…`，第二位明确指出那会输出 `----port` 是错的，正确是 `"%s is not valid for \"%s\"."` —— **两位评审互相纠错**，说明多重独立评审的价值。
- **阻断项 2（A5 不成立 + CI 必红）**：`context.ts` 的 `requireArg(..., lang = invocationLang({}))` 传**空对象** → 回落**真实 `process.env`**，丢弃注入的 `RunOptions.env`；4 个调用点都没传 lang。后果：注入 `MIK_LANG=zh` + 真实英文 locale 时输出**中英混排**（`错误： Missing required argument <id>.`），**CI 三 OS 必红**。
  **最重要的教训（本卡的核心收获）**：我在本机（zh-CN）跑出「451 全绿」并据此认为 A5 达标——**那是本机 locale 造成的假绿**。Evaluator 用 `LC_ALL=en_US.UTF-8` 复跑得到 **1 failed / 450 passed**，一举揭穿。**「本地全绿」对 locale 相关改动毫无证明力**（G26 的加强版：不只是「测试要注入环境」，而是**验证者本身所处的环境会决定他能否看见缺陷**）。修法：`requireArg` 改为接受并透传 `options`，4 个调用点显式传入。
- **整改后验证**：zh-CN 与 en-US 两种 locale 下均 **451 全绿**；5 条 en 基线（含新增形状）差异 **0**；e2e `All checks passed`；三环境 PASS；**CI 三 OS 全绿**（34631996615）；**G36 发布产物验证**：`mik 0.2.8`、30 导出、`server.mjs` 在包内、**产物双语实测生效**（zh→「可嵌入的模型层…」/ en→`Embeddable model layer…`）、功能冒烟 `text: g36-028 ok` + `recorded: 1`。
- **编排事故（如实记录）**：本卡先后派了三个 Implementer（我以为前两个已死、实际都在运行）导致三写者竞争 → 已写入铁律「派新 Worker 前必须先查 `list_agents`」；随后编排者**亲自补齐实现**，故本卡判定完全依赖独立 Evaluator——而它**恰恰在编排者盲区找到两处缺陷**，证明了该环节不可省。
- **新增技术债**：**G45**（`tr()` 直调处缺键会渲染空文案——需补与 `hasKey` 同级的兜底断言）；**G46**（e2e 缺一条 `MIK_LANG=zh` 的 dist 冒烟）；**G47**（en 冻结面按「每种错误形状各一条」扩到 8 条，或把 en `--help` 快照进受版本控制的 fixture——`.tmp/` 被 gitignore，基线进不了 CI）；**G48**（`dispatch.ts` 结尾缺换行）；**G49**（zh 的 `cli.missingOptionValue` 照抄了 node 的 `<value>` 占位符，en 侧须继续透传）。

## G11 验收留痕（R68）

- **判定过程（三次尝试，如实记录）**：独立 Evaluator 前两次静默失败 → 编排者依 G04 先例做 orchestrator-applied 裁决（含逐条实测证据）；**第三次重派成功并给出 REJECT**，理由是**本卡自己改的契约文件有两处与代码不符的事实陈述**（功能侧全达标）。编排者核实后确认其正确（并发现自己先前的 `PROTOCOLS` 子串检查有误），随即修完 B1–B4；同进程续跑复核后判定 **ACCEPT**，明确「必须修才能过 = 无」。
- **REJECT 项与整改（全部落地）**：
  - **B1**（假陈述）：`interfaces.md` 把 `PROTOCOLS`/`ProtocolSpec` 放进「已由 `src/index.ts` 导出」的稳定块。实测构建产物 30 个导出中**两者均不存在**（`SDK_PROTOCOLS`/`MODEL_LIST_PROTOCOLS` 才是公开的）→ 已改为「模块级导出、**未进公共面**」。
  - **B2**（配方不全）：文档称「只改 4 处」，但 `src/cli/args.ts` 帮助文案把 7 个协议**写死在字符串里**、`apps/dashboard/lib/types.ts` 有跨包镜像，两处 `tsc` 抓不到 → 已在配方中显式补上「两处镜像/文案落点，会静默过期」。
  - **B3**（措辞失准）：「派生的**只读**视图」实为可变（`test/ai-bridge.test.ts:385-397` 会临时改写 `SDK_PROTOCOLS.openai` 后还原）→ 已改为「勿编辑是**约定**而非类型约束」并点明该测试。
  - **B4**（守卫盲区，**本卡核心价值的补强**）：插值模板动态导入 `import(\`./${x}.js\`)` 会被丢弃解析边 → 可藏真环。已**新增断言「所有相对说明符必须可解析」**并**注入-恢复实测**：插值模板注入 → 该断言**精确报红**；恢复后与 HEAD **逐字节一致**（diff 空、EOF `0A 7D`）。
- **门禁**：tsc 0；全量 **20 files / 447 tests**（基线 435 + 12）；e2e exit 0；三环境 PASS；**CI 两次 push 均三 OS 绿**（34628160871、34628579406）；**G36 发布产物验证通过**（`mik 0.2.7`、30 导出、`PROTOCOLS` 未进公共面、`server.mjs` 在包内、功能冒烟 `text: g36-027 ok` + `recorded: 1`）。
- **新增技术债**：
  - **G41**（守卫仍未覆盖，Evaluator 指出）：`import("./" + n)` 与 `import(path.join(a, b))` 这类**动态表达式完全不可见**（既不进 DFS 也不触发 allowlist 断言）——B4 只封住了「被捕获但解析不到」的相对说明符；另 `import{a}from"…"`（关键字后无空格）漏检。
  - **G42**（流程）：被评审快照请用 **commit sha 固定**（本轮评审期间工作区被并发提交 41efbdd/8d73ee0，Evaluator 需自行做漂移核对）。
  - **G43**（写卡缺陷）：G11 卡 A1 的 grep 断言在**改前改后皆为真**（旧表声明形态不同），属又一处**恒真断言**——与 G09 同类，写卡时须先确认它**现在会红**。
  - **G44**（措辞张力）：`interfaces.md` 中「下次投影时被覆盖」与「不是不可变对象」两句可再统一。

## G10 验收留痕（R57）

- **两位独立 Evaluator 先后判定 ACCEPT**（`98e4a5fd`、`7ecf3213`；均 0 阻断项），各自独立复核：键 45/45 逐个对等、`repl.ts` 全部输出点走 `tr`、`init.ts` 含错误分支与非交互路径全走字典、`git show HEAD` 对照确认 en 侧文案逐字节等价、重试仅对 `ok === false` 且重新取端口、退出码语义未变、`+4` 用例为真断言且强度只增。`7ecf3213` 另做了 3 项独立复跑（112 测试）与 TRACE 残留核对。
- **验收后就地修复三处发现**（均由 Evaluator 指出、编排者实施并复验）：
  - **R1**：`init.ts` 的 `?? "no base URL"` 裸英文回退 → 新增 `init.noBaseUrl` 键（zh/en 对等，46/46）。
  - **R4/R2**：`check-envs.mjs` 的 `--json` 分支**从不 `process.exit`** ⇒ 失败时退出码仍为 0（`--json` 正是 CI 面向模式，接上会**假绿**）→ 补 `process.exit(...)`，实测注入失败后退出码 **1**（修复前 0）。
  - **R6**：重试**成功**时首次失败诊断被丢弃 → 现在 `PASS (retried)` 也打印「首次失败: `<step>`（code n），重试后通过」，实测模拟抖动可见。
- **收尾条件 C1 已满足**：push 后 `gh run watch --exit-status` 三 OS 全绿（run 34626343796）。
- **实证价值**：实现者在本卡首次全量运行中观测到一次真实 `PASS (retried) wsl-ubuntu`——G23 记录的历史假阴被显式化并计数，今后 `PASS (retried)` 应视为**值得留意的抖动信号**。
- **发版闸门 G36 首次执行**：全新目录 `npm i model-infra-kit@0.2.6` → `mik 0.2.6`、30 个导出含 `ModelInfra`、`dist/server.mjs` 在包内、功能冒烟 `text: g36 ok` + `recorded: 1`；其间还实证了 **npm 传播延迟**（发布后约 2 分钟 registry 才可见 `latest`），故 G36 需带轮询等待。
- **登记的新技术债**：**G37**（范围外同族 i18n 债：`usage.ts`/`models.ts`/`pricing.ts`/`serve.ts`/`provider.ts`/`dashboard.ts`/`context.ts`/`dispatch.ts`/`args.ts` 仍有硬编码英文，含 `mik --help` 未本地化）；**G38**（`PASS (retried)` 的护栏可选项：`--strict-retry` 或按 `failedStep` 白名单重试，防偶发产品缺陷被洗成绿）；**G39**（`wizard.nextStepsTitle` 为既有死键；两处测试文件格式瑕疵）；**G40**（`--json` 退出码缺口在 HEAD 早已存在，说明既有脚本缺「退出码」类自检——建议后续为脚本类工具补一条「失败必须非零退出码」的通用用例）。

## G09 验收留痕（R51）

- 独立 Evaluator 判定 **ACCEPT**（7 项全为建议级、0 阻断，见 `.tmp/eval-G09.md`）；它自行复跑全量 431 测试，并**纠正了编排者的一个错误认知**：原 e2e「顺序断言」有**半边恒真**（错误横幅被 `retried && !pending` 包住，SSR 首屏永不出现，故 `bannerAt` 恒为 -1）。
- **验收后修订（已复跑门禁）**：e2e 断言改为**真实不变式**——用 `data-testid` 锚点断言首屏**存在** `upstream-guide`、**不存在** `upstream-error`，并保留指引文案断言；补跑 A5 的 `check-envs`（三环境 PASS）；显式提交两个 untracked 新文件（`upstream-notice.tsx`、`apps/dashboard/test/first-run.test.ts`）。
- **证据**：tsc 0、431 测试、e2e exit 0、三环境 PASS、CI 三 OS 绿（`bf5d0b6`）；真实冒烟（去 shell 后 `mik dashboard` 起 → 3210 → 结束 → 端口释放 → 无孤儿）。
- **新增技术债**：**G32**（`cli.test.ts` 有一条「本机找到 pnpm」的环境断言，在 standalone 安装 pnpm 的 runner 上可能红——本轮 CI 三平台实测绿，若日后红应加环境前置 skip，**不得放宽生产逻辑**）；**G33**（`dashboard.ts` 的 PATH 兜底只认 `node_modules/pnpm/bin/pnpm.mjs`，standalone/Homebrew 装法返回 null）；**G34**（无 `navigator.clipboard` 时「复制命令」静默无反馈）；**G35**（重试后原始错误在中性卡与红横幅重复出现）。

## G08 验收留痕（R45）

- 独立 Evaluator 判定 **ACCEPT**（9 项全 PASS、7 条建议、0 阻断项，见 `.tmp/eval-G08.md`）：它**在 Windows 上强制英文 locale 跑全量 424/424**（自行复刻 runner）、自数键 32/32 且排序深等、`grep` 硬编码 `zh` 零命中、逐行核对三个注入点与公开面（`git diff` 无删除行、11 个导出齐全）。
- **本卡连带修复**：G03–G07 期间潜伏的 CI 红灯（G04 用例的 `exitCode` / POSIX `signalCode` 断言）——本卡首次真正检查 CI 才暴露。
- **验收后修订（已复跑门禁）**：补「公开导出面」源码级断言（覆盖未被 import 的 `LANG_LABELS`/`isLang`，防后续误删）；把直接增删真实 `process.env` 的用例改为纯注入（与 G26 一致）。聚焦 102、全量 **425**、tsc 0。
- **新增技术债**：**G29**（i18n 债：`repl.ts` 的 `Select language (zh / en):`/`Usage: /chat <prompt>` 与 `init.ts` 的 `Wrote …`、英文 `CliUsageError` 仍硬编码，双语承诺未覆盖）；**G30**（`dictFor`/`hasKey` 在 `src/` 内无调用方，卡片第 1.1 条要求「无调用方则删」，本轮因公开面口径保留，留待技术债轮裁定）；**G31**（`tr`/`trBoth` 对「全库无此键」由返回 key 改为返回空串，与 A4「行为不变」字面冲突但与「不回显 key」一致，已声明）。
- **流程纠正**：上一轮「工作区干净」的表述当时不成立（`product-evolution.md` 未提交），现已提交；提交 6c6603b 曾把 G28 跨平台修复与 G08 混在一起（Evaluator 建议后续分开提交）。

## G05 验收留痕（R26）

- 独立 Evaluator（极小判断任务）判定 **ACCEPT**，7 项结论 + 8 条建议（S1-S8）见 `.tmp/eval-G05.md`；编排者已把 S1-S8 **全部就地处理**：S1 头部规则改为「掩掉任意方案的 Authorization 值」（覆盖 ApiKey/Negotiate 与 JSON 引号键形态，补测试）、S2 env 清单补 `MIK_BASE_URL`/`MIK_DASHBOARD_DIR`、S3 修正 `MIK_LANG` 读取位置、S4 总表补 settings 层与 config 文件边界说明、S5 裸 Bearer 改为「仅凭据形态才掩」（消除散文误杀，另补回归测试）、S6 电池 `grep -qF` + 版本非空保护、S7/S8 文档与报告笔误。
- **本卡连带修掉的真实缺陷**：① `Authorization: Basic/digest` 等非 Bearer 方案凭据原样泄露；② 裸 Bearer 规则误掩散文（`the Bearer token is required`）；③ `check-envs` 电池版本断言写死 `mik 0.1` 导致 0.2.0 起三环境必然全红。
- **新增技术债**：G22（优先序测试仅覆盖 `appId`）、G23（三环境电池偶发假阴：本轮 wsl-ubuntu 曾 FAIL 后复跑 PASS，疑似遗留进程占端口，建议加有界重试或端口占用预检加固）。

## 编排运行手册（本会话实测有效，供后续轮次复用）

### 子代理可靠性现状（G21 的实证）
- **Implementer**：首次投递约 50% 概率中途失败（零产出）；**重派同一卡片、并把「第一步就写文件」写进提示词**后可完成（G04/G05 均如此）。
- **Evaluator**：完整清单版失败率高；**只给「任务卡 + 事实证据 + 2-4 个源文件」的极小判断任务**成功率高（G03/G05 均如此）；G04 三次全失败，最终以 orchestrator-applied 裁决 + 偏差记录收尾。
- 前台（`run_in_background: false`）偶发 `subagent run failed`，不可依赖。

### 有效提示词形状（Implementer）
1. 角色一句 + 「你不是最终验收者」。
2. 明确「**第一步就写文件，不要先做长篇探索**」+ 探索上限（≤8-12 次读取）。
3. 编号强制步骤，每步都产出文件；给关键接口草图与已知事实（版本、路径、既有惯例）。
4. 验证命令明确（`tsc --noEmit` + 定向 vitest + 全量），重活允许「跳过并标注」。
5. **必须**把 IMPLEMENTATION_RESULT 写到 `.tmp/impl-<卡号>.md`（最终回复只一句话）。

### 有效提示词形状（Evaluator）
1. 「**假设实现可能存在错误**」，禁止改代码。
2. 只读固定输入（卡 + `.tmp/evidence-<卡号>.md` + 实现 + 测试），读完即判断。
3. 逐项结论 + 证据行号；问题分「必须修才能过」vs「建议登记」。
4. 若上一轮 Implementer 失败/由编排者代做，提示词要写明，并强调「从代码与行为独立判断，不要因缺少实现者报告而 REJECT」。

### 编排者的事实采集职责（不越界）
- 机械门禁由编排者复跑（tsc / 全量 vitest / e2e / 三环境电池）——这是「指挥独立复跑」，不是验收判断。
- 判断类工作（是否满足验收标准、边界是否可接受）必须交给 Evaluator；Evaluator 不可用时，以**预注册标准 + 预注册证据**逐条套用并**记录偏差**（G04 先例）。
- 主动构造边界反例（而非等 Evaluator）：G05 的 `Authorization: Basic` 凭据泄露与 Bearer 散文误杀都是这样抓到的——**「测试全绿」不等于正确**。

### 每轮收尾清单
1. 机械门禁复跑并留存真实输出；2. 独立验收落盘 `.tmp/eval-<卡号>.md`；3. 提交 + 升版（patch）+ `npm publish`；4. `gh release create`；5. 更新本文件的 PRODUCT_STATE / 路线图 / 技术债；6. 选定下一 slice 并开卡。

## G06 验收留痕（R31）

- 独立 Evaluator 判定 **ACCEPT**（7 项结论带行号证据，见 `.tmp/eval-G06.md`）：A1 逐字节保留 + 新库已建表、A3 只读文件不误判且无隔离目录、A4 隔离失败原文件字节不变、A5 用「被问 quick_check 就抛错」的驱动反证确实跳过、driver.ts/hub.ts 为纯修复、无范围外改动。
- **本卡连带修掉的真实缺陷**：`store/driver.ts` 在 `PRAGMA journal_mode` 失败时泄漏句柄，Windows 上导致隔离必然 `EBUSY`（不修则本卡功能不可用）。
- **验收后修订（post-ACCEPT amendment，已复跑门禁）**：Evaluator 独立复现「>64 MiB 库每次 open 都告警」的噪音并建议 per-path 去重；编排者已实现（模块级 `Set<path>`，每进程每库一次）并补测试，G06 专项 **8/8**、全量 **390/390**、e2e exit 0、三环境 PASS。
- **新增技术债 G24（G06 建议项）**：① ~~大库告警去重~~（已修）；② A4 部分失败文案「still there」表述不准；③ 锁冲突缺独立用例；④ 契约写清 `-wal` 损坏时三件套一并隔离的真实行为（与卡片字面偏好有偏差）；⑤ 健康库带残留 `-wal`/`-shm` 未测；⑥ 符号链接边角（Windows 无法创建，实测 EPERM）。
## 方向裁决：G10（协议运行时注册）——本轮不开卡（R37）

**事实采集**：`Protocol` 是闭联合（`types.ts:7`）；协议落点为两张静态表 `SDK_PROTOCOLS`（`ai/protocols.ts:37`）与 `MODEL_LIST_PROTOCOLS`（`:246`）加 `PROTOCOL_PACKAGES`（`registry/presets.ts:17`）与预设表；宿主的既有逃生口是 `openai-compatible`（任何 OpenAI 兼容网关都能直连，无需新协议）。

**裁决**：拆成两级，**本轮都不做**。
- **G10a（LATER，低风险）**：把两张协议表合并为单表 + 在 `docs/interfaces.md` 写一份「新增内置协议的五处落点」配方。目的是降低**内置**扩展的单点改动面，**不改公共 API**。收益中等、成本低，可作为技术债清理项。
- **G10b（NOT_NOW）**：面向宿主的 `registerProtocol()` 运行时注册。不做的理由：① 宿主有 `openai-compatible` 逃生口，未被真实需求证明；② 需要把 `Protocol` 从闭联合改为开放字符串，动摇「协议是一等公民、按数据映射」的类型约束与 `Record<Protocol, …>` 的穷尽性检查；③ 引入「宿主注册坏协议」的新失败面与文档/契约成本；④ 竞品调研明确反对「为对齐竞品而扩能力」，而架构审计也只把「合并单表」列为建议。**复评条件**：出现真实宿主需求（需要非 OpenAI 兼容 SDK 的网关）且 `openai-compatible` 无法覆盖时，再评估开卡。

> 依据：`.tmp/audit-architecture.md` 4.1（协议扩展 5 处静态表）、`.tmp/audit-competitor.md` 第三节（❌ 不做清单与「禁止竞品照抄」原则）。

## G07 验收留痕（R41）

- 独立 Evaluator 判定 **ACCEPT**（8 项结论带行号证据，见 `.tmp/eval-G07.md`）：A1–A6 均有代码与实测双证，独立复跑 budget 15/15、tsc exit 0；自行 grep 证实 `costMicros` 全 src 唯一调用链在 init、运行期真零 SQL。
- **验收后修订（post-ACCEPT amendments，已复跑门禁）**：S2 补 driver 级 SQL 计数用例（对照组同驱动，锁定「预算不引入额外 SQL」）→ budget 用例 15→17；S4 补「宿主 onWarn 抛错仍不重复告警」用例；S3 修正契约两处措辞（「每实例」而非每进程、appId 严格相等而非「空串计零」）。全量 **407** 测试全绿、tsc 0。
- **S1（行为变化，已写入 release note）**：`hub.ts` 现向 `UsageService` 传 `onWarn`，使既有 `onEvent` 抛错的诊断从「死代码静默」变为「上报一条」；Evaluator 认可这是补齐既有承诺，编排者裁定保留并记录。
- **新增技术债 G25**：预算基数只汇总 `usage_events` 明细行、不含已折叠 `usage_daily_rollups`（方向只会让告警偏晚、不误报，已在两处文档写明）。
### 每轮收尾清单
1. 机械门禁复跑并留存真实输出；2. 独立验收落盘 `.tmp/eval-<卡号>.md`；3. 提交 + 升版（patch）+ `npm publish`；4. `gh release create`；5. 更新本文件的 PRODUCT_STATE / 路线图 / 技术债；6. 选定下一 slice 并开卡。

### 铁律增补（R41-R42 血的教训）

- **G26｜每次 push 必须查 CI，直到出结论**（`gh run watch <id> --exit-status`）。理由：本编排者的本地门禁只在 Windows 跑 vitest，**平台与 locale 专属失败在 Windows 上永远不出现**；三环境电池只跑 CLI/服务冒烟、**不含 vitest**。R41 发现连续 5 次 push（G03→G07）CI 全红却未察觉，直到第 6 次才查出 G04 的 `exitCode` / POSIX `signalCode` 断言缺陷。
  - 推论：**涉及平台分支（win32/POSIX）、locale、时区、路径分隔符、信号、文件权限的改动，必须以 CI 三 OS 结果为准**，本地绿不算数。
  - 推论：新写的测试若依赖**运行环境**（locale/时区/平台），必须**注入**该环境变量，否则在别的 runner 上必然假红。
- **G27｜实现者运行期间禁止 `git add -A`**。理由：R41 把 G08 实现者「临时删一个 i18n 键以自证对等测试会红」的**中间态**折进提交，导致 CI 出现假失败（32 vs 31 键），浪费一轮且污染历史。
  - 做法：只 `git add <自己改的文件>`；或等实现者交付、工作区稳定后再统一提交。
- **G28｜跨平台测试断言的写法**：进程终止用 `exitCode !== null || signalCode !== null`（POSIX 信号死亡只设 `signalCode`）；已修 G04 遗留用例。
### 发版闸门增补（R53）
- **G36｜发版后必须验证「已发布产物」可装可用**：`npm publish` 后在一个**全新临时目录**执行 `npm i model-infra-kit@<版本>`，然后验四件事——① `node node_modules/model-infra-kit/dist/cli.mjs --version` 输出与发布版本一致；② 库面导出可用（`ModelInfra` 在 `dist/index.mjs` 中）；③ `dist/server.mjs` 随包发布；④ **真实功能冒烟**（起本地 mock → `ModelInfra.init` → `generate` → 断言文本与 `usage` 且 `summary().requests === 1`）。
- 理由：仓库内 e2e 的 DIST 检查点只验**仓库 dist**，不验 **npm 产物**（`files` 白名单、子路径导出、peer 依赖解析都只在装包后才暴露）。R53 实测 0.2.5：安装干净、`mik 0.2.5`、30 个导出含 `ModelInfra`、`dist/server.mjs` 存在、功能冒烟 `text: release smoke ok` + `requests recorded: 1`。


## EVO-G10 留痕（R55）— 技术债清理轮：i18n 残留 / 死导出裁定 / 电池重试 / G20 结论

- **G29（i18n 残留）已收敛**：`cli/repl.ts` 与 `cli/commands/init.ts` 的用户可见文案全部改走字典（新增 `repl.langPrompt`/`repl.chatUsage` 与 `init.*` 系列键，zh/en 同名对等）；`mik init` 的输出结构与顺序保持不变（命令示例、路径、变量名原样，只替换说明文案），两处英文 `CliUsageError` 改为按当前语言取文案。
- **G30（死导出）裁定：保留**。`dictFor`/`hasKey` 在 `src/` 内无调用方，仅在测试与宿主侧使用；因 G08 已把「11 个导出齐全（只增不减）」写进契约，删除会与公开面契约冲突，故在 `docs/interfaces.md` F16 的 `@internal` 风格小节登记（宿主便利、不承诺 semver），并写明删除时的同步改法。
- **G23（电池假阴）已收敛**：`scripts/check-envs.mjs` 对**失败的环境**自动重试**一次**（重试前用 `pickPort` 重新分配动态端口），重试成功记 `PASS (retried)` 并在摘要标注；**重试仍失败 → FAIL**，退出码语义不变（0 全通过 / 1 有失败 / 2 用法错误）。已用「临时改坏版本断言」自证：重试后仍 FAIL、退出码非 0。
- **G20 结论入档**：非 win32 分支已由 CI 三 OS 全量单测覆盖（G08 之后 CI 会跑 `child-supervision.test.ts`）；**真实 SIGINT 端到端降级为 LATER**（理由：需真实 TTY/信号注入，成本高于收益）。
## 路线图调整（R59）：G37 提升优先级（有证据）

**实证（从已发布 0.2.6 产物，非源码推断）**：在全新目录 `npm i model-infra-kit@0.2.6` 后——

- `MIK_LANG=zh` 与 `MIK_LANG=en` 下裸 `mik`（非 TTY）输出**完全相同且为英文**的横幅（`model-infra-kit (mik) 0.2.6` + `Embeddable model layer: ...`）。
- `MIK_LANG=zh` 下 `mik nonexistent-cmd` 仍是英文：`error: Unknown command "nonexistent-cmd". Run "mik --help" for the list of commands.`

**裁决**：G37 中「`--help` 横幅 + 未知命令/用法错误」这一子集从「同类技术债」提升为 **NEXT（下一个 slice，紧随 G11）**。理由：语言设置（G02/G08）已宣称 CLI 双语，但用户最常见的第一条命令 `mik --help` 仍是英文——属**承诺与体验不一致**，成熟度上的真实缺口；且改动集中在 `args.ts`/`dispatch.ts`/`context.ts` 的文案层，成本可控（区别于 G37 里其余命令的输出本地化，仍留在 LATER）。
**排队理由**：G11 的 G19 也改 `dispatch.ts`，同文件并发会互相干扰，故 G37 子集排在 G11 之后。

