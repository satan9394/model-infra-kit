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

## 路线图

- **NOW**：G01（P0 安全集群，本轮 vertical slice）。
- **NEXT**：G02、G03、G04、G05、G06、G07（P1 集群；G07 一行、G06 纯文档，成本极低合入）。
- **LATER**：G08、G09、G10、G11、G12、G13、G14（软预算/对账文档/可选同步）。
- **NOT_NOW（拒绝清单）**：竞品 DON'T 清单（虚拟 key、限额硬执行、观测性、路由/failover、多租户、云同步、充值计费）+ 纯装饰（主题色等）。

## PRODUCT_STATE（R19，G01-G04 已验收关闭；P1 集群清零）

- **当前成熟度**：v0.2.0，**P0+P1 缺口全部关闭**（G01 安全默认 / G02 REPL+向导+i18n 契约 / G03 环收敛 / G04 dashboard 子进程托管）；371 测试全绿、e2e exit 0、三环境电池 PASS。
- **本轮最高价值下一步**：G05（redact 脱敏加固 + 配置/契约真相表，第五 slice，卡片已就绪）；其后 LATER 集群（G11 DB 恢复 / G09 i18n 扩展 / G10 协议注册 / G14 成本对账与软预算）。
- **技术债**：dashboard 子进程孤儿（下一步 G04）、单字典 i18n（G09）、as unknown as 6 处、契约漂移（G08/G13）、DB 恢复缺失（G11）、runCommand/main 重复前置段、防环断言仅覆盖单写法、index.ts 末尾换行丢失（G17）。
- **风险**：none 阻塞级；子代理在审计阶段曾跑死（已用「文件交付 + 前台/上限」协议解决）。



