# AGENTS.md — model-infra-kit

> 本文件是项目级规则。任何 Worker（子代理/子会话）动手前必须读本文件 + `docs/SPEC.md` + 自己的任务卡。

## 项目定位

`model-infra-kit` 是一个**可嵌入任意 AI 项目的模型层**：装进宿主项目后，立刻获得多供应商调用、模型目录、token 用量、模型计价与成本统计，外加一个独立看板。

它不是网关平台、不是企业级 AI Gateway、也不读任何第三方应用的数据文件。

## 技术栈（不要换）

- Node ≥ 22（本机 24.14），ESM，TypeScript strict
- 包管理 pnpm 11（workspace）
- 构建 tsdown，测试 vitest，类型检查 `tsc --noEmit`
- 核心依赖：`ai`（Vercel AI SDK v7）、`llm-pricing`（MIT）、`node:sqlite`
- 看板：Next.js App Router + Tailwind + Recharts

## 目录结构

```
model-infra-kit/
├─ packages/mik/          主包（唯一要发布的包）
│   ├─ src/registry/      供应商注册表 + 预设
│   ├─ src/credential/    凭据引用解析
│   ├─ src/ai/            AI SDK 桥接（协议/模型解析/连接测试/模型发现）
│   ├─ src/pricing/       llm-pricing 封装
│   ├─ src/usage/         计量与查询
│   ├─ src/store/         SQLite 仓储与迁移
│   ├─ src/fetch.ts       mik.fetch / mik.baseUrl
│   ├─ src/server/        子路径导出 mik/server
│   └─ src/cli/           子路径导出 mik/cli
├─ apps/dashboard/        Next.js 看板
├─ examples/              接入示例
├─ docs/                  决策与契约（SPEC.md / interfaces.md / decisions.md）
└─ tasks/                 任务卡（看板）
```

## 端口约定

- 看板 **3210**，HTTP 服务 **3211**（均可在配置覆盖）
- 已被本机其它项目占用、禁止使用：3080 / 3001 / 3111 / 8899
- 起服务前先 `netstat -ano | findstr :<端口>` 确认

## 命令

```bash
pnpm --filter model-infra-kit typecheck   # 必须 0 错误
pnpm --filter model-infra-kit test        # 必须全绿
pnpm --filter model-infra-kit build       # tsdown 打包
```

## 硬性规则（违反即打回）

1. **不读第三方应用的数据**。不扫描 `~/.codex`、`~/.local/share/opencode`、`~/.claude` 等目录。用量数据由本模块自己产生。
2. **金额一律整数微美元累加**。禁止 `SUM(CAST(cost AS REAL))` 这类浮点求和；SQL 聚合用 `CAST(ROUND(x*1000000) AS INTEGER)`。
3. **协议是一等公民**。适配器按 `protocol` 数据映射选，禁止 `if (providerId === "deepseek")` 这类分支；供应商差异只能进 `provider.meta`。
4. **密钥永不落库、永不进日志**。provider 只存 `api_key_ref`；日志/响应统一走 `src/util/redact.ts`。
5. **不改公共接口而不改契约**。`docs/interfaces.md` 是跨 Worker 的接口契约；需要变更先在卡里说明并更新该文件。
6. **不阻塞启动**。目录/价格上游拉取失败只降级 + 告警，不能让 `ModelInfra.init()` 抛错。
7. **`_research/` 只读**。那是参考仓库克隆，不修改、不依赖、不打包。
8. **删除必须进回收站**，禁止 `rm -rf` / `Remove-Item -Force` 彻底删除。
9. **每个 Worker 必须自证**：改完跑 `tsc --noEmit` + **自己那张卡的测试文件**，并把命令与真实输出贴进交证报告。没有证据视为未完成。
10. **并行 Worker 只跑自己的测试**：`pnpm exec vitest run test/<你的卡>.test.ts`。全量套件由指挥在卡收齐后统一跑，避免互相看到对方半成品。
11. **禁止 `Remove-Item`**：本机钩子会拦截（报「删除必须进回收站」）。清环境变量用 `$env:X=""`；删文件走回收站 API。

## 交证格式（Worker → 指挥）

```
【卡号】T0X
【改动】文件清单 + 一句话说明
【证据】typecheck 输出摘要 / test 输出摘要 / 关键 SQL 或行为验证
【偏差】与契约或卡片的差异，没有就写“无”
【风险】需要指挥决策的点，没有就写“无”
```

## 复盘（教训，别重犯）

- **契约缺陷会以强转的形式暴露**：T02 测试里出现 `as unknown as ProviderConfig`，根因是我在 T01 把 `ProviderConfig.protocol` 定成了必填，而 preset 本来就会补。已改成可选 + 存储层兜底。**看到 `as unknown as` 就去查契约，别在调用点打补丁。**
- **并行 Worker 不要跑全量测试**：T02 写一半时指挥跑 typecheck 被它的半成品测试报错污染，误判 T04。规则已进第 10 条。
- **重派子代理要补前提**：首次派 T02/T03 两个 Worker 均无产出即失败（通道本身正常，探针验证过）。补上「`@ai-sdk/*` provider 已随 peer 自动安装」后一次通过——**派活时把本机事实写进简报，能显著降低失败率**。
- **先探针再派活**：派 T05 前用 `.tmp/spike-ai.mjs` 实测出「`cacheWriteTokens` 可能 undefined」这类关键事实，避免了 T05 猜错映射。
- **并发上限 = 2**：一次派 5 个实现 Worker（F01–F04 + T07）**全部立即失败、零产出**；同一批卡单发或 2 并发则正常。派活规则：**最多 2 个实现 Worker 同时在线**，超出就排队。
- **阻断级先修**：评审出的 B1/B2 要单独发卡、单独验证，不要和一堆建议级混在一张卡里（会被稀释）。
- **测试全绿 ≠ 正确**：G05 的脱敏规则在 24 例全绿时仍会漏 `Authorization: Basic <base64>`、又误杀散文里的 `the Bearer token is required`——**边界反例要主动构造**，别把「测试过了」当结论。
- **平台/locale 敏感改动必须以 CI 为准**（铁律 G26）：本机只在 Windows 跑 vitest，三环境电池只跑 CLI 冒烟、**不含单测**；G03–G07 连续 5 次 push 的 CI 全红而无人察觉。涉及平台分支、locale、时区、路径分隔符、信号、权限的改动，**本地绿不算数**，push 后必须 `gh run watch --exit-status`。测试若依赖运行环境必须**注入**（G29 的 locale 用例全部注入 `LC_ALL`/`MIK_LANG`）。
- **禁止在实现者运行期间 `git add -A`**（铁律 G27）：R41 把实现者「临时删一个 i18n 键以自证对等测试会红」的**中间态**折进提交，CI 出现 32 vs 31 的假失败，浪费一轮并污染历史。只 `git add <自己改的文件>`；**新增的未跟踪文件（如新组件、新测试）必须显式点名**，否则整个改动等于没提（R51 的 `upstream-notice.tsx` 教训）。
- **卡片里的断言不能恒真**：G09 卡片原写「`grep -c "shell: true"` 为 0」作为「去掉 shell」的验收，但源码本是 `shell: !useLocalNext && process.platform === "win32"`——**改动前就 0 命中**，属恒真断言。写卡时先跑一遍断言确认它**现在会红**。
- **断言要锚在真实不变式上**：G09 的 e2e「顺序断言」有半边恒真（错误横幅被 `retried && !pending` 包住，SSR 首屏永不出现，位置比较永远成立）。改用 `data-testid` + 断言「首屏**不存在** error 横幅」才是可证条件。
- **发版后必须验已发布产物**（铁律 G36）：仓库内 e2e 的 DIST 检查点只验**仓库 dist**；`files` 白名单、子路径导出、peer 依赖解析只在真正装包后暴露。流程：全新目录 `npm i model-infra-kit@<版本>` → ① CLI `--version` 一致 ② 库面导出含 `ModelInfra` ③ `dist/server.mjs` 在包内 ④ **真实功能冒烟**（mock 供应商 → `init` → `generate` → 断言文本与 `usage`）。注意 npm 有**传播延迟**（实测约 2 分钟），需轮询 `npm view <pkg>@<ver> version` 再装。
- **工具自身的退出码也要自检**：`check-envs.mjs` 的 `--json` 分支曾**从不 `process.exit`**（失败时退出码 0，接 CI 会**假绿**）。凡是被 CI/脚本消费的模式，必须有「失败即非零退出」的自检用例。
- **公库与体验不一致就是缺口**：CLI 已宣称 zh/en 双语（G02/G08），但 `mik --help` 横幅与未知命令报错仍是英文——这类「承诺 vs 实际」要靠**从已发布产物实测**发现，不能只看单测。看到一处就顺手 grep 同类面（`args.ts`/`dispatch.ts`/`context.ts`/各命令输出）。
- **契约文档会说谎，必须用产物核对**（G11 的 REJECT，最有价值的一次评审）：`docs/interfaces.md` 把新加的 `PROTOCOLS`/`ProtocolSpec` 写进「已由 `src/index.ts` 导出」的稳定块，**实际构建产物里根本没有这两个名字**（30 个导出中 `SDK_PROTOCOLS`/`MODEL_LIST_PROTOCOLS` 才是公开的）——宿主照文档 import 会失败。教训：改契约时**用 `dist/index.mjs` 的实际导出名核对**，别用「文中提到了」当证据；`grep PROTOCOLS` 会命中 `SDK_PROTOCOLS` 造成**子串假阳性**（我本人就因此误判过一次）。
- **派新 Worker 前必须先查在跑的 Worker**（G12 的编排事故，代价最大的一次）：G12 上编排者凭「三轮无产出」判定实现者已死，连派三个实现者，而**第一个从未死亡、只是慢**——三者同写同一批文件，其中一者观察到秒级竞争、其 `edit` 被 "file changed since it was read" 拒绝。**`list_agents` 才是在跑状态的权威**；「无产出」≠「已死」。同一张卡同时只允许一个写入者。
- **验证工具自身也会依赖运行环境**（G12）：CLI 改为跟随 OS locale 后，**测试与 e2e 工具**里凡是断言英文字符串的地方都会在 zh-CN 机器上翻红、在英文 CI 上反而绿。修法有两类，按角色区分：(a) **测试**用 `run()` 助手默认注入 `MIK_LANG=en`（可被单例覆盖）；(b) **e2e/脚本工具**在 `cleanEnv()` 里钉 `MIK_LANG=en`——工具不是用户，不该跟随机器 locale。加任何「框架文案/错误文案」断言前，先问一句「它在别的 locale 下会怎样」。
- **改文案类功能要先把「改前基线」固化成文件**（G12 的验收基础设施）：从**已发布产物**跑出 `--help`、未知命令、缺参数、未知选项的输出存到 `.tmp/baseline-*.txt`，改完逐字 `Compare-Object`。这比「凭记忆说没变」可靠，且能**同时锁住退出码**。注意：基线对照手段本身要自证非恒真（加一行应报差异）。
- **grep 模式宽度决定结论可信度**：同一轮里，我用过窄的 `0\.2\.\d` 得出「README 无硬编码版本、G16 已解决」，漏掉了更陈旧的 `0.1.7`（落后 5 个 patch）。窄模式 + 「0 命中」的组合最容易产出**错误的安心**。
- **评审快照请用 commit sha 固定**（G42）：G11 评审期间工作区被并发提交，Evaluator 不得不自行做快照漂移核对。派单时给 sha，评审时先 `git rev-parse HEAD` 对照。
- **恒真断言会反复出现**（G43）：G11 卡 A1 的 grep 断言在**改前改后皆为真**（旧表声明形态与预期不同），与 G09 的 `shell: true` 同类。**写卡时先把断言跑一遍，确认它现在会红**；不会红的断言等于没写。

## 当前状态（R70）

- **版本 v0.2.7**，npm 与 GitHub Release 均已发布；`main` 分支 CI（ubuntu/macos/windows 三 OS）全绿。
- **测试基线 447 例**（`pnpm --filter model-infra-kit test`，20 个文件），`tsc --noEmit` 0 错误，`node scripts/e2e/run.mjs` exit 0，`node scripts/check-envs.mjs` 三环境 PASS。
- **已验收发布的切片**：G01–G11（`0.1.7` → `0.2.7`）。产品演进全貌、GAP_MAP、技术债 G15–G44、每轮验收留痕，见 **`docs/product-evolution.md`**（编排者维护的唯一权威状态文件，比本节的摘要更新更快）。
- **进行中**：G12（CLI 入门面本地化：`--help` 横幅 / 用法 / 未知命令报错），卡见 `tasks/EVO-G12-cli-help-i18n.md`。
- **已排定下一个**：G37 其余部分——各子命令的输出文案（`usage` / `models` / `pricing` / `serve` / `provider` / `dashboard`）仍为英文。
- **结构守卫**：`packages/mik/test/module-graph.test.ts` 递归扫描 `src/**` 断言无环 + 相对说明符必须可解析。**已知边界（G41）**：`import("./" + n)`、`import(path.join(a, b))` 这类动态表达式对它不可见；`import{a}from"…"` 也漏检。新增此类写法时请手工确认。
- 每轮收尾铁律：机械门禁 → 独立 Evaluator 验收 → 提交（只 add 自己的文件）+ 升版 patch → `npm publish` → `gh release create` → **CI 三 OS 绿** → **G36 发布产物验证** → 更新 `docs/product-evolution.md`。

