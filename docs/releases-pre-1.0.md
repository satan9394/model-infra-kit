# pre-1.0 Release notes 存档（`v0.1.0` – `v0.3.1`）

> **为什么有这份文件**：GitHub Releases 页已按人类要求**归一化**——42 条逐版 Release 收成一条
> `v1.0.0`（其说明即 `CHANGELOG.md` 的 5 段归纳）。**删除前先在这里全文归档**，因为这些说明是
> 每一次修复的原始记录（正文逐字保留，未改写）。**tag 未删**，仍指向各自 commit。
>
> 归档时间：2026-09-13 · 条数：42

## `v0.1.0` — v0.1.0 — 首个可用版本

_published 09/09/2026 16:04:27_

## model-infra-kit v0.1.0

可嵌入任意 AI 项目的模型层：多供应商调用、模型目录、token 用量、模型计价与成本统计。

### 安装

`ash
npm i https://github.com/satan9394/model-infra-kit/releases/download/v0.1.0/model-infra-kit-0.1.0.tgz
npm i @ai-sdk/openai-compatible   # 你实际用的 provider 包（可选 peer）
`

### 包含

- model-infra-kit（库）：`ModelInfra.init()` / `generate` / `stream` / `fetch` / `providers` / `models` / `pricing` / `usage`
- `model-infra-kit/server`：HTTP API + SSE + OpenAI 兼容端点
- `model-infra-kit/cli` + `mik` 命令：init / serve / dashboard / provider / models / pricing / usage

### 不含

看板（`apps/dashboard`）不随包发布，见仓库 README。

### 验证状态

317 个单元测试、12 项端到端验收（`node scripts/e2e/run.mjs`）全部通过。

---

## `v0.1.1` — v0.1.1 — CORS / 嵌入路由 / 用量上报

_published 09/10/2026 10:28:38_

## model-infra-kit v0.1.1

修复与新增：

- **`mik serve --cors <origin>`**（T14）：允许浏览器直连取数；`'--cors *'` 任意源，`--cors https://主站` 固定源。默认关闭。
- 看板新增**可嵌入路由** `/embed/overview|trends|logs|pricing`（无导航、SSE 实时、默认近 7 天），宿主 iframe 或反代即可嵌入。
- 新增 `POST /api/usage/events` 上报入口（宿主自己调模型、只上报用量，requestId 幂等、服务端计价）。
- 仓库已公开：Release 直链安装可用。

`ash
npm i https://github.com/satan9394/model-infra-kit/releases/download/v0.1.1/model-infra-kit-0.1.1.tgz
npm i @ai-sdk/openai-compatible   # 你实际用的 provider 包（可选 peer）
`

验证：332 个单元测试、12 项端到端验收全部通过。

---

## `v0.1.2` — v0.1.2 — 已发布 npm / 文档通用化

_published 09/10/2026 10:43:40_

## model-infra-kit v0.1.2

- 已发布到 npm registry：`npm i model-infra-kit`（+ provider 包）。
- 文档通用化：安装命令改为占位符（`<你的账号>/<仓库名>`），移除个人化引用。
- 此 tarball 与 npm 包内容一致，供离线/私有场景使用。

---

## `v0.1.4` — v0.1.4 — 修复 Linux/macOS bin 符号链接

_published 09/10/2026 11:28:02_

## model-infra-kit v0.1.4

- **修复（重要）**：`mik` 在 Linux/macOS 上通过 npm bin 符号链接执行时静默无输出（`isDirectInvocation` 未解析符号链接）。已修复并回归测试覆盖（`isDirectInvocation (Unix bin symlink)`）。
- 验证：Windows PowerShell / Git Bash / WSL Ubuntu 三种环境全部实测通过（CLI、`mik serve`、curl、嵌入式库、node:sqlite）。
- 安装：`npm i model-infra-kit`。

---

## `v0.1.5` — v0.1.5 — 跨平台修复 + CI 三 OS 全绿

_published 09/10/2026 16:43:32_

## model-infra-kit v0.1.5

- 跨平台修复：`netstat` 端口探测兼容 Linux `LISTEN`（原只认 Windows `LISTENING`）；e2e 的 python 解析改为可移植（`python3`/`python` 自动探测，可 `MIK_E2E_PYTHON` 覆盖）。
- **CI 三 OS 全绿**：GitHub Actions 在 ubuntu / macos / windows 上跑单测、看板构建、三环境电池与端到端验收全部通过（没有 Mac 实机也能靠 macOS runner 完成回归）。

---

## `v0.1.6` — v0.1.6 — 首次向导 + 双语斜杠命令 REPL

_published 09/11/2026 04:41:53_

## model-infra-kit v0.1.6 — 引导 + 交互模式

- **首次运行向导**：`mik init` 交互终端里先选语言（1: 中文 / 2: English），再配置应用/库/供应商，随后按所选语言给「上手三步」。
- **交互模式 REPL**：终端里直接 `mik` 进入；斜杠命令带「中文 / English」双语说明（/help /lang /providers /models /pricing /usage /chat /exit），自由文本直接对默认模型说话，Ctrl+D 或 /exit 退出；`/lang` 持久化（`MIK_LANG` 环境变量优先）。
- 新增 `readSetting`/`writeSetting`（小设置持久化，契约见 docs/interfaces.md）；i18n 字典 + 17 个新测试（全量 351 通过，e2e 12/12，三环境电池 PASS）。

---

## `v0.1.7` — v0.1.7 — serve 默认安全（G01）

_published 09/11/2026 10:41:53_

## model-infra-kit v0.1.7 — serve 默认安全（G01，独立评估 ACCEPT）

- **安全默认**：无 token 时 mik serve 写端点一律 401（GET 读端点与 /api/health 保持公开）。
- **SSRF 防护**：refresh / pricing-sync / provider-test 出站前校验 baseUrl（仅 http/https，禁链路本地与云元数据地址，放行本地 loopback）。
- **计量防伪造**：POST /api/usage/events 禁止覆盖 appId。
- **Content-Type 门**：JSON 端点仅接受 application/json（否则 415），封死浏览器 no-cors 简单请求通道。
- 验证：tsc 0 错、356 测试全绿（server.test.ts 56 含 A1–A5）、e2e exit 0、三环境电池 PASS；由独立 Evaluator 按验收标准复核后 ACCEPT。

---

## `v0.1.8` — v0.1.8 — REPL/向导体验 + i18n 契约（G02）

_published 09/11/2026 11:10:37_

## model-infra-kit v0.1.8 — REPL/向导体验 + i18n 契约（G02，独立评估 ACCEPT）

- REPL 提示符修复为 `mik>`（不再泄露调试键名）。
- 裸 `/lang` 复用 REPL 自身的 readline（消除双 readline 抢 stdin），语言解析收敛到单一 `resolveLang`（MIK_LANG → cli.lang → zh）。
- `mik init` 向导：语言解析遵循契约（读 `cli.lang` 设置）、提问文案跟随所选语言、非法输入给提示并重选。
- 文档事实校对：版本号、npm 发布状态、--cors、/api/usage/events、升级路径五处与实机一致。
- 验证：tsc 0 错、362 测试全绿、e2e 全 PASS、三环境电池 PASS；独立 Evaluator ACCEPT。

---

## `v0.1.9` — v0.1.9 — 架构：收敛 cli↔repl 循环依赖（G03）

_published 09/11/2026 14:16:39_

## model-infra-kit v0.1.9 — 架构：收敛 cli↔repl 循环依赖（G03，独立评估 ACCEPT）

- 新增 `src/cli/dispatch.ts`：命令分发与 `runCommand` 从此独立，`index → repl → dispatch` 单向依赖，原 `repl → index` 回边消除（src 内已无任何文件 import cli/index.ts）。
- 行为零变化：由 HEAD 迁出的 47 行经独立 Evaluator 逐行比对 **0 缺失**；`main()`/导出面（`EXIT_*`/`helpFor`/`main`/`parseCliArgs`…）逐字保持；实测退出码 0/2 不变；76/76 CLI+REPL 回归通过。
- 全量：tsc 0 错、363 测试、e2e exit 0、三环境电池 PASS。
- 登记技术债（建议级）：runCommand/main 约 10 行重复前置段、防环断言仅覆盖单写法、index.ts 末尾换行待补。

---

## `v0.2.0` — v0.2.0 — P0+P1 缺口清零（dashboard 子进程托管）

_published 09/11/2026 14:35:20_

## model-infra-kit v0.2.0 — P0+P1 缺口清零（G04 dashboard 子进程托管）

- mik dashboard 现在托管 Next.js 子进程生命周期：父进程收到 SIGINT/SIGTERM 或退出时终止**整个进程树**（Windows 用 	askkill /pid <pid> /T /F，因 pnpm → next 有孙进程；其它平台 SIGTERM + 200ms SIGKILL 兜底），幂等、第二次 Ctrl+C 不被吞（监听器 once 注册）。
- README 补充限制说明：SIGKILL 无法拦截，强杀后如端口占用可换 --port 或手动 	askkill。
- 验证：371 测试全绿（含 8 例托管器单测、1 例真子进程回收集成例）、tsc 0 错、e2e exit 0、三环境电池 PASS、真实 mik dashboard 冒烟（next 监听 3210 → 结束 next → CLI 退出 + 端口释放 + 无孤儿）。
- 本轮四卡累计：G01 serve 安全默认（0.1.7）→ G02 REPL/向导+i18n 契约（0.1.8）→ G03 架构断环（0.1.9）→ G04 子进程托管（0.2.0）。P0 与 P1 缺口全部关闭，进入 P2 集群。

---

## `v0.2.1` — v0.2.1 — 脱敏加固 + 配置/契约真相表（G05）

_published 09/11/2026 15:09:58_

## model-infra-kit v0.2.1 — 脱敏加固 + 配置/契约真相表（G05，独立评估 ACCEPT）

- **密钥脱敏加固**：`Authorization` 头不区分方案一律掩掉凭据（Bearer/Basic/Digest/Token/ApiKey/Negotiate…），支持 JSON 引号键形态；key=value 值不再有长度下限（`token=x`、`api_key=ab+/=` 均覆盖）；已知前缀（`sk-`/`tvly-`/`ghp_`…）任意长度都掩。
- **消除误杀**：裸 `Bearer` 仅在值是凭据形态（含数字或 `-_.+/=~`）时才掩码 —— `the Bearer token is required` 这类散文不再被破坏；`token counts are 12` 原样保留。
- **契约真相**：`docs/interfaces.md` 新增配置优先级总表（CLI 四层 / 库三层，差异为有意设计）、env 清单（10 个实测变量）、`ModelInfraConfig` 字段清单；优先序由测试锁定。
- **测试基建修复**：`check-envs` 电池版本断言改为与 `package.json` 比对（此前写死 `mik 0.1`，0.2.0 起三环境必然全红）。
- 验证：tsc 0 错、**382 测试全绿**、e2e exit 0、三环境电池 PASS；独立 Evaluator ACCEPT（7 项结论 + 8 条建议已全部就地处理）。

---

## `v0.2.2` — v0.2.2 — 账本损坏自愈（G06）

_published 09/11/2026 15:26:03_

## model-infra-kit v0.2.2 — 账本损坏自愈（G06，独立评估 ACCEPT）

- **启动不再被坏库卡死**：打开文件型库时在 `migrate` 前做 `PRAGMA quick_check`；仅**明确损坏签名**（`SQLITE_CORRUPT` / `SQLITE_NOTADB` / `malformed` / `not a database`）才判定为损坏，锁冲突与权限问题**不会**被误判。
- **隔离不删除**：损坏的主库与 `-wal`/`-shm` 一并**移入** `~/.model-infra-kit/trash/db-corrupt-<UTC 时间戳>/`（先 `rename`，跨设备才复制后删源，失败最多复制、永不丢数据），随后以空库继续启动并发醒目告警（含隔离路径与抢救指引）。
- **守住不阻塞**：库大于 64 MiB 时跳过完整性检查（只提示一次，不再每次启动刷屏）。
- **顺带修复**：`store/driver.ts` 在 `PRAGMA journal_mode` 失败时泄漏句柄（Windows 上会让隔离必然 EBUSY 失败）。
- 验证：tsc 0 错、**390 测试全绿**（G06 专项 8 例，含逐字节保留、移动非复制、只读不误判、隔离失败字节不变、大库确实跳过）、e2e exit 0、三环境电池 PASS；独立 Evaluator ACCEPT。

---

## `v0.2.3` — v0.2.3 — 成本对账 + 软预算告警（G07）

_published 09/11/2026 15:54:33_

## model-infra-kit v0.2.3 — 成本对账文档 + 软预算告警（G07，独立评估 ACCEPT）

- **软预算（默认关闭、只告警不硬执行）**：`ModelInfra.init({ budget: { usd, window: "day"|"month", onExceed: "warn" } })`。越阈时经 `onWarn` 提示一次（每实例每窗口每 appId），UTC 日/月界自动归零；**绝不**阻断、排队、限流或拒绝请求。
- **性能**：唯一预算 SQL 只在 init 汇总一次窗口基数（整数微美元），运行期是内存累加 —— 每次 `record()` **不做任何额外 SQL**（由新增的 driver 级计数用例锁定）。失败静默：未配置零开销、非法配置忽略并提示一次、汇总失败以 0 为基数继续。
- **成本对账文档**（`docs/cost-reconciliation.md`）：计量口径（cache/reasoning 拆分）、价格优先级（手动 > models.dev > 内置兜底）与 `cost.source`/`cost.basis` 含义、缺价行为（cost 0 且 `source: "missing"` 不代表免费）、整数微美元精度理由、可执行排查清单（复现某行成本、UTC 日界、缓存命中、阶梯折扣等常见差异来源）。
- **行为变化（须知）**：`hub` 现在把 `onWarn` 接入用量服务——此前宿主 `onUsage` 监听器抛错会被静默吞掉，现在会作为一条告警上报（补齐既有设计承诺）。
- 验证：tsc 0 错、**407 测试全绿**、e2e exit 0、三环境电池 PASS；独立 Evaluator ACCEPT（S1–S4 建议已全部处理）。

---

## `v0.2.4` — v0.2.4 — i18n 架构 + 系统语言检测（G08）

_published 09/11/2026 16:18:48_

## model-infra-kit v0.2.4 — i18n 架构收敛 + 系统语言检测（G08，独立评估 ACCEPT）

- **按语言分文件**：`src/cli/i18n/{zh,en}.ts` 各 32 键；`cli/i18n.ts` 合成 catalog；**键集合对等由排序深等断言守住**（新增语言只需加一个文件，漏键立刻红）。
- **系统语言检测**：解析顺序 `MIK_LANG → cli.lang → OS locale → en`（`LC_ALL → LC_MESSAGES → LANG → Windows Intl`）；畸形值回落 `en`；不支持的 `MIK_LANG` 视为未设置；**显式设置过语言的用户行为完全不变**。
- **缺键绝不回显 key**（G05 曾踩过界面出现调试键名的坑）；新增「公开导出面」源码级断言，防止后续误删 11 个既有导出。
- **边界声明**：README 明确「CLI/REPL 支持 zh/en 可切换；**看板当前仅中文**」。
- **顺带修复**：清掉 G03–G07 期间潜伏的 CI 红灯（跨平台断言用 `exitCode`/`signalCode` 双判）。
- 验证：**425 测试全绿**、CI 三 OS 全绿、e2e exit 0、三环境电池 PASS；独立 Evaluator ACCEPT（含强制英文 locale 复刻 runner 的全量复跑）。

---

## `v0.2.5` — v0.2.5 — 看板首启体验 + 可发现性（G09）

_published 09/11/2026 16:54:52_

## model-infra-kit v0.2.5 — 看板首启体验 + 装包用户可发现性（G09，独立评估 ACCEPT）

- **首屏先指引、后报错**：上游 `mik serve` 不可达时，第一块是中性信息样式的「先启动上游」指引（含复制命令、端口提示、装包用户指引）；红字错误横幅**降级为「点过重试仍失败」才出现**，不再出现「先报错后解释」。
- **六页统一**：overview/trends/logs/pricing/models/providers 全部改用同一个 `UpstreamNotice` 组件（视图内不再直接用 `ErrorBanner`），并有逐页断言守住。
- **README 前置**：嵌入式接入小节内直接给出「查看用量」的三条 CLI 命令与 `/api/*` 自建 UI 路径。
- **去掉 shell 注入面**：`mik dashboard` 的 win32 分支不再用 `shell`（改为显式 `pnpm.mjs` 路径），启动/退出行为不变（真实冒烟：3210 监听 → 结束 → 端口释放 → 无孤儿）。
- **e2e 断言升级**：首屏顺序改用 `data-testid` 锚点并断言「error 横幅在首屏**不存在**」——原写法有半边恒真，已被独立 Evaluator 指出并修正。
- 验证：431 测试全绿、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；独立 Evaluator ACCEPT（7 项建议，其中 3 项已就地处理）。

---

## `v0.2.6` — v0.2.6 — 技术债清理（G10）

_published 09/11/2026 17:15:07_

## model-infra-kit v0.2.6 — 技术债清理轮（G10，双评估独立 ACCEPT）

- **CLI 双语覆盖补齐**：`/lang` 无参提示、`/chat` 用法、`mik init` 全部用户可见文案（含两处 `CliUsageError`、注册成功/失败行、三条 Next steps 命令示例行）改走 i18n 字典；zh/en 各 46 键**逐个对等**；输出结构、命令示例、路径、变量名、对齐空格全部原样（en 侧与改前逐字节等价）。
- **注册失败文案过 `redact()`**：错误路径不再可能带出凭据片段。
- **`dictFor`/`hasKey` 裁定为 `@internal` 风格**：保留导出（不缩公开面，与既有契约自洽），在 `docs/interfaces.md` 登记「`src/` 内无调用方、不承诺 semver」。
- **三环境电池有界重试**：失败环境自动重试**一次**（SKIP 不重试），重试前**重新分配端口**；重试成功记 `PASS (retried)` 并**打印首次失败的步骤与退出码**（抖动可诊断，不只是噪声）；重试仍失败 → FAIL。**`--json` 模式补上退出码**（此前失败时仍返回 0，接 CI 会假绿）。
- 验证：435 测试全绿、e2e exit 0、三环境 PASS、**CI 三 OS 全绿**；两任独立 Evaluator 均判 ACCEPT，其 3 处发现（裸英文回退、`--json` 退出码、重试诊断缺失）已全部就修。

---

## `v0.2.7` — v0.2.7 — 架构整洁度（G11）

_published 09/11/2026 17:39:09_

## model-infra-kit v0.2.7 — 架构整洁度（G11，独立评估 REJECT→整改后 ACCEPT）

- **协议表合并为单一源表**：`PROTOCOLS`（`protocol → { sdk, list }`）成为唯一真相，`SDK_PROTOCOLS` / `MODEL_LIST_PROTOCOLS` 改为派生视图；**公开导出面不变（仍 30 个）**。新增内置协议的编译期落点由 5 处降到 4 处。
- **目录级环守卫**（新增 `test/module-graph.test.ts`）：递归扫描 `src/**` 全量文件，覆盖静态单/双引号、跨行、`export … from`、re-export、`import type`、副作用导入、动态三种引号与裸变量形态（白名单钉死）；断言全图无环、`index → repl → dispatch` 方向无反向边，并有「合成图能检环」自证防止守卫恒绿。
- **消除守卫盲区**：新增断言「所有相对说明符必须可解析」——插值模板动态导入（`import(\`./${x}.js\`)`）此前会被静默丢边、可藏真环，现在会直接报红（已用注入-恢复实测红/绿）。
- **CLI 前置段收敛**：`runCommand` 与 `main` 共用 `prepareInvocation`（parse → version → help）；TTY→REPL 分叉仍归 `index.ts`，行为零变化。
- **文档与契约订正**（评估 REJECT 项）：`interfaces.md` 修正两处与代码不符的陈述——`PROTOCOLS`/`ProtocolSpec` 标注为「模块级导出、未进公共面」（此前误列入「已由入口导出」的稳定块），协议配方补齐两处 `tsc` 抓不到的镜像落点（`cli/args.ts` 帮助文案、看板 `lib/types.ts`）。
- 验证：**447 测试全绿**、tsc 0 错误、e2e exit 0、**CI 三 OS 全绿**。

---

## `v0.2.8` — v0.2.8 — CLI 入门面本地化（G12）

_published 09/11/2026 18:15:27_

## model-infra-kit v0.2.8 — CLI 入门面本地化（G12，独立评审 REJECT → 整改后 ACCEPT）

- **入门面双语**：`mik`、`mik --help`、`mik -v`、未知命令/未知选项/缺参数等**框架文案**随 `MIK_LANG → OS locale → en` 解析；命令名、参数名与 `usage` 示例保持英文（可复制）。
- **覆盖全部子命令 help 页**：provider / usage / pricing / models / serve / dashboard / init 的帮助页标题与说明均本地化（实测 10/10 路径无英文框架残留）。
- **英文面逐字零回归**：以**已发布 0.2.7 产物**为基线，5 类错误形状 + 9 条 en 路径逐字节比对，差异 0、退出码 0/2/2/2 全对。
- **评审整改（两项均为独立评审发现的真实缺陷）**：
  1. `en` 下「放错位置的已知选项」文案多出一对引号（`"--port"` vs `--port`）——补第 5 条基线并修正字典值；
  2. 缺参数的语言解析**读了真实 `process.env`** 而非注入的 `RunOptions.env`，导致英文 locale 下中英混排、**CI 三 OS 必红**（本机 zh-CN 出现「假绿」）——改为按注入 env 解析。
- 验证：**451 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

---

## `v0.2.9` — v0.2.9 — provider/usage 输出本地化（G13）

_published 09/11/2026 18:56:12_

## model-infra-kit v0.2.9 — 子命令输出本地化（G13，独立评估 ACCEPT）

- **`provider` 与 `usage` 的输出双语**：`provider list` 表头、`provider add/remove/test` 提示、`usage summary/logs/trends/export` 的标签与空态全部走 zh/en 字典（字典 81 → 162 键，两侧逐个对等）。
- **表格对齐支持 CJK 宽度**：新增显示宽度计算（East Asian Wide/Fullwidth），中文表头/中文名按 2 列宽补齐，表格不再错位；**纯 ASCII 输出逐字节不变**。
- **数据值不译**：provider id、协议名、模型 id、URL、金额、时间戳、计数、`app=`/`provider=`/`model=`/`status=` 键名与 **CSV 列名**全部保持原文。
- **英文面零回归**：以已发布 0.2.8 产物为基线、同一调用方式对照 6 条路径（含 `usage trends` 全表头）差异为 0。
- **工具钉语言**：三环境电池断言英文文案，故 `battery.{sh,ps1}` 钉 `MIK_LANG=en`（工具不是用户，不跟随机器 locale）。
- 验证：**466 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

> 本版同时修复了测试基建的两处缺陷（由 CI 三 OS 抓出）：冻结的英文快照曾把**版本号**写死（每次发版必红）且对**换行符**敏感（Windows 上 Git 会把 `.txt` 检出为 CRLF）——现已归一化版本号与换行符，并新增 `.gitattributes` 将 `*.txt` 固定为 LF。

---

## `v0.2.10` — v0.2.10 — CLI 层双语收尾（G14）

_published 09/11/2026 19:30:58_

## model-infra-kit v0.2.10 — CLI 层双语收尾（G14，独立评估 ACCEPT）

- **收完 CLI 层剩余英文**：`models`、`serve`、`pricing`、`dashboard` 的用户可见文案全部走 zh/en 字典；字典 162 → **225 键**（两侧逐个对等）。
- **框架前缀一致**：`warning:` 与既有 `error:` / `usage:` 同口径中文化；**第三方正文不包装**（如 `llm-pricing` 的 `source "…" failed to load` 保持原文，属已声明的跨层边界）。
- **错误类消息补齐**：`--port` 非法与被占用的两条 `CliRuntimeError` 文案本地化（这类「`throw` 出来的用户可见文案」曾不在自检口径内）。
- **`pricing list` 状态块**：标签（`状态`/`来源`/`载入`/`错误`）本地化，**数据值**（`stale`/`fallback`/`modelsdev`）保留原文。
- **英文面零回归**：以已发布 0.2.9 产物为基线、同一调用形态逐字节对照，除临时目录随机片段外 0 差异。
- 验证：**472 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

---

## `v0.2.11` — v0.2.11 — 首次成功调用路径可达（G15）

_published 09/12/2026 03:04:10_

## model-infra-kit v0.2.11 — 让「第一次成功调用」的官方路径真的走得通（G15，独立评估 ACCEPT）

**这一版修的是一个 P0：照官方文档走，走不到第一次成功调用。**

- **协议包不再"悄悄缺失"**：`@ai-sdk/*` 仍是可选 peer（保持安装体积小），但 `provider add` 成功后若该协议包无法解析，会打印**可复制的安装命令**；`serve` 启动横幅也会对已配置供应商缺包给出 502 预警（**不阻塞启动**）。两份 README（含 npm 访客实际看到的包内 README）都把"另装协议包"写成**显式的第 2 步**。
- **写端点的 token 语义如实说明**：`--token` 帮助改为「不设置时只读端点开放、**写端点 401**」；无 token 启动时横幅明确打印「写端点已禁用」（原仅在 TTY 下打印——而非 TTY 恰是最易踩 401 的场景）。
- **模型路由给出路**：裸模型名的 400 文案补上 `<provider>:<model>` 写法与 `GET /v1/models` 指引。
- **上手引导真的能走完**：`init --yes` 改为**编号 1/2/3**，第 3 步是一条**可复制的 `curl` 首次调用样例**；示例不再硬编码 `deepseek`，改用 `<presetId>` 等占位符；根 `--help` 的 EXAMPLES 新增 `mik serve --token` 与 `GET /v1/models`、`POST /v1/chat/completions` 三条。

**验证**：**484 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。端到端对照（同一工具、同一 mock 服务）：已发布 `0.2.10` 在全新目录**到不了 200（502）**，本版**到达 200 且用量入账**。英文面 5 份基线逐条归因，无未归因差异。

---

## `v0.2.12` — v0.2.12 — 子命令 --help 选项说明中文化（G58）

_published 09/12/2026 03:39:02_

## model-infra-kit v0.2.12 — 子命令 `--help` 的选项说明中文化（G58，独立评估 ACCEPT）

**这是 G14 一次过度宣称的补救。** G14 曾宣称"CLI 双语已收口"，但独立审计发现**各子命令 `--help` 的选项说明仍是大片英文**——恰是理解成本最高的部分。

- **38 个选项说明 + 18 条结尾说明段**全部本地化：`mik init --help`、`mik provider add --help`、`mik serve --help` 等所有命令与动作的 `--help`，现在在中文环境下**说明文字全为中文**。
- **数据保持原文**：flag 名（`--db`、`-y, --yes`）、占位符（`<path>`/`<presetId>`）、默认路径（`~/.config/...`、`~/.model-infra-kit/usage.db`）、取值示例（`env:VAR`/`file:path`/`keychain:service`）一律不译。
- **英文面逐字不变**：以已发布 `0.2.11` 为基线，**19 个 help 面（root + 7 命令 + 11 动作）差异为 0**。
- **字典 229 → 285 键**，zh/en 严格对等；新增测试把**每个 en 字典值逐字钉在源码字面量上**，并断言**无孤儿键**与**zh 值不得等于英文字面量**（防"加了键却把英文粘进 zh"）。

**验证**：**493 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；A1 口径下 zh 的英文散文行数 **137 → 0**，且同一口径下 en 仍有 155 行（**证明指标非退化**）。

---

## `v0.2.13` — v0.2.13 — 看板诚实性 + 6 个未接线译文（G69）

_published 09/12/2026 04:54:43_

## model-infra-kit v0.2.13 — 看板命令的诚实性与 6 个「译文未接线」的键（G69，独立评估 ACCEPT）

**两个问题，一次体验里同时撞上。**

- **看板命令不再假装开箱可用**（G57）：`--help` 里 `dashboard` 那一行现在如实标注「npm 包不含看板：需仓库克隆或自行部署」——与 G15 已写进两份 README 的口径**完全一致**（不另起说法）。
- **6 个「译文就绪但从未显示」的键已处理**（G68）：`dashboard` 的 5 条错误/提示过去**硬编码英文**，而中英译文早已在字典里——中文用户看到的是「`错误：` + 整段英文」。现已接线：
  - `错误： 找不到看板应用（apps/dashboard）。` + 全中文指引（路径、`pnpm --filter @mik/dashboard dev`、`mik dashboard --dir <path>` 等**数据保持原文**）
  - 同批修复 `notAPackage` / `noEntryPoint` / `spawnFailed` / `packaging hint`
  - `wizard.nextStepsTitle` 属**零引用**键，直接删除（接线会给英文 `mik init` 输出新增一行，违反「英文逐字不变」）
- **新增回归门**：`i18n-dead-keys.test.ts` 会在**任何译文键再次变成「从未被引用」时失败**——它同时防「扫了个空集所以通过」与「判据根本不工作」（内置一个合成死键做双向探测）。

**验证**：**510 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**（含本版首次引入的 em dash 英文 fixture 的三平台一致性）；死键数 **6 → 0**（独立复核）。

---

## `v0.2.14` — v0.2.14 — 供应商回传成本（G73）

_published 09/12/2026 05:38:57_

## model-infra-kit v0.2.14 — 成本口径能对上账单了（G73，独立评估 ACCEPT）

**这是产品核心承诺的一次补全。** 在此之前，模块记录的所有金额都是**算出来的**（价目表 × token 数），没有一条来自**供应商自己说收了多少**——因此「成本对账」在结构上无法闭合。

- **端点回了账单额就以它为准**：适配器读到 OpenAI 兼容响应体的 `usage.cost` 时，直接采纳该值，标记 `cost_source: "provider"` 与 `pricing_basis: "exact"`，并把**原始字符串**保留在既有的 `tags_json` 列（**未加列**），便于你事后核对。
- **没回传时行为一字不变**：仍走原有价目表估算路径（`pricing/service.ts` 一行未动），**且不写任何多余键**。
- **畸变值不静默归零**：无法解析的值记为 `rejected: <原因>` 并回落到原路径，**请求不受影响**（不阻塞宿主）。
- **单位一律按美元，绝不猜**：`"0.000123"` 与 `0.000123` 同为 123 微美元。猜 ticks 类单位一旦猜错就是 10⁶ 倍静默错账，因此明确拒绝猜。
- **原子采纳**：多步调用中只要有一步没回报账额，整行回落到价目表估算；失败的调用永不用回传值计费。
- **澄清一处同名不同义**：`"openrouter"` 是**价目表来源**（仍是估算），新增的 `"provider"` 才是**账单真值**——两者已在类型注释与 `docs/interfaces.md` 中写明区别。
- **契约同步**：`ForwardedCall.providerCost` 与公共类型 `ProviderCostReading`（三态：`absent` / `accepted` / `rejected`）已写入契约并从包入口导出，宿主编译期即可命名与窄化。

**验证**：**534 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；并有一条**产物级**独立验证：mock → `provider add` → `mik serve` → HTTP POST → 直查 SQLite，确认落库为 `pricing_source="provider"` / `cost_usd=0.000123` / `pricing_basis="exact"` / 原始值保留。

---

## `v0.2.15` — v0.2.15 — 未定价覆盖率（G74）

_published 09/12/2026 06:12:41_

## model-infra-kit v0.2.15 — 让「成本看起来没问题」不再掩盖盲区（G74，独立评估 ACCEPT）

**你之前无法一眼看出「有多少钱是我没算准的」。** `usage summary` 给出总金额，但如果一批模型根本没有价格，它们会被显式标为未定价（不会静默算成 0）——而这件事实**只存在于数据库里**，默认输出不告诉你。

现在 `usage summary` 末尾会给出这段窗口的**未定价覆盖**：

- **未定价请求占比**与**未定价 token 占比**（token 维度往往更能说明金额影响）；
- **未定价最多的几个模型**（按用量排序）；
- 每个模型附一条**可直接复制的修法**：`mik pricing set <模型id> --input <美元/M> --output <美元/M>`。

**判据**：只有 `cost_source: "missing"` 算未定价。`provider`（端点回传的账单真值）、`override`/`manual`（你自己设的价）、`modelsdev`/`openrouter`（价目表）、`fallback`（低置信度兜底价）都算已定价——所以这段只指向**真正没有价**的模型。

**不制造噪声**：全部已定价时不打印任何内容；零请求时同理。`usage export` 的 CSV 表头与既有列**逐字未变**，既有输出行与顺序也未动（新段追加在末尾）。

**已声明的边界**：`usage_daily_rollups`（按天折叠的历史）**不存价格来源**，因此在已折叠的库上这段会**静默**，且它的分母是明细行数、可能小于 `summary` 的总请求数。这条边界写在代码注释里，也已登记为后续项。

**验证**：**544 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

---

## `v0.2.16` — v0.2.16 — 管道提前关闭不再崩（G76）

_published 09/12/2026 07:57:41_

## model-infra-kit v0.2.16 — 管道被提前关闭时 CLI 不再崩（G76，独立评估 ACCEPT）

**`mik usage logs | head -1` 以前会以退出码 1 结束**，而在 `set -e` 或 `set -o pipefail` 的脚本里，这会让一条完全正常的查询看起来像是出错了。

修法分两层：`main()` 开头在 `process.stdout`/`process.stderr` 上装 `error` 监听器（捕捉异步 EPIPE），`stdoutIo` 的写入口经一道门卫（处理同步抛出与「已断开」短路）。**不涉及 `process.exit()`**，`main()` 仍然只返回退出码。

- **只容忍 EPIPE**：判据是 `code === "EPIPE"` 或 `errno === -32`；其它写错误照旧抛出、照旧非零退出。
- **公共 API 零变化**：两个内部辅助函数**刻意不从 `mik/cli` 导出**，导出列表与 `0.2.15` 逐名一致（已核对）。
- **顺带把门禁补回**：`battery.sh` 改回普通管道 `cli | grep -q`，恢复 G74 曾经移出电池的那处检测。
- **删掉死代码**：首轮对 `hub.ts` 的改动在 CLI 路径上永不执行，注释对库调用方也属过度宣称，已回退。

**验证**：**558 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；六条多行输出命令在 `| head -1` 下退出码均为 0，而未知命令/未知选项/缺选项值仍分别非零（错误没有被一起吞掉）。

---

## `v0.2.17` — v0.2.17 — 输出噪声（G70）

_published 09/12/2026 08:48:16_

## model-infra-kit v0.2.17 — 每件事只说一次；不再刷 sqlite 实验警告（G70，独立评估 ACCEPT）

- **`provider test` 失败时同一句原因不再出现三次**。以前摘要行里嵌了原因、CLI 又把它塞进括号、表格再印一次。现在括号只在原因**确实不在正文里**时才附加，表格改为**本地化短句**并保留变量名原文（`凭据缺失：环境变量 NO_SUCH_VAR_X 未设置。`）。
- **`node:sqlite` 的 `ExperimentalWarning` 不再刷屏**。用**定向**的进程内过滤：只丢弃 `ExperimentalWarning` 且消息匹配 `SQLite` 的那一条，其余警告**原样转发**给被停放的监听器。没有采用启动器 `--disable-warning` 标志，因为 `env -S` 的 shebang 写法只在 Unix 生效、Windows 的 npm `.cmd` shim 不解析 shebang。
- **英文面逐字未变**（这是冻结面）：英文路径故意不消费新的短句键，代价是英文表格仍重复一次库句，已在代码注释与发布说明中写明。

**验证**：**569 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；产物实测：整句出现 1 次、括号重复 0 次、`ExperimentalWarning` 0 次，而「其它警告仍会出现」由真实子进程断言锁定。

---

## `v0.2.18` — v0.2.18 — 工具诚实性（G72）

_published 09/12/2026 09:15:19_

## model-infra-kit v0.2.18 — 让三处工具说真话（G72，独立评估 ACCEPT）

这一版不含面向用户的新功能，而是修掉三处**会误导维护者或掩盖失败**的地方——它们的共同点是「工具看起来正常，但说的不是事实」。

- **一处注释在说谎**：`warning-filter.ts` 声称它的恢复函数「always run it in a finally」，而唯一的生产调用者**根本没有 `finally`**（靠模块级标志每进程装一次、并刻意丢弃返回值）。行为无误，注释已改成与代码事实一致。
- **一处测试测不到漂移**：`providerTestMessage` 的用例用的是**测试内硬编码字面量**，所以**库层改文案时测试照旧全绿、漂移静默不可探测**。现在守卫从 `CredentialStore.resolve()` **取真实句子**，形状正则或本地化任一失配即红。
- **一处失败被误报**：电池把「CLI 以非零退出」与「输出里没有 Requests」**报成同一句话**。管道未动（G76 依赖它捕获 EPIPE），只把 `PIPESTATUS` 拆出来，让两种原因各自具名。
- 另外把 `formatWarning` 的子串分支**双向钉住**：cause 已是正文子串时省掉括号（其文本仍在行上），不是子串时括号照旧。

**验证**：**572 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

---

## `v0.2.19` — v0.2.19 — 折叠库的未定价可见性（G77）

_published 09/12/2026 09:40:16_

## model-infra-kit v0.2.19 — 当未定价数字看不全时，说出来（G77，独立评估 ACCEPT）

上一版的「未定价覆盖」段做了一件事：让你一眼看到「有多少钱是我没算准的」。但它有一个**沉默的盲区**——它数的是明细行，而 `summary` 的请求数**还包含已经按天折叠的历史**，而折叠表**不存价格来源**。于是在折叠过的库上，那一段会**静静消失**，你看到 `Cost 0.0000` 且没有任何未定价提示，**看起来一切正常**。

现在 `usage summary` 会在这种情况下追加一句中性说明：

> 说明：另有 N 条请求已折叠为按天汇总，不含价格来源，无法计入未定价统计。

几个刻意的取舍：

- **即使当前可见的都已定价，这句也会出现**——它讲的是**度量范围**，不是待办事项；否则「金额正常 + 没有未定价段」这个组合依然是零信号。
- **差值为零时一个字都不打印**，因此未折叠过的库输出与上一版**逐字节相同**。
- **没有选「把价格来源也折进汇总表」**，理由是证据而非成本：折叠时明细行会在**同一事务里被删除**，对已存在的库而言信息**早已不可恢复**，而任何朴素的列默认值都会朝某个方向撒谎。后续如果要动，约束已记在仓库里。

**验证**：**575 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；并与已发布 `0.2.18` 做过逐字节对照（未折叠库完全一致、CSV 表头逐字未变）。

---

## `v0.2.20` — v0.2.20 — 包内 README 链接修复（G71）

_published 09/12/2026 10:05:28_

## model-infra-kit v0.2.20 — 让发布出去的 README 链接真的能用（G71，独立评估 ACCEPT）

npm 页面上那份 README 原本带 **5 个相对链接**（`../../README.md`、`../../examples/`、`../../docs/*.md`）。从 `node_modules/model-infra-kit/` 出发，它们全部解析进 `node_modules/` —— **对只看包页面的用户，每一个都是死链**。

现在它们指向仓库的绝对地址；并且 **`docs/cost-reconciliation.md`（成本对账）终于有了入口** —— 此前它在包内 README 与 CLI 帮助里**一处都没被提到**，而当你发现自己的数字和账单对不上时，那正是最需要的一份文档。

**为什么用真实地址而不是占位符**：占位符是一条**必然 404** 的链接，等于把五个坏链换成六个，还与「不做 npm 无法验证的承诺」自相矛盾。仓库的 CI 徽章本就写着真实账号，且它是公开的。值得保留的区分是：**正文里教读者填「他们自己仓库」的示例 URL 仍用占位形式**，而**指向本仓库的链接必须能打开**。

`package.json` 未改动，因此 `docs/` 仍然不进包。

**验证**：**582 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；并从**打包产物**实测包内 README 的 6 个链接**相对链接数为 0**。

---

## `v0.2.21` — v0.2.21 — 调用归属标签（G75）

_published 09/12/2026 11:16:54_

## model-infra-kit v0.2.21 — 按业务维度看成本：给调用打标签（G75，独立评估 ACCEPT）

同一个宿主里往往有多套业务共用一套模型层。此前你只能按 provider/model 聚合，看不到**哪个功能在烧钱**。

- **给调用打标签**：`ModelRequest.tags` 带自己的键值（如 `{ feature: "quant-backtest", sessionId: "bt-7" }`）。
- **按标签看成本**：新增 `usage summary --by-tag` 表格、`--tag <键[=值]>` 过滤，以及 `hub.usage.byTag()`。
- **导出带上标签**：`usage export` 的 CSV **追加**第 15 列 `tags`——前 14 个列名与顺序**逐字未变**（按索引或表头读的脚本不受影响）。
- **升级只做加法**：迁移是「条件补列 + 建表」，**不改写任何既有行**；旧库升级后数据完整、旧行可读、新行可写。

**两处缺陷由独立评审在发布前抓出并修掉**，值得说明：

- **导出会漏明文**：本版新开的 CSV 列原样输出标签，而**在 G75 之前写入的行没有脱敏**——于是一个历史明文 token 会直接进 stdout。现在两个 CLI 出口与 **SSE 边缘**都**在渲染时**脱敏，且**不改写库中已存的字节**。
- **「保留键」过滤形同虚设**：它只匹配 `_mik_` 前缀，而 G73 的两个真实对账键（`provider_cost_raw`、`provider_cost_status`）**没有前缀**，所以它一个都没排除——**每次供应商回传成本的调用都会长出垃圾成本桶**。现在过滤直接取自这两个键的**定义处**，渲染侧与 SQL 侧同时生效。

**验证**：**611 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；存量明文行的脱敏有实测（改前导出含明文、改后为 `[REDACTED]`，且库内原文未被改写）。

---

## `v0.2.22` — v0.2.22 — 共享库可见性（G64）

_published 09/12/2026 12:05:54_

## model-infra-kit v0.2.22 — 说清这些数字是从哪个库读出来的（G64，独立评估 ACCEPT）

默认数据库是 `~/.model-infra-kit/usage.db`，**同机所有项目共用一个文件**，而此前**没有任何地方说明这一点**——你可能把别的项目的用量当成了自己的。

`usage summary` 现在最多追加**两行**。它们**刻意分开写**，因为合并成一句会让「可能性」被读成「证据」：

- **已知共用**：该库确有 ≥2 个 app 时，给出**数量与名字**作证。
- **可能共用**：未传 `--db` 时，说明读的是**默认共享库及其实解析路径**，并指出同机其它项目若也用默认设置会写进同一个文件、以及如何隔离。这是**条件式**陈述，**只给路径，不报数量与名字**。

**显式传了 `--db` 就完全静默**（连路径都不回显）——那时库是你自己选的。路径在整个输出里**恰好出现一次**，有直接断言锁定。

**为什么会有第二行**：第一版只在「库里有 ≥2 个 app_id」时提示，于是**对它本要解决的问题保持沉默**——多个项目都用默认 app id 时，库里只有一个 app id，没有任何信息能把它们区分开。第二行覆盖了这种情况，**且不编造证据**。

**验证**：**629 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；场景有假 home 的端到端用例（两个项目、同一默认 app id、不传 `--db` → 提示含正确路径；显式 `--db` 到同一库 → 静默）与「改前必红」证据。

---

## `v0.2.23` — v0.2.23 — 第三门禁诊断对齐（G72b）

_published 09/12/2026 13:35:14_

## model-infra-kit v0.2.23 — 第三个门禁现在也能说清失败原因（G72b，独立评估 ACCEPT）

`check-envs` 会在三个环境里跑同一套检查。其中 `battery.sh` 早已被教会把「**命令非零退出**」与「**输出里没有期望内容**」报成两句不同的话——但 `battery.ps1` 没有：它**不看退出码、失败时原因空白**，而它恰好是**本机**跑的那个。

现在 PowerShell 端也报出具体原因（`cli exit non-zero (exit code N)`，命令压根没跑时打 `(unset)`），与「缺少某行」分开；`python` 步同样补上了退出码判定。**命令行与检查项一字未改。**

**验证它的测试来回修了三轮**，过程本身值得一提：第一版**每轮泄漏 4 个 node 服务进程**并**静默放弃清理**；清干净之后，唯一的断言是 `remaining === 0`，而它用的**谓词与扫描是同一个**——于是一个漂移到「什么都匹配不到」的选择器会报 `killed=0 remaining=0` 并通过。现在改为对**外部常量**断言 `killed`（匹配不到任何东西必然为 0，因此必红），并断言「恰好只有 summary 一步被报为失败」。

**验证**：**634 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**。

---

## `v0.2.24` — v0.2.24 — 成本确定性表达（G78）

_published 09/12/2026 14:39:48_

## model-infra-kit v0.2.24 — 不再把「算不准的总额」当成精确值（G78/G79/G80，独立评估 ACCEPT）

对**已发布 0.2.23** 的独立再审计发现：**在有 16.7% 请求未定价的情况下，成本区间会闭合成一个点**——`成本区间 0.0175 – 0.0175`——而 CSV 那一行是 `0.0000,missing,flat`，其中 `flat` 把「价格未知」盖住了。

现在只要存在未定价或已折叠的请求，成本就降级为**带标记的下限**：

> `成本区间 至少 0.0175（上界未知：1 笔请求未定价）`

下限取自 `costLowUsd` 而**不是**点估计——因为 `low ≤ usd ≤ high`，点估计**不是已证的下限**。全部已定价时仍打印**精确区间**，且**绝不插值**。

**范围现在会被写明**（`全部时间（未给 --from/--to）` 之类），且 `summary` 与 `trends` **各自指出对方默认窗口**——同一库不再可能因为口径不同而给出两个数字却不说原因。

`pricing_basis` 新增第四档 **`unknown`**，缺价不再冒充 `flat`——**包括那些从未记录过 basis 的存量行**。

`usage export` 的 CSV **仍是恰好 15 列**；新增的 API 字段在 `openapi.ts` 里带上了 `description`，因为**一个没有说明含义的布尔标志，机器客户端一定会忽略**。

**验证**：**645 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键断言有**产物级改前必红**（同一批 19 条断言里 13 条在 0.2.23 上为红）。

---

## `v0.2.25` — v0.2.25 — 会被读错的两处呈现（G82）

_published 09/12/2026 15:23:37_

## model-infra-kit v0.2.25 — 两处会被读错的呈现（G82，独立评估 ACCEPT）

### 标签值不再能伪造输出行

标签值是宿主给的任意文本，**可以含换行**。原样打印时，它能**伪造出一行 CLI 输出**——读者会看到一句工具从没写过的话，而同一屏上还写着「展示值均经脱敏」；CSV 里也会把一条记录拆成多个物理行。

现在标签值只在**两个渲染出口**经过一个函数：换行/回车/制表符变成**两字符转义**，其余控制与格式字符变成 `?`，**不删除任何字符**。**写入路径一字未改**——库里的原文与对账桶保持原样。

### 缺失的测量不再显示为 0

首 token 延迟缺失时渲染成 `0 ms`，与「模型真的瞬间答完」**无法区分**；而延迟缺失早已渲染为 `-`。现在**缺失是「没有」，不是 0**，并与 `usage logs` 每行复用**同一个** `formatDuration`。

### 宿主可见的行为变更（请留意）

`GET /api/usage/summary` 在**没有测量**时**不再返回** `avgLatencyMs` / `firstTokenMs` 两个键（此前返回 `0`）。**直接对它们做格式化或算术的宿主会抛错**，迁移方式是 `?? 0`。

**验证**：**652 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有**改前必红**（同一批断言在 0.2.24 上为红）。

---

## `v0.2.26` — v0.2.26 — init 的指引与落盘（G84）

_published 09/12/2026 15:53:48_

## model-infra-kit v0.2.26 — `init` 不再推荐一个装了包就跑不通的命令（G84，独立评估 ACCEPT）

`init` 的最后一步会告诉你去运行 `mik dashboard`。但在**从 npm 装来的包里，这条命令必然退出 1**——看板在 `apps/dashboard`，而 tarball 只带 `dist` 与 `LICENSE`。于是向导**最后说出口的那句话，恰好是唯一做不到的那件**。

现在那一步指向 **`mik usage summary`**，它在装包环境里**真能跑通**（已在模拟装包布局中实测 exit 0）。看板入口没有被删掉——`--help` 与打包说明里的那条提示都保留；i18n 键是**改名而非新增**，所以没有任何译文变成死键。

### `--cache-dir` 不再被静默丢弃

`init` 以前**接受** `--cache-dir` 却**什么都不写**——参数被解析后悄悄丢掉，让你以为缓存放在某个实际并非如此的地方。现在它会**落盘为 `cacheDir` 并真正被读取**，走的是这条参数本来就有的解析链（**flag → `MIK_CACHE_DIR` → 配置文件**），并且**送进 `ModelInfra.init` 的就是那个解析结果**。

顺带说明：包内 README **早就把 `cacheDir` 列为配置字段**——也就是说**契约一直写着它，只是 `init` 从不写**。这一版让实际行为与已文档化的契约终于一致。

**验证**：**656 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；新测试**改前 4/4 红**。

---

## `v0.2.27` — v0.2.27 — 导出的对账与防伪行（G81）

_published 09/12/2026 17:06:49_

## model-infra-kit v0.2.27 — 让导出真的能对账，并让单元格无法伪造一行（G81，独立评估 ACCEPT）

`usage export` 是你用来跟账单核对的产物，而它**加不起来**：每行只保留 4 位小数，于是 5 行相加是 `0.0006`，而 `summary` 说 `0.0007`。

金额底层仍是**整数微美元**；现在逐行**由那些整数渲染**（6 位小数）并新增整数列 `cost_microusd`，所以**和是精确的**，被丢掉的微美元是**修好**而不是藏起来。

这份文件此前也**追不回去**：现在追加 7 列（`request_id`、`session_id`、`first_token_ms`、`is_streaming`、`error_code`、`pricing_model`、`cost_microusd`），而**前 15 列的列名与顺序逐字未变**——由一条**手写的字面量**钉住，而不是用那个列表自己的切片来自证。

**独立评审随后发现：伪造行的洞从来不在标签列，而在任何一个自由文本列。** `model`、`session_id`、`error_code` 里的一个换行会把**一条记录变成 6 个物理行**。现在每个文本单元格都过同一道 sanitize，并用**整行不变量**断言「每个事件恰好一行」（含 CRLF、引号、逗号与内嵌分隔符）。

**已知并登记**：`summary` 仍打印 4 位小数而 CSV 带 6 位，两者**只在按显示精度取整后**相等；另外 `usage logs` 的 CLI 表尚未显示 `request_id`，只用终端的用户还无法把一行与一条 log 对上——**后者更小、也更容易误导，已定为优先修复**。

**验证**：**670 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有改前必红（`expected '0.0006' to be '0.0007'`、`length of 2 but got 6`）。

---

## `v0.2.28` — v0.2.28 — CLI 面的可追溯（G86）

_published 09/12/2026 17:27:02_

## model-infra-kit v0.2.28 — 只靠终端就能把导出的一行对到一条 log（G86，独立评估 ACCEPT）

G81 给 `usage export` 补了 `request_id`，**文件**因此可追溯了，但**工具**还没有：`usage logs` 的表不打印 id，而那条 id 只能从 `/api/usage/logs/:id` 拿到——**那需要先起服务**。毫秒级组合键也替代不了：**同一毫秒内的两次调用会塌成同一个键**。

现在 `usage logs --with-id` 会在既有十列**之后**追加 `REQUEST ID`（zh：`请求 ID`）。

它做成**开关**而不是新默认，有两个理由：默认输出必须**逐字保持**原样；而且 `usage summary --by-tag` 在本仓库已经确立了同样的形态（opt-in + 末尾追加 + 契约写明「不加 flag 时逐字一致」）。

测试是**按人会怎么用**来写的：从导出的某一行取 id → 用 CLI 要回那条记录 → **比对两侧的 id**；另加一组**共用同一时间戳**的两行——**十列展示信息分不出它们，id 能**。

**验证**：**676 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有改前必红（改前 `usage logs` 无 id、`--with-id` 报 `Unknown option` 退出 2；测试 5 失败 → 6 通过）。

---

## `v0.2.29` — v0.2.29 — 微美元可见（G85）

_published 09/12/2026 17:52:32_

## model-infra-kit v0.2.29 — 把导出早就能看见的微美元也显示出来（G85，独立评估 ACCEPT）

G81 让 `usage export` 的**每一行**都由整数微美元按 6 位小数渲染，但 `summary`、`logs`、`trends` 仍打 4 位。把导出的各行相加得到 `0.000654`，而 `summary` 说 `0.0007`——两者**只有在读者自己套一条取整规则时才一致**。这正是审计当初那条抱怨的下一层。

现在**用量面**金额：**存在低于 0.0001 的微美元**时印 6 位，否则印 4 位。所以干净的 `0.0030` 仍读作 `0.0030`，而两个数字**不需要任何人取整**就能对上。**目录价格**用的仍是原来那个函数——把它一起放宽会让各处价格都变，并让帮助里「4 位小数」的说法变成假话。

### 除了多两位，读者还会注意到两件事

- **低于半个微美元的金额不再印成 `0.0000`**：三十微美元以前读作 `0.0000`，现在读作 `0.000030`。这是**从零变成非零**，不是精度变化。
- **列变宽了**，这几张表的**对齐会移动**。凡是把这两列**当文本解析**的脚本，应改为按数值解析。

另外 `trends` 的合计以前用浮点相加，现在改为**整数微美元累加**，与存储层本来的求和方式一致。

**验证**：**680 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有改前必红（`expected '0.0007' to be '0.000654'`）。

---

## `v0.2.30` — v0.2.30 — 三处静默现形（G88）

_published 09/12/2026 18:48:03_

## model-infra-kit v0.2.30 — 让三处「静默」现形（G88，独立复评 ACCEPT）

**重跑 `init` 不再丢掉你设过的缓存目录。** 以前不带 `--cache-dir` 重跑 `init` 会把配置文件重写一遍、**把里面已有的 `cacheDir` 抹掉**——缓存静默落回默认目录，而文件看起来就是一次正常的 init。现在 `init` **保留文件里已有的值**（顺序是：命令行 flag → `MIK_CACHE_DIR` → 文件里存的值），并把最终采用的缓存路径**打印出来**。

**`trends --to <日期>` 不再偷偷假设一个下沿。** 只给 `--to` 而不给 `--from` 时，它以前会**静默**把下沿设到 30 天前；现在这个下沿会**明确写出**，用的是与其它范围说明**同一句式**。另外 `--days` 终于有了测试：`1`、极大值、小数、`0`、负数以及非数字输入。

**看板的成本区间不再自成一个口径。** 它仍用裸的 `toFixed(4)`，于是同一笔 340 µ$ 在那里读 `$0.0003`、在命令行读 `0.000340`；任何低于半个微美元的金额则读 `$0.0000`。现在它走**共享的格式化函数**，与 CLI 是**同一条规则**（半微钳位 + 无余数 4 位 / 有余数 6 位）。一处可见差异：看板会**裁掉尾零**，所以 3000 µ$ 在看板显示 `$0.003`，而 CLI 显示 `0.0030`。

**本片源自一次评审否决。** 第一版**没有动**上面那格成本区间，而报告用一句「该文件没有 `toFixed(4)`」解释了这处遗漏——**那句话不成立**，且恰好指向了离本卡要修的地方最远的方向。

**验证**：**686 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、看板测试 12/12、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有改前必红。

---

## `v0.3.0` — v0.3.0 — 弃用成本点估计（G89）

_published 09/12/2026 19:28:06_

## model-infra-kit v0.3.0 — 弃用成本点估计（G89）

`costUsd` 是**点估计**。当存在未定价或被折叠的请求时，它**不是任何一侧的界**——`low ≤ usd ≤ high` 成立，所以它**不能**当下限用，这也是下限自 G78 起一直用 `costLowUsd` 的原因。

它现在被标记为**弃用**，并写清了迁移路径；**字段仍在填充**，所以读取它的代码**不会坏**。**删除它属于 major 变更**——本版只是不再推荐它。

**产品自己也不再使用它。** CLI 的两条成本行与看板的两处金额改由**两端**驱动：上界未知时印既有的「至少」下限，**区间是一个点**时印单值，**区间有价差**时印范围。

最后那一支**更正了本片卡片自己的一处错误主张**：卡片称「完全定价 ⟹ 三者相等」，**并不成立**。llm-pricing 的档位估算**即使没有任何未定价请求也记录一个价差**——仓库 fixture 里 `source` 是 `modelsdev`、没有 missing 行，却是 `low 0.01 < usd 0.012345 < high 0.02`。**只取低端会把 `0.0100` 当作成本印出来**，而那正是这个产品连续几个版本在消除的「把不确定读成精确」。评审随后又抓到**同一句假话被写进了新的类型注释**——也就是**开发者真正会读到的那处**；现在注释说的是「**价格来源不记录价差时**三者相等」，并注明「完全定价的区间仍可能带价差」。

**迁移**：要下限用 `costLowUsd`；要区间用 `costLowUsd` 与 `costHighUsd` 两端；**价格来源不记录价差**时三者相等。

**验证**：**694 测试在 zh-CN 与 en-US 两种 locale 下均全绿**、看板测试 15/15、e2e exit 0、三环境电池 PASS、**CI 三 OS 全绿**；关键行为有改前必红。

---

## `v0.3.1` — v0.3.1 — 看板金额单元格的断言终于会红了（G90）

_published 09/12/2026 20:31:10_

## model-infra-kit v0.3.1 — 看板金额单元格的断言终于会红了（G90）

`DASH` 检查原先断言的是 `home.includes(expected.cost)`：**整页子串匹配**。而这次 run 写下的每一行都是**点定价**（`low === high === usd`），于是 `expected.cost` 永远是一个单值——点定价下，「渲染记录的区间」与「渲染已被弃用的 `costUsd` 点估计」**印出同一个字符串**。也就是说：即使看板回去读 G89 刚劝宿主别读的那个字段，这条检查照绿。这正是登记在案的那条盲区（看板的区间用例不会因生产回归变红）。

本版补上两件缺一不可的东西。单元格带上 `data-testid="overview-cost-span"`（`StatCard` 新增可选 `testId`，其余视图一个都没传），断言这才**指名道姓**；DASH 步骤改经公开计量 API 写入**一条真有价差的行**（`low 0.01 < usd 0.012345 < high 0.02`，仓库既有 fixture 形状），「印区间」与「印点估计」才不再是同一个字符串。另加一条守卫断言 fixture 自身含 `~`——点定价下整个断言会**恒真**，而恒真正是这片要关掉的失效模式。上游不可达的那一趟也读同一个锚点，并要求读到看板的 `—`，证明这个锚点跟的是活数据。

**改前必红**：把单元格临时改回 `formatUsd(costUsd)`，DASH 报

```
the overview money cell prints "$0.036645", expected the recorded band "$0.0343 ~ $0.0443"
```

退出码 1（62.8 s）。恢复后 12/12 全过，单元格读 `$0.0343 ~ $0.0443`（10 行）。

**本版没有运行时变化**：看板不在 tarball 内，`packages/mik/src` 一行未动——发布物只多了版本号与这次验证加上的 test hook。之所以仍发一个 patch，是因为本仓库以版本号作为每个切片的记账单位。

**验证**：694 测试在 zh-CN 与 en-US 两种 locale 下均全绿、看板测试 15/15、两边 `tsc --noEmit` 0 错误、e2e 12/12 退出码 0、三环境电池 PASS、**CI 三 OS 全绿**（[run 34717302263](https://github.com/satan9394/model-infra-kit/actions/runs/34717302263)：ubuntu / macos / windows 三个 job 均 success）。

**已发布产物验证（G36）**：全新目录 `npm i model-infra-kit@0.3.1`（解析路径自证在该目录内）→ ① `mik 0.3.1`；② 30 个导出含 `ModelInfra`；③ `dist/server.mjs` 与 `dist/server.d.mts` 随包发布；④ 功能冒烟用仓库自带的宿主示例（mock 供应商 → init → test → discover → default → generate → stream → tool call → usage summary）14 项断言全过：文本为 mock 应答、`requests 3`、`generate=2 stream=1`、token 4800/1200/3200（工具调用两 step 合成一行）。

---


