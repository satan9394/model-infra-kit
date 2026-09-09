# R02 — 最终对抗日志评审（全量）

- 评审对象：`model-infra-kit` 当前工作树（T01–T10 + F01–F08 全部落地后）
- 评审方式：只读代码 + 只读命令 + 独立探针（临时目录 / `npm pack` 消费者工程）；**未修改任何源码、测试、文档**
- 立场：证明「还不能交付」。以下每条都给 `文件:行号` + 复现方式

## 复跑与探针证据（本机实测）

| 命令 / 探针 | 结果 |
|---|---|
| `pnpm --filter model-infra-kit test` | **248 passed / 10 files，exit 0**（3.85 s） |
| `node scripts/e2e/run.mjs` | **10/10 PASS，exit 0**（7.2 s） |
| `pnpm --filter model-infra-kit build` | 9 files / **302.54 kB**，exit 0 |
| `npm pack` + 临时消费者工程 import | 11 files；`model-infra-kit` / `/server` / `/cli` 三入口可导入，`createServer` + `/api/health` 200，Node **24.14 与 22.19 均通过** |
| 探针：注入「永不 settle」的 `pricingFetch` | `ModelInfra.init()` **20 s 后仍未 resolve**（继续等下去也不会） |
| 探针：注入 5 s 后才 reject 的 `pricingFetch` | `init()` 耗时 **5015 ms** |
| 探针：`close()` 后再调用公开成员 | 全部抛裸 `Error code=ERR_INVALID_STATE "database is not open"`（**不是** `ModelInfraError`） |
| 探针：删除仍是默认模型的 provider | `defaultModel()` 仍返回 `ghostprov:x`，此后每个省略 model 的请求 `PROVIDER_NOT_FOUND` |
| 探针：`enabled:false` 的 provider | `resolve()` 成功、`generate()` 真的发起了调用（`enabled` 只影响目录同步） |
| 探针：只读数据库文件 | `init()` 成功；首次写抛裸 `Error code=ERR_SQLITE_ERROR "attempt to write a readonly database"` |
| 探针：8 进程同时冷启动同一新库 + 各写 40 行 | 8/8 成功，320 行无丢失（多 app 共库并发可用） |
| 探针：`toModelInfraError(new Error("... sk-abcdefgh12345678 ..."))` | `code=UNKNOWN`，**message 原样带出密钥** |
| 探针：`mik dashboard` 在 npm 安装布局下 | `error: Could not find the dashboard app (apps/dashboard).` exit 1 |
| 探针：`mik serve` stdout | 3 行（`Listening on` / `OpenAI-compatible base URL` / `Press Ctrl+C to stop.`） |
| 探针：看板 `pnpm --filter @mik/dashboard start` | HTTP 200，上游不可用时降级提示正常 |

---

## 阻断级

### B1. `ModelInfra.init()` 无界阻塞在价格目录加载上 —— 违背 `AGENTS.md` 规则 6「不阻塞启动」

- 证据：
  - `packages/mik/src/hub.ts:292` —— `await pricing.init()` 位于 `init()` 的关键路径上。
  - `packages/mik/src/pricing/service.ts:104-111, 199-212` —— `init()` → `load(false)` → `await this.catalog.ensureLoaded()`，**没有超时、没有 AbortSignal**；`PricingCatalog` 拿到的就是宿主/我们传进去的 `fetch`（`service.ts:94-100`）。
  - 实测：注入 5 s 才 reject 的 transport → `init()` 花 5015 ms；注入永不 settle 的 transport → **20 s 仍未 resolve**（进程只能被杀）。
  - 生产形态更糟：Node 内置 `fetch`（undici）默认 `headersTimeout`/`bodyTimeout` 是 300 s 量级，被防火墙/代理黑洞掉的 TCP 连接会让宿主「启动」这一步静默挂几分钟。
  - e2e 永远测不到：`scripts/e2e/run.mjs` 里每个 `ModelInfra.init()` 要么带 `--offline`（`run.mjs:236-256`），要么注入 `pricingFetch: unreachableFetch`（立刻 reject，`run.mjs:193-195`），最慢的一次也就毫秒级。
- 为什么是问题：规则 6 的标题就是「不阻塞启动」。现在的行为不是「降级 + 告警」，而是**宿主进程起不来**——比抛错更难排查。`docs/decisions.md` D8 只写了「不因……抛错」，掩盖了这一点。
- 建议怎么改：给目录加载加**有界等待**。仓库里已经有现成工具 `settleWithin()`（`hub.ts:868-877`，`close()` 用的就是它），或给 `PricingCatalog` 的 fetch 传 `AbortSignal.timeout(ms)`。同时补一条测试：注入永不 settle 的 transport，断言 `init()` 在 N 秒内返回且 `pricing.state().status` 为 `stale`；并把「启动等待上限」写进 `packages/mik/README.md` 的配置表。

### B2. `ModelInfraError.message` 不做脱敏，而文档明确承诺「已脱敏，可直接展示给用户」—— 密钥会进宿主的日志

- 证据：
  - `packages/mik/src/errors.ts:138` —— 兜底分支 `new ModelInfraError(raw || "Unknown provider failure.")`，`raw` 是上游原始错误文本，**全程没有 `redact()`**；`errors.ts` 整个文件没有 import `redact`。
  - `packages/mik/src/hub.ts:408, 477, 536, 544, 648, 732` —— `generate()` 抛出 / `stream()` 以 `error` 事件 yield 的都是这个未脱敏的 message。
  - `packages/mik/README.md:259` —— 「`message` 已脱敏，可直接展示给用户」；`packages/mik/README.md:90` 的官方示例就是 `console.error(event.error.message)`。
  - 实测：`toModelInfraError(new Error("upstream echoed sk-abcdefgh12345678 while rejecting the call"))` → `code=UNKNOWN`，`message` 原样含 `sk-abcdefgh12345678`（`redact()` 本可把它变成 `sk-****`）。
  - 现有测试只覆盖了 AUTH 分支（`test/hub.test.ts:542` 断言 `message` 不含 key），而 AUTH 分支的文案是**固定字符串**（`errors.ts:76`）——所以这条断言永远不会失败，UNKNOWN 分支零覆盖。
- 为什么是问题：违反规则 4 的意图（密钥不进日志），且把一条**错误的安全承诺**写进对外文档。HTTP 面（`server/http.ts:73` `sendError`）和 CLI（`cli/index.ts:33,37,104`）都做了 `redact`，唯独库调用面没有——而宿主最常做的就是 `catch (e) { logger.error(e.message) }`。
- 建议怎么改：`toModelInfraError()` 的兜底分支不要直接采用上游原文——要么只保留分类文案、把原文放进 `cause`，要么在构造处统一 `redact(raw)`；并补一条测试：UNKNOWN 分类下 `message` 不含 `sk-`/`Bearer`/`authorization=` 形态的密钥。顺带修 `packages/mik/README.md:259` 的措辞（当前是错的）。

### B3. README 对外承诺 `npx mik dashboard`，但发布的包里没有看板，命令必然失败

- 证据：
  - `packages/mik/package.json:20-22` —— `"files": ["dist"]`；`npm pack` 产物共 11 个文件，**没有 `apps/dashboard`**（实测 `tar -tzf`）。
  - `packages/mik/src/cli/commands/dashboard.ts:24-46` —— 靠 `walkUpFor(cwd, "apps/dashboard")` 与从 CLI 模块目录向上找，找不到就抛 `CliRuntimeError`。
  - 实测（把 tarball 装进临时工程）：`node node_modules/model-infra-kit/dist/cli.mjs dashboard --port 3219` → `error: Could not find the dashboard app (apps/dashboard).`，exit 1。
  - README 两处明确承诺：`README.md:188`「或 npx mik dashboard」、`README.md:204` 端口表「`mik dashboard --port <n>`」；`README.md:186` 写「自动找到 apps/dashboard」。
- 为什么是问题：这是「对外承诺 vs 代码实际行为」的硬冲突，且看板是 SPEC §6 验收场景 ③ 的载体——一个装包的人永远看不到它。
- 建议怎么改：二选一，并在 README 里写清：(a) 把看板作为独立包发布（或把预构建产物放进 `files`，`mik dashboard` 直接起它）；(b) 承认看板是 monorepo-only，把 README 里的 `npx mik dashboard` 删掉，改为「需 `--dir <path>` 指向本仓库的 `apps/dashboard`」，并在 `docs/SPEC.md` §6 ③ 注明该场景需仓库内执行。

### B4. SPEC §6 ③（看板看到记录、成本拆解与价格来源）在 e2e 里**零覆盖**，README 却声称 e2e 覆盖「SPEC §6 全场景」

- 证据：
  - `README.md:232` —— `node scripts/e2e/run.mjs` = 「端到端验收（SPEC §6 全场景）」。
  - `scripts/e2e/run.mjs` 全文（707 行）**没有任何** `dashboard` / `3210` 字样（`Select-String` 零命中）；e2e 的 10 个检查点是 AC1/AC2/PRICE/EX1/AC3/AC4/AC5/AC6/AC7/AC8。
  - `apps/dashboard` 下**没有任何测试文件**（`*.test.ts`/`*.spec.ts` 零命中），仓库 10 个测试文件全在 `packages/mik/test/`。
  - SPEC §6 逐条对照：①AC3 ✅ ②AC4 ✅ ③**无** ④AC6（部分，见 S10）⑤AC7 ✅ ⑥AC5 ✅。
- 为什么是问题：SPEC §6 自称「唯一场景」的验收标准，其中一条既没有自动化断言、也不在可发布形态里（B3）。「10/10 PASS」给人一种「全场景验收通过」的错觉，实际是 5/6 条。
- 建议怎么改：在 `run.mjs` 加一个 AC9：起 `mik serve` + `mik dashboard`（或直接 `next start`），用 HTTP 断言首页渲染出成本数字与 `pricing.source`，并断言看板**不打开 SQLite**（只走 `/api/*`）；若确定看板不进发布包，就把 SPEC §6 ③ 改成分仓库验收并在 README 注明。

---

## 建议级

### S1. `close()` 之后一切公开成员抛裸 `node:sqlite` 错误，宿主按文档写的错误处理捕获不到

- 证据：`hub.ts:514-525`（`close()` 只关 store）；实测 `await mik.close()` 后 `generate()` / `usage.summary()` / `providers.list()` / `pricing.estimate()` 全部抛 `Error code=ERR_INVALID_STATE "database is not open"`（`isModelInfraError()` 为 false）。`packages/mik/README.md:69` 还把 `close()` 签名写成 `void`（实际 `Promise<void>`，`hub.ts:514`）。
- 为什么是问题：`packages/mik/README.md:250-254` 教宿主用 `isModelInfraError()` 判断错误；关闭后的误用会绕过这个契约，且 `pricing.estimate()` 连「纯计算」都因为要读 override 而抛错。
- 改法：`close()` 置位后让公开方法抛 `ModelInfraError("…", { code: "STORAGE" })`（或在每个入口加 `assertOpen()`）；修正 `packages/mik/README.md:69` 的返回类型。

### S2. 删除 provider 不会清理悬空的 `default_model`，此后每个省略 model 的请求都 404

- 证据：`registry.ts:115-117`（`remove()` 只删记录）、`registry.ts:189-204`（`setDefaultModel()` 只在写入时校验存在）、`hub.ts:375-395`（`resolveModel()` 直接拿 `defaultModel()` 去 `assertProvider`）。实测：`remove("ghostprov")` 后 `defaultModel()` 仍为 `ghostprov:x`，`generate({messages})` → `PROVIDER_NOT_FOUND`。CLI `provider remove`（`cli/commands/provider.ts:149-151`）也不提示、不清理。
- 改法：`remove()` 时若被删的是当前默认 provider，清掉 `DEFAULT_MODEL_SETTING` 并 `onWarn`；CLI/看板删除时打印提示。

### S3. `enabled: false` 只影响后台目录同步，不影响路由——与「启停」语义不符

- 证据：`registry.ts:124-153`（`resolve()` 不查 `enabled`）、`hub.ts:774-781`（`assertProvider()` 只查存在性）、`hub.ts:836-838`（只有 `syncCatalog()` 跳过 disabled）。实测：`add({id:"off-prov", enabled:false})` 后 `resolve()` 成功，`generate({model:"off-prov:x"})` 真的发起了出网调用并落库 1 行。
- 为什么是问题：`packages/mik/README.md:168` 写 `setEnabled(id, enabled)` = 「启停」；宿主用它做「临时下线某供应商」会以为生效。
- 改法：`resolve()`/`assertProvider()` 对 `enabled === false` 抛 `PROVIDER_NOT_FOUND`（或新增 `PROVIDER_DISABLED`），或把文档改成「仅控制目录同步」。

### S4. 只读/被锁的数据库会**静默丢计量**

- 证据：只读库实测 `init()` 成功（迁移语句都是 `IF NOT EXISTS`，无需写入），但 `providers.add()` 与 `usage.record()` 抛裸 `ERR_SQLITE_ERROR`；`hub.ts:823` 用 `safely(() => this.usage.record(event), this.warn)` 包住，而 `hub.ts:251` 的默认 `onWarn` 是 `() => {}`。也就是说：请求成功、成本算出来、**行被丢弃且没有任何信号**。
- 改法：计量失败要能被看见——首次失败强制告警（即使宿主没传 `onWarn`），或让 `record()` 返回失败计数供 `usage.summary()` 暴露「丢弃行数」。

### S5. 上游限流 / 超时的分类映射没有任何测试

- 证据：`errors.ts:93-110` 的 `RATE_LIMIT` / `TIMEOUT` 分支全靠状态码与正则；`test/` 里唯一出现 `RATE_LIMIT` 的地方是 `cli.test.ts:517` 的一个手工 fixture（不经过 `toModelInfraError`）。`test/ai-bridge.test.ts` 覆盖了 401/403/500/挂死，但没有 429/408/504。
- 改法：在 `ai-bridge.test.ts` 加 429 与 408 两个 msw 路由，断言 `code`、`retryable` 与 `ProviderStatus.ok === false`；在 `hub.test.ts` 加一条 `generate()` 对 429 的映射断言。

### S6. 被放弃 / 中断的流式调用会记成 `status:"ok"` + `cost $0`

- 证据：`hub.ts:749-771`（`finally` 里的兜底写入 `status: failure ? "error" : "ok"`，`cost: MISSING_COST()`、`usage: stepUsage ?? ZERO_USAGE()`）；`test/hub.test.ts:727` 自己用 `expect(["ok","error"]).toContain(...)` 放过了这条不确定性。
- 为什么是问题：宿主在第一个 delta 后 `break`（很常见）→ 汇总里多一条「成功」、成本记 $0，成本统计被系统性低估，而看板的成功率被高估。
- 改法：新增显式状态（如 `status:"partial"` 或 `errorCode:"ABANDONED"`），或至少在 `usage.summary()` 里把它们单独计数；测试改成断言具体状态。

### S7. `redactDeep()` 只认固定键名，自定义头里的密钥会被 `GET /api/providers` 原样吐回

- 证据：`util/redact.ts:34` —— 键名正则 `/^(authorization|api[_-]?key|token|secret|password)$/i`，**不匹配** `x-api-key` / `x-goog-api-key` / `x-auth-token`；值只走 `redact()`（`redact.ts:1-9`），只认 `sk-`/`tvly-`/`Bearer`/`key=value` 等形态，纯 hex 密钥一律放过。而 `server/api.ts:50-56` 的注释声称「every response is redacted」，`api.ts:81,90,101` 把 `providers` 记录（含 `headers`）交给它。
- 改法：把键名判定放宽为「键名包含 `key|token|secret|auth|password` 即整值替换」，并对未知形态的值也做一次兜底掩码；补一条测试：`headers: {"x-api-key": "<32 位 hex>"}` 经 `/api/providers` 后不含原值。

### S8. 契约漂移（规则 5）：一批公共导出仍不在 `docs/interfaces.md`

- 证据：`docs/interfaces.md` 里 `grep` 不到 `currentAppId`、`isEnabled`、`splitModelRef`、`MODEL_REF_SEPARATOR`、`DEFAULT_MODEL_SETTING`、`PROTOCOL_PACKAGES`、`packageForProtocol`、`readOpenAiUsage`、`createMikFetch`、`MikFetchOptions`、`X-ModelHub-Provider`；但 `src/index.ts:11-57` 全部导出，`src/server/openai.ts:279-295` 的 `X-ModelHub-Provider` 是公开 HTTP 面。`src/` 下 `@internal` 零命中。这是 R01 的 S13，**未落实**。
- 改法：要么补进 `interfaces.md`，要么给这些导出加 `@internal` 并注明「不属于契约」。

### S9. 协议守卫测试仍然很弱（R01 S10 只改了一半）

- 证据：`test/ai-bridge.test.ts:332-341` 只扫 3 个文件（`ai/bridge.ts`、`ai/protocols.ts`、`registry/registry.ts`），只匹配 `providerId ===` 与 `(id|provider) === "openai|…"`。`hub.ts`、`fetch.ts`、`server/**`、`cli/**` 不在范围内；`switch (record.id) { case "deepseek": }`、`["deepseek"].includes(record.id)`、`record.protocol === "anthropic"` 都能逃逸。
- 改法：扫描 `src/**` 全部文件，并补 `switch (…id)`、`.includes(` 与 `protocol === "…"` 之外的正向断言（例如断言协议→包映射来自 `SDK_PROTOCOLS` 表，而非任何 id 比较）。

### S10. e2e 的断言强度与覆盖面

- 恒真式断言：`run.mjs:267` `assert(["fresh","stale","error"].includes(health.pricing.status))` —— 三个合法值全覆盖，永不为假。
- 运行对象不是发布产物：`scripts/e2e/loader.mjs:29-33` 把 `model-infra-kit*` 全部映射到 `packages/mik/src`，`run.mjs:34` 也用 `src/cli/index.ts`；因此 `dist/` 与 `bin` 从未被端到端跑过（我另外用临时消费者工程手工验证了 dist 可用，仓库内无回归保护）。
- AC6 测的是**内置 archive**（注入 `PricingCatalog`，`run.mjs:533-545`），而 SPEC §6 ④ 写的是「快照兜底」——`cacheDir` 快照路径（`pricing/cache.ts`）在 e2e 里没被断言；`source === "fallback"` 只能证明 archive 在兜底。
- 改法：AC1 改成断言具体期望值；加一个跑 `dist/cli.mjs` 的检查点；AC6 拆成「archive 兜底」与「cache 快照重启后仍计价」两条。

### S11. README 与代码的数字/文案漂移（逐条）

- `README.md:219` 「✅ 239 passed / 10 files」→ 实际 **248**（`tasks/BOARD.md:33` 是对的，README 没同步）。
- `README.md:217` 「✅ 9 files / 298 kB」→ 实际 **302.54 kB**。
- `README.md:271` 「`mik serve` 的 stdout 只有……两行」→ 实际 **3 行**（`cli/commands/serve.ts:125-128` 还有 `Press Ctrl+C to stop.`）。
- `packages/mik/README.md:69` `close()` 标注 `void` → 实际 `Promise<void>`（`hub.ts:514`，契约 `docs/interfaces.md:173` 是对的）。
- `README.md:237-250` 的 `--help` 引用只贴了 `COMMANDS` 段，实际输出还有 `USAGE` / `GLOBAL OPTIONS` / `EXAMPLES`（实测），却以「真实输出」形式呈现。
- 改法：把「本机验证」列改成可复跑的脚本输出（或删掉具体数字），文案与实现对齐。

### S12. 测试里的恒真 / 过弱断言

- `test/fetch.test.ts:163,200`、`test/hub.test.ts:445,617`、`test/ai-bridge.test.ts:200` —— `latencyMs`/`firstTokenMs >= 0`：由 `Date.now()` 差值构造，**恒真**。
- `test/fetch.test.ts:211` 标题「answers 400 for an unknown provider」，断言却是 `expect(response.status).toBe(404)`（`:215`）——标题与行为不符。
- `test/hub.test.ts:304` 用 `toBeDefined()` 逐个检查成员存在性，属于「只测不崩」。
- 改法：把 `>= 0` 换成具体量级或删掉；标题与断言对齐。

### S13. 其它发布细节

- `dist/cli.mjs` **没有 shebang**（`Get-Content dist\cli.mjs -TotalCount 1` 是 `import …`；`src/cli/index.ts` 也没有 `#!`），而 `package.json:38-40` 把它登记为 `bin`。Windows 上 npm 生成 `.cmd` 垫片可用；POSIX 上 `.bin/mik` 是指向该文件的符号链接，内核需要 shebang——`npx mik` 在 Linux/macOS 上会直接失败。改法：在 `src/cli/index.ts` 首行加 `#!/usr/bin/env node`（tsdown 会保留）。
- tarball 里**没有 LICENSE 文件**（11 个文件清单已确认），而 `package.json:5` 声明 MIT、`README.md:359` 写了 License 段。
- `package.json:16-18` `engines: ">=22"` 偏宽：`node:sqlite` 从 22.5.0 才有（22.19.0 实测无需 flag）。建议 `>=22.5.0`（或按未加 flag 的版本号收紧）。
- `apps/dashboard/package.json` 的 devDependency `model-infra-kit: workspace:*` 已无人引用（全仓 `grep` 只在 `layout.tsx:9` 的文案里出现）。
- `apps/dashboard/scripts/check-port.mjs:31` 提示「换端口：PORT=<新端口>」，但脚本只读 `process.argv[2]`（`:8`），`pnpm start` 的端口写死在 `package.json` 的 `-p 3210` 里——按提示做不会生效。
- `examples/openai-sdk/index.ts:107` `mik.close()` 未 `await` 就 `process.exit(1)`（`:110`）。

### S14. `migrate()` 的版本写入没有 `OR IGNORE`

- 证据：`store/schema.ts:133-141` 先查 `schema_migrations`，再 `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`；两个进程同时冷启动同一个新库时，第二个进程可能撞主键 → `ROLLBACK` → 异常冒泡成 `init()` 失败。我用 8 进程同时冷启动**未能复现**（迁移窗口太小），属于理论窗口。
- 改法：`INSERT OR IGNORE`（或 `BEGIN IMMEDIATE`），并把「首次并发打开」写进 `docs/decisions.md` D4 的并发说明。

---

## 已核查通过（逐条对应检查清单）

### 1. README 与代码一致性 —— **不通过**（漂移见 S11，承诺不成立见 B3）

- 命令类：`build` / `typecheck` / `test` / `check` / `e2e` / `--help` 的**命令名与行为**都对得上（`package.json:43-49`）；`mik init --app-id … --provider … --yes`（`cli/commands/init.ts:48-50`）、`provider add/list/remove/test`、`models --refresh`、`pricing set/list`、`usage …`、`serve --port` 实测可用。
- 示例类：`README.md:44-76` 与 `96-125` 的两段代码与 `.tmp/t10-verify/readme-quickstart.ts` / `readme-quickstart-sdk.ts` **逐字节一致**（那是从 README 抽出来跑过的脚本），且 `mik.baseUrl` 默认 `http://127.0.0.1:0/v1`（`hub.ts:27,337`）只用于取路径后缀（`fetch.ts:240-251`），e2e AC4 正是这样跑通的。
- 端口/默认值：3211/3210/3212 与 `server.ts:25`、`cli/commands/serve.ts:112`、`cli/commands/dashboard.ts:32`、`apps/dashboard/scripts/mock-openai.mjs:17` 一致；被占端口会明确报错（实测 exit 1）。
- FAQ 2 的低层自组代码（`README.md:288-313`）与 `src/index.ts` 的导出、`CredentialStoreOptions.driver`、`PricingService`/`UsageService` 构造签名一致。

### 2. SPEC §6 六条验收是否真被 e2e 覆盖 —— **5/6，③ 缺失**（B4）

- ①AC3（generate/stream/tool 三条都落库、`cost.source=manual`）断言具体数值；②AC4（SDK 零改动、`source=fetch`）；④AC6（stale + 仍能报价，但只覆盖 archive 而非快照，见 S10）；⑤AC7（历史不变 + 新价）；⑥AC5（Python 端）。断言强度总体是真的（查 DB 行、查金额、查 source），不是「只断言不抛错」。
- ③ 看板：e2e 与单测**都没有**（B4）。我手工验证 `pnpm --filter @mik/dashboard start` → HTTP 200、上游不可用时降级提示正确，但仓库里没有这条回归保护。

### 3. R01 的 B1/B2 是否真修 —— **通过，未发现修复引入的新问题**

- B1：`usage/service.ts:108-114` 默认按实例 `appId` 过滤，`{ appId: "" }` 才放开；回归测试 `test/usage.test.ts:210`（读不到返回 null）、`:223`（显式放开能读到）、`test/server.test.ts:796`（HTTP 面同样隔离）。方向断言已改成反向断言，R01 指出的「把泄漏写成期望」不再存在。
- B2：`registry.ts:164-182` 无 `apiKeyRef` 时回退 `preset.envKey`（`tryResolve`），仍拿不到且 preset 声明了 `envKey` → 抛 `CREDENTIAL`，`apiKeySource` 三态齐备；测试 `test/registry.test.ts:197,209,228,242,250` 覆盖兜底成功/缺失报错/显式优先/无密钥/无 envKey 五种路径。`preset.envKey` 不再是死数据。
- 新问题：未发现由这两处修复引入的行为回归（`hub.ts:53-55` 把 CREDENTIAL/PROVIDER_NOT_FOUND 当作目录同步的「预期跳过」，实测 8 进程/多 app 场景正常）。

### 4. 规则合规（grep + 实测）—— **1/2/3/7/10 通过；4、6、8 有保留**

- 规则 1：`src/` 下 `.codex|.claude|opencode|.gemini|.cursor|readdirSync|.local/share` **零命中**；`homedir()` 只用于 `~/.model-infra-kit`。
- 规则 2：SQL 聚合全部 `SUM(CAST(ROUND(x*1000000) AS INTEGER))`（`usage-repository.ts:201-203,312,377,449-453`），无 `SUM(CAST(cost AS REAL))`；rollup 金额列 `INTEGER`（`schema.ts:93-95`）。
- 规则 3：`providerId ===` 只出现在注释（`types.ts:5`、`protocols.ts:35`）与 `provider.ts:38` 的展示比较（`record.id === defaultProvider`，非协议分支）；协议→包→工厂→列表适配器都是查表。
- 规则 4：`providers` 表只有 `api_key_ref`（`schema.ts:18`）；`credentials` 表只存 ref/backend；`src/` 无 `console.*`；密钥不落库成立。**但**库调用面的错误 message 未脱敏（B2）、`redactDeep` 对自定义头键名失效（S7）。
- 规则 5：**不通过**，见 S8。
- 规则 6：**不通过**，见 B1（不是抛错，是永不返回）。
- 规则 7：`_research/` 无引用、无打包。
- 规则 8/11：`credential/store.ts:129-142` 改为先 `renameSync` 到 `~/.model-infra-kit/trash/`，跨设备失败时先复制再 `rmSync`（`:139-140`）——原文件内容已在回收站，可恢复；这是唯一残留的 `rmSync`，属可接受，但严格讲仍是「彻底删除」语义，建议改成「复制成功后再删」的显式注释或改为 `moveFileSync` 重试。
- 规则 9/10：交证证据齐全（BOARD 指标与实测一致）。

### 5. API 设计坑 —— **有问题，见 S1/S2/S3/S4**（并发 init 反而通过）

- `close()` 后误用、删除 provider 后默认模型悬空、`enabled:false` 仍被路由、只读库静默丢计量，四条都有实测复现（见开头探针表）。
- provider 名含非法字符：`registry.ts:72-78` 用 `/^[A-Za-z0-9._-]{1,64}$/` 拦下（测试 `registry.test.ts:258-273`），R01 的 S8 已修。
- 多 app 共库：8 进程 × 40 行并发写入 0 失败；`usage.get()`/列表查询默认隔离，`rollupAndPrune()` 全局语义已在 `usage/service.ts:116-127`、`docs/decisions.md` D7、`README.md:331-335` 写明。
- 默认模型指向不存在的 provider：`setDefaultModel()` 会拒绝（`registry.ts:197-202`），但**事后**删除 provider 会制造悬空（S2）。

### 6. 失败路径 —— **多数可接受，两条不可接受**

| 场景 | 会发生什么 | 是否可接受 |
|---|---|---|
| 上游超时 | `bridge.test()` 有 15 s 默认 / `meta.timeoutMs` / `MIK_PROVIDER_TIMEOUT_MS`（`bridge.ts:28-34`），挂死用例已覆盖；`generate/stream` 交给 SDK，映射 `TIMEOUT`（`errors.ts:102-109`） | 可接受，但映射**无测试**（S5） |
| 上游限流 429 | `RATE_LIMIT` + `retryable:true`（`errors.ts:93-100`），SDK 自行重试 | 可接受，**无测试**（S5） |
| 畸形响应 | 模型列表 JSON 不可解析 → `PROVIDER` + 可读文案（`bridge.ts:127-132`，测试 `ai-bridge.test.ts:311`）；`fetch` 适配器解析不了 usage → 记 0 usage 但**行存在**（`fetch.ts:199-206`） | 可接受（成本失真需知悉） |
| 价格源不可达 | `stale` + archive 兜底，仍能报价（e2e AC6 实测 `$0.42/M`） | 可接受 |
| 价格目录挂死 | `init()` 永不返回（B1） | **不可接受** |
| DB 损坏 | `init()` 抛 `STORAGE`「file is not a database」（实测） | 可接受 |
| DB 只读/被锁 | `init()` 成功，写入抛裸 `ERR_SQLITE_ERROR`，计量经 `safely` 静默丢弃（实测） | **不可接受**（S4） |
| 端口被占 | `error: Port 3219 is already in use … Refusing to start.` exit 1（实测；`server.ts:88-95,97-111`） | 可接受 |
| token 错误 | 401 + `www-authenticate`，`/api/health` 除外（`server.ts:173-181`，测试 `server.test.ts:378,403`） | 可接受 |
| 关闭后误用 | 裸 `ERR_INVALID_STATE`（实测） | 可接受但不合契约（S1） |

### 7. 测试质量 —— **整体扎实，有零星弱点**

- 无 `.skip`/`.only`/`.todo`；248 条全部真跑。
- 无联网依赖：pricing 全部注入 `catalog`/`fetch`，bridge 用 `@ai-sdk/test-server`（msw）+ 本地挂死 server，fetch 用 msw。
- 强断言占多数：`fetch.test.ts:136-141`（真实出网头/URL/请求体）、`:160`（完整 usage 元组）、`:183-184`（调用方密钥被替换且不出现在任何请求）、`pricing.test.ts` 的下载计数与「缺失字段不得当 0」双向断言、`hub.test.ts:695-733`（记账时机）、`server.test.ts:796`（跨 app 不可见）。
- 弱点：恒真断言与标题不符（S12）、守卫测试弱（S9）、e2e 恒真断言（S10）、AUTH 分支的「不含密钥」断言因文案固定而恒真（B2 的成因）。
- `src/server/openai.ts` 与 `src/fetch.ts` 的协议映射覆盖：`server.test.ts` 38 条覆盖了 system 合并、tools/tool_calls 往返、流式工具增量、错误状态码、X-ModelHub-Provider 路由、默认模型回退、`user`→sessionId、非法 role/tool_call_id；`fetch.test.ts` 12 条覆盖转发/计量/裸模型/凭据剥离/流式/非生成请求/未知 provider/无默认模型/非 JSON 体/上游错误不泄漏/连接失败/Request 对象。**未覆盖**：流式响应中途客户端断开时的计量（`fetch.ts:181-195` 的 `flush` 不会执行 → 不落库）、`X-ModelHub-Provider` 与显式 model 冲突、图片 part、`max_tokens`/`max_completion_tokens` 优先级。

### 8. 发布准备 —— **包体可用，`bin` 与看板不达标**

- `exports`/`main`/`types` 三入口齐全且 `npm pack` 产物自洽（`dist/index.mjs` 只 re-export 两个 hash chunk，均在包内）；`import` + `createServer` + `/api/health` 在临时消费者工程里跑通（Node 24.14 与 22.19 各一次）。
- `peerDependencies` 7 个 `@ai-sdk/*` 全部 optional，缺包时 `loadProviderFactory()` 给出 `npm i …` 提示（测试 `ai-bridge.test.ts:383`）。
- 不达标项：`bin` 无 shebang（S13）、无 LICENSE 文件（S13）、`engines` 偏宽（S13）、看板不随包发布（B3）。

---

## 一句话结论

R01 的 B1/B2 确实修好了、248 条测试与 10/10 e2e 我独立复跑为真、金额与协议两条硬规则在代码层站得住；但 **`ModelInfra.init()` 会被价格目录无限阻塞（规则 6）、`ModelInfraError.message` 未脱敏而文档承诺已脱敏（规则 4）、README 承诺的 `npx mik dashboard` 在发布包里必然失败、SPEC §6 ③ 验收项零覆盖** 这四条未解决之前，V0.1 不能交付。
