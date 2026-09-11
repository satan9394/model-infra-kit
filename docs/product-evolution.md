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
- **进行中**：G05（tasks/EVO-G05-redact-contract.md）= G12 脱敏加固 + G08 配置优先级总表 + G13 契约补全（env 清单 / ModelInfraConfig 字段）。
- **已开卡待派**：G06（tasks/EVO-G06-db-corruption-selfheal.md）= G11 SQLite 损坏自愈（隔离不删除 + 空库续启 + 醒目告警 + 大库跳过）。
- **后续候选（未开卡）**：G14（成本对账文档 + 软预算告警，竞品论证的「计费可信度」价值项）、G09（i18n 扩展成本 / 语言检测）、G10（协议运行时注册）。
- **技术债队列**：G15 非法语言二次重选提示、G16 README 版本动态化、G17 index.ts 换行（已在 G04 顺带修）、G18 防环断言升级为目录级 import 图检测、G19 runCommand/main 抽公共前置段、G20 G04 残余（真实 SIGINT 端到端 / 非 win32 分支 / 孙进程链——建议在 ubuntu+macos CI runner 补强）、G21 流程债（子代理失败率与既定对策）。
- **NOT_NOW（拒绝清单，维持）**：虚拟 key/key 池、RPM/TPM 硬限额、观测性深度（trace/eval/playground）、智能路由与自动 failover、多租户/团队、云同步/多实例聚合、兑换码与面向终端的充值计费、任何纯装饰功能（主题色等）。

## PRODUCT_STATE（R31，G01-G06 已验收关闭）

- **当前成熟度**：v0.2.2，P0+P1 清零，P2 两项完成（G05 脱敏+契约、G06 账本损坏自愈）；**390 测试全绿、e2e exit 0、三环境电池 PASS**。
- **本轮最高价值下一步**：G07（成本对账文档 + 软预算告警，第七 slice，卡片已就绪）；其后 G09（i18n 扩展）、G10（协议运行时注册）。
- **技术债**：dashboard 子进程孤儿（下一步 G04）、单字典 i18n（G09）、as unknown as 6 处、契约漂移（G08/G13）、DB 恢复缺失（G11）、runCommand/main 重复前置段、防环断言仅覆盖单写法、index.ts 末尾换行丢失（G17）。
- **风险**：none 阻塞级；子代理在审计阶段曾跑死（已用「文件交付 + 前台/上限」协议解决）。

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

