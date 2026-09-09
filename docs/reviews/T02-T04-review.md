# T02 / T03 / T04 对抗日志评审

- 评审对象：commit `eedff0a`（`packages/mik/src/{registry,ai,pricing,usage}` + 对应 3 个测试文件）
- 评审方式：只读代码 + grep + 只读命令复跑；**未修改任何源码/测试**
- 复跑证据（本机实测）：
  - `pnpm exec vitest run test/registry.test.ts test/ai-bridge.test.ts test/pricing.test.ts test/usage.test.ts` → **65 passed / 4 files**
  - `pnpm exec vitest run` → **81 passed / 6 files（3.26s，无联网）**
  - `pnpm --filter model-infra-kit typecheck` → `tsc --noEmit` **0 错误**
  - 手工探针（`node --input-type=module`，cwd=packages/mik）：7 个协议工厂按 bridge 的入参全部可建模型
    `openai OK openai.responses / anthropic OK anthropic.messages / google OK google.generative-ai / deepseek OK deepseek.chat / moonshotai OK moonshotai.chat / xai OK xai.responses / openai-compatible OK probe.chat`
  - `grep`：`providerId ===` 仅出现在注释；无 `.codex/.claude/opencode` 读取；无 `console.*`

---

## 阻断级

### B1. T04 `get()` 完全没有 appId 过滤，且测试把跨 app 读取写成了期望值

- 证据：
  - `packages/mik/src/usage/service.ts:86-89` —— `get(requestId)` 直接 `this.store.usage.get(requestId)`，不过 `scoped()`（同文件 `62-64` 的 scoped 只服务带 `UsageQuery` 的 5 个方法）。
  - `packages/mik/test/usage.test.ts:163-172` —— 断言 `a.get(event.requestId)?.appId` 等于 `"app-b"`，即**把"app A 能读到 app B 的用量明细"固化成期望**。
  - 卡片 `tasks/T04-usage-service.md:16` 验收第 3 条明确写「`summary/trends/byProvider/byModel/query/get` 全部透传…**并默认带上 appId 过滤**」，`get` 在列。
- 为什么是问题：用量明细含 `sessionId`、`tags`、成本、模型名。多 app 共库（`ModelInfraConfig.appId` 的设计前提，`src/types.ts:244-247`："lets one DB serve many apps"）下，任一 app 只要知道/猜到 `request_id` 就能读别人一条记录；`clear()` 是 app 级（`service.ts:97-99`）而 `get()` 是全局，隔离是单向的。这也与 T04 验收第 6 条"按 appId 隔离（两个 app 的数据互不串）"矛盾。
- 建议怎么改：二选一，由指挥裁决并同步文档：
  1. `get(requestId: string, query?: Pick<UsageQuery,"appId">)`：无 query 时用 `this.appId`，`appId: ""` 才放开（与 `scoped()` 同语义），同时改 `docs/interfaces.md:131` 与卡片；
  2. 若确定 `request_id` 全局可见，则把卡片第 3 条的 `get` 删掉、在 `interfaces.md` 写明"`get` 不按 app 过滤"，并把 `test/usage.test.ts:163-172` 改成显式断言"这是有意为之"（至少注释来源）。
- 现状必须修的原因：现在既没满足卡片，也没在契约里写清，测试还反向固化，T07 的 `GET /api/usage/logs/:id`（`docs/interfaces.md:175`）会直接把跨 app 明细吐出去。

### B2. T02 `resolve()` 在"该供应商需要密钥但没配 `apiKeyRef`"时返回 `apiKey: null`，绕过了验收第 3 条的 CREDENTIAL，且 `preset.envKey` 是死数据

- 证据：
  - `packages/mik/src/registry/registry.ts:131` —— `const apiKey = record.apiKeyRef ? this.deps.credentials.resolve(record.apiKeyRef) : null`：没有 ref 就**根本不问 CredentialStore**，直接 null。
  - `grep -n "envKey" packages/mik/src` → 只有 `types.ts:34`（类型）与 `presets.ts:31/40/49/58/67/76/85`（预设表），**没有任何地方读取**。也就是说 preset 声明的 `OPENAI_API_KEY` 之类从来没有参与解析。
  - 可观察后果：`registry.add({ id:"oa", presetId:"openai" })`（CLI `provider add --preset openai` 不给 ref 的正常写法）→ `resolve().apiKey === null` → `MODEL_LIST_PROTOCOLS.openai.headers` 的 `BEARER()` 返回 `{}`（`src/ai/protocols.ts:242-243`）→ `bridge.test("oa")` 发出**不带认证**的 `GET /models` → 401 → `ok:false "API key rejected by the provider"`；而同一条 provider 的 `bridge.languageModel("oa", …)` 却把 `apiKey: undefined` 交给 SDK，由 SDK 自己读环境变量而**能正常调用**（`src/ai/protocols.ts:41-45`）。同一次配置，`provider test` 失败、`generate` 成功。
  - 测试只覆盖了"合法的无密钥供应商"（`test/registry.test.ts:199-204`，裸 `baseUrl` 的本地服务），没有任何测试覆盖"preset 有 `envKey` 但没配 ref"。
- 为什么是问题：卡片 `tasks/T02-provider-registry-ai-bridge.md:16` 要求「密钥缺失抛 `ModelInfraError`，code 为 `CREDENTIAL`」。现在"密钥缺失"被静默降级成 null，错误码从 CREDENTIAL 漂移到 AUTH/环境变量兜底，宿主（T06 CLI、T07 看板）无法区分"这个供应商不需要密钥"和"你忘了配密钥"。`interfaces.md:41` 注释 `// null 表示该供应商无需密钥` 与实现的语义（"没配 ref"）也不一致。
- 建议怎么改：
  1. `resolve()` 里在无 `apiKeyRef` 时，若 `preset?.envKey` 有值则用 `credentials.tryResolve("env:" + preset.envKey)` 兜底；
  2. 兜底仍拿不到且 preset 声明了 `envKey` → 抛 `CREDENTIAL`（"provider X 需要密钥，请设置 OPENAI_API_KEY 或配置 apiKeyRef"）；
  3. `ResolvedProvider` 增一个字段（如 `apiKeySource: "ref" | "env" | "none"`）或至少把 `interfaces.md:41` 的注释改成"null 表示没有可用密钥"；
  4. 补两条测试：preset+env 兜底成功、preset+env 缺失抛 CREDENTIAL；并补一条"无认证时 `test()` 的报错文案不要误导成密钥被拒"。

---

## 建议级

### S1. T03 手动价命中时仍然会去碰上游（卡片"不再查上游"不成立，测试也测不到）

- `src/pricing/service.ts:109-113`：`estimate()` 先 `this.warm()`（`:184-187` → `load(false)` → `catalog.ensureLoaded()`）**再**查 override。命中 `pricing_overrides` 时价格确实不查上游，但后台已经发起/排队了一次目录加载（生产上默认源是 models.dev 的 ~4MB `api.json`）。
- `test/pricing.test.ts:143-161` 的 spy 只盯 `catalog.estimate`，`archiveCatalog()` 的 `sources: []` 又不会联网，所以这条断言无法证明"不查上游"。
- 改法：把 override 判定提到 `warm()` 之前（`const manual = this.findOverride(...); if (manual) return ...; this.warm();`），或在卡片/文档里把"不再查上游"改成"不再按上游价格计价"。

### S2. SPEC §4"缺失不得当作 0"在契约层无法表达，三处靠强转维持

- `src/types.ts:111-117` 的 `TokenUsage` 五个字段都是必填 `number`，所以"`cacheWriteTokens` 缺失"无法沿公共类型传下来。
- 实际维持靠三处强转：`src/pricing/service.ts:205`（`as unknown as TokenCounts`）、`test/pricing.test.ts:81`（`{input,output} as TokenUsage`，这一条正是"缺失字段"测试的唯一构造方式）、`src/hub.ts:99-102`（T05 另造 `pricing: counts as TokenUsage`，注释自陈"`TokenUsage.cacheWrite` is a required number in the T01 contract"）。
- 这正是 `AGENTS.md` 复盘第一条（"契约缺陷会以强转的形式暴露"）的同型问题。改法：把价格路径的入参改成 `Partial<TokenUsage>`（或给 `TokenUsage` 的 cache/reasoning 加可选），并在 `interfaces.md` 里写明；再补一条"从 AI SDK usage 形状到 `estimate()` 入参"的端到端测试，而不是只 spy 一个手写对象。

### S3. T03 手动价缺费率会静默记成 $0

- `src/pricing/service.ts:256-269`：`inputPerM ?? 0`、`outputPerM ?? 0`（`cacheRead/cacheWrite` 退回 input 率）。所以 `setOverride({ modelId: "x" })` 或只给 `outputPerM` 时，input 侧一律 0，`source: "manual"`，**不触发** `warnMissing`（`:235-239` 只在目录无价时告警）。
- 后果：宿主以为"我设了手动价"，实际成本记成 0，看板还标 `manual`。
- 改法：`setOverride` 校验至少给 `inputPerM` 或 `outputPerM`（否则抛 INVALID_REQUEST），缺的字段走 `onWarn`。

### S4. T03 `priceFor()` 只返回基础卡，且不 warm，与 `estimate()` 行为不一致

- `src/pricing/service.ts:133-138,284-296`：`pricingFromCard()` 丢掉 `card.contextTierAbove` / `card.reasoningMode`（llm-pricing 的 `ModelPrice` 带这两个字段，见 `node_modules/llm-pricing/dist/resolve-CZuloOeh.d.mts:33-48`）。长上下文分档/思考模式的模型，UI 上显示的"单价"是基础卡，和实际计费不一致。
- 另外 `priceFor()` 不调 `warm()`，`estimate()` 调：同一个进程里 `priceFor` 可能长期报 archive 价、`estimate` 已经用上 live 目录价。
- 改法：`priceFor(model, at, facts?)` 透传 `RequestFacts`，或至少在返回里带上 tier/reasoning 标识；并让 `priceFor` 也触发一次 `warm()`（或文档写明它只读当前快照）。

### S5. T04 `record()` 里 `onEvent` 抛错会冒泡，事件却已落库

- `src/usage/service.ts:50-56`：`insert` 成功后才 `this.onEvent?.(stored)`，没有任何 try/catch。监听者抛错 → 调用方拿到异常，但行已经写进去了。重试会得到 `false`（幂等），于是宿主既看到异常又看到"没记录"。
- 卡片没要求、测试没覆盖（`test/usage.test.ts:91-109` 只验证正常路径）。T05 已经自己用 `safely(() => this.usage.record(event), this.warn)`（`src/hub.ts:698`）兜住——说明这个坑真实存在，且每个调用点都得自己兜。
- 改法：`record()` 内部 try/catch 包住 `onEvent`，异常交给 `onWarn`（`UsageServiceDeps` 需加 `onWarn`），或在 `interfaces.md` 明确"`onEvent` 必须不抛"。

### S6. T04 `rollupAndPrune()` 的删除是全局的，能删掉别的 app 的明细行

- `src/usage/service.ts:92-94` 直接透传；`src/store/usage-repository.ts:433-478` 的 `rollup(cutoff)` 里 `WHERE ts < ?` **没有 app 过滤**，`DELETE FROM usage_events WHERE ts < ?` 同样全局，返回的删除条数是所有 app 的总和。
- 后果：app A 调一次维护，app B 的明细行消失（汇总数字还在 rollup 里），而 `clear()`（`:97-99`）却是 app 级的。测试只覆盖单 app（`test/usage.test.ts:176-191`）。
- 改法：`rollupAndPrune(now?, retentionDays?, appId?)` 透传 appId（需同步契约），或至少在校验清单/文档里写明这是全局维护操作，并补一条两 app 的测试。

### S7. T02 `list()` 不按 appId 过滤（多 app 共库时互相看到配置）

- `src/registry/registry.ts:54-56` 调 `store.providers.list()` 不传 appId；同文件 `45-50` 的注释把这一点当作设计（"ids 全局唯一，所以 list/get 不按 app 分"），但 `store.providers.list(appId?)` 是支持过滤的（`src/store/provider-repository.ts:34-39`），且 `add()` 会把 `appId` 盖到记录上（`registry.ts:98`）。
- 后果：app A 的 CLI/看板能看到 app B 的 `baseUrl`、`apiKeyRef`、`meta`（不含密钥本体，但是配置泄漏）。
- 测试全是单 app（`test/registry.test.ts` 通篇一个 `t02-app`），没有覆盖。
- 改法：`list(appId?)`/`get(id)` 增加 app 维度（会动契约，需指挥批），或至少在 `interfaces.md` 写明"provider 表全局共享"。

### S8. T02 `add()` 不校验 provider id，含 `:` 的 id 会静默破坏 `provider:model` 引用

- `src/registry/registry.ts:63-100` 只校验 preset/protocol/npmPackage，不校验 `config.id`（空串、含 `:`、含空格都能写库）。而 `splitModelRef()`（`:34-39`）按**第一个** `:` 切分。
- 复现：`registry.add({ id: "my:proxy", baseUrl: "http://127.0.0.1:11434/v1" })` → `bridge.languageModel("my:proxy", "m")` 里 `resolved.record.id` 是 `my:proxy`，`createProviderRegistry` 的 key 也是它，但 `setDefaultModel("my:proxy:m")` 解析出 providerId=`my`（不存在）→ 默认模型永远 `PROVIDER_NOT_FOUND`。
- 改法：`add()` 校验 `/^[A-Za-z0-9._-]{1,64}$/`，禁止 `:`；`setDefaultModel()` 顺便校验 provider 存在（现在 `"ghost:m"` 能写进 settings）。

### S9. T02 `test()` 把上游响应体（脱敏后）拼进 message，脱敏规则只认固定形态

- `src/ai/bridge.ts:41-47` 先 `redact(body)`，`:49-54` 再拼进 `ProviderStatus.message`；`src/util/redact.ts:1-9` 只覆盖 `api_key=`/`sk-`/`tvly-`/`ghp_`/`Bearer` 等形态。
- 若上游以纯 hex、自定义前缀（很多自建网关）回显密钥，就会原样进 message → 进 CLI 输出、看板、SSE。现有测试只覆盖 `sk-` 形态（`test/ai-bridge.test.ts:203-211`）。
- 改法：401/403 时不带 body（状态码 + 映射文案已经够）；或在 `failureMessage` 里对 body 再走一遍 `maskSecret` 式兜底；补一条"无前缀 hex 密钥不外泄"的测试。

### S10. 测试质量：一条恒真断言 + 一个弱正则守卫

- `test/pricing.test.ts:264-270`：`expect(service.candidates(x)).toEqual(pricingCandidates(x))` —— 实现就是 `return pricingCandidates(model)`（`src/pricing/service.ts:160-162`），等于把同一个函数调两遍比大小，**永远为真**，唯一能失败的场景是函数非确定。至少应断言一个具体候选值（下一行已经做了 `toContain("deepseek-chat")`，说明这条 `toEqual` 是冗余的）。
- `test/ai-bridge.test.ts:304-313`：用正则扫 3 个文件来证明"没有 provider 分支"，只能抓 `providerId === "x"` / `id === "x"` 这类写法；`switch (record.id) { case "deepseek": }`、`["deepseek"].includes(record.id)` 都逃得掉，而且只扫 3 个文件（`src/ai/index.ts`、未来的 `hub.ts`/`server/**` 不在内）。规则 3 的守卫强度与它声称的不匹配。
- 另：`test/ai-bridge.test.ts:220-233` 的"超时"用例要 `server.server.stop()` 再 `start()`，是全套里唯一有顺序依赖的用例；目前绿，但并发跑其它文件时属于潜在 flake 点。

### S11. 漏测清单（对照三张卡验收标准，逐条）

T02（`tasks/T02-provider-registry-ai-bridge.md`）：
- 验收 3：`resolve()` 的"需要密钥但未配 ref"路径无测试（见 B2）。
- 硬性约束"`@ai-sdk/*` 缺失时给出可读错误（提示装哪个包）"：`src/ai/protocols.ts:117-124` 的 catch 分支**零覆盖**（7 个包都装了，测试环境里跑不到）。
- 验收 4：只有 `openai-compatible` 走通了 `languageModel()`（`test/ai-bridge.test.ts:151-178`）；`SDK_PROTOCOLS` 里 anthropic/google/deepseek/moonshotai/xai 的 `factoryOptions` 从未被调用，即"协议选择是数据映射"只验证了 1/7 条路径。我用外部探针证明 7 条都可用（见开头证据），但仓库里没有回归保护。
- 验收 1：`envKey` 字段存在性无断言（`test/registry.test.ts:59-67` 只查 id/name/protocol/npmPackage/docUrl）。
- 验收 7 的"超时"覆盖到了，但只覆盖 `meta.timeoutMs` 分支，`MIK_PROVIDER_TIMEOUT_MS`（`src/ai/bridge.ts:31`）与默认 15s 无测试。

T03（`tasks/T03-pricing-service.md`）：
- 验收 3 的 `providerId` 透传无断言（`service.ts:129`）；archive 卡没有 `providerId`，`modelsdev` 源又没被测到，所以 `CostInfo.providerId` 实际是死字段（0 覆盖）。
- 验收 4 的"不再查上游"无有效断言（见 S1）。
- 验收 7 只测了注入 `cacheDir`，默认 `~/.model-infra-kit/cache`（`src/util/paths.ts:22-24`）路径无覆盖（次要）。
- 验收 1 的"断网仍能出价"覆盖良好（`test/pricing.test.ts:202-215`）；"`init()` 永不抛错"覆盖了"目录抛错"和"源不可达"两种，但**没有覆盖注入的 `onWarn` 自己抛错**的情形——那种情况下 `init()` 会 reject（`service.ts:169-174` 的 catch 里直接调 `this.onWarn`），与"永不抛错"的字面承诺冲突。

T04（`tasks/T04-usage-service.md`）：
- 验收 3：`get` 无 appId 过滤（见 B1）。
- 验收 6："按 appId 隔离"在 `get` 上被反向断言（`test/usage.test.ts:163-172`）。
- `onEvent` 抛错路径无测试（见 S5）；`rollupAndPrune` 的多 app 行为无测试（见 S6）。

### S12. 自述与代码不符：`ProviderConfig.protocol` 的注释与 17 处强转已过时

- `src/registry/registry.ts:73-75` 注释写「`ProviderConfig` types `protocol` as required, so it is read as optional even though the type marks it required」，`test/registry.test.ts:38-51` 同样写「`ProviderConfig` types `protocol` as required, so the omission has to be forced here」。
- 但 `src/types.ts:42-46` 现在已是 `protocol?: Protocol`（`AGENTS.md` 复盘也承认"已改成可选 + 存储层兜底"）。也就是说这些注释描述的是**已经不存在的契约**，而 `grep "as unknown as" test/` 的 17 处强转（registry 8 处、ai-bridge 5 处、pricing 4 处）里，多数只是历史残留，还会掩盖真实类型错误。
- 改法：删/改两处注释；把 `registry.test.ts:50/148/152/160-161/200/210/220`、`ai-bridge.test.ts:129/136-137/143/186` 里不再必要的 `as unknown as ProviderConfig` 去掉，让 `tsc` 真正校验测试入参（保留 `pricing.test.ts:224/282/292` 那三处必要的 stub 强转）。

### S13. 契约漂移：新增的公共成员没有进 `docs/interfaces.md`

- 规则 5 要求"不改公共接口而不改契约"。实际新增但未在 `interfaces.md` 出现的公共面：
  - `UsageService.currentAppId` / `isEnabled`（`src/usage/service.ts:33-41`，注释自称"not part of the contract"）
  - `splitModelRef` / `MODEL_REF_SEPARATOR` / `DEFAULT_MODEL_SETTING`（`src/registry/index.ts:1-8`）
  - `PROTOCOL_PACKAGES` / `packageForProtocol`（`src/registry/index.ts:9`）
  - `MODEL_LIST_PROTOCOLS` / `SDK_PROTOCOLS` / `loadProviderFactory` 等（`src/ai/index.ts:2-10`）
- `PricingServiceDeps` 的 `catalog`/`fetch` 已在契约里（`interfaces.md:87-90`），这一条 T03 做对了；T02/T04 没做。
- 改法：要么补进 `interfaces.md`，要么在导出上加 `@internal` 并说明"不属于契约"，让 T05/T06/T07 知道哪些能依赖。

### S14. T03 `warnedMissing` 无上限

- `src/pricing/service.ts:73` + `:235-239`：`Set<string>` 按模型名永久累积。若宿主把请求参数里的模型名（带日期/版本后缀）透传给 `estimate()`，这个集合会随进程寿命单调增长。改法：LRU/上限（如 1000 条后清空）或改成"每模型最多告警一次 + 计数"。

### S15. 范围外但顺手记一笔

- `src/credential/store.ts:114` 用 `rmSync` 删凭据文件，违反 `AGENTS.md` 第 8 条（删除必须进回收站）。不在 T02–T04 的拥有文件里，留给 T01 或指挥裁决。

---

## 已核查通过（逐条对应检查清单）

### 1. 映射正确性（T03 → llm-pricing）—— 通过

- 代码：`src/pricing/service.ts:194-210`。`finite()`（`:242-244`）把 `undefined`/非有限值原样保留为 `undefined`，不做 `?? 0`；`cacheCreationInputTokens` 只在 `usage.cacheWrite` 存在时才有值。
- 测试证据：`test/pricing.test.ts:75-91` 用 `{ input: 1000, output: 200 }` 构造缺失字段，断言 `cachedInputTokens/cacheReadInputTokens/cacheCreationInputTokens/reasoningOutputTokens/at` **全部 `toBeUndefined()`**；`:47-73` 断言完整映射（含 `inputIncludesCache/reasoningIncludedInOutput/perRequest/at`）。
- 额外核对：实现同时传了 `cachedInputTokens` 与 `cacheReadInputTokens`（同值），查 llm-pricing 实现 `node_modules/llm-pricing/dist/index.mjs:64-65` —— `cacheRead = count(cacheReadInputTokens) || max(0, cached - cacheCreation)`，即 `cacheReadInputTokens` 优先，**不会重复计费**；`cachedInputTokens` 只是 SPEC §4 表里没列的冗余字段（建议后续删掉或补进 SPEC，不影响金额）。
- 语义核对：`inputIncludesCache: true` 下 `fresh = input - cacheCreation - cacheRead`（`index.mjs:68`），与 SPEC §4"inputTokens 含 cache"一致；`reasoningIncludedInOutput: true` 下不重复计费（`index.mjs:72`），`test/pricing.test.ts:119-123` 用"reasoning=output"反证了这一点。

### 2. 金额精度 —— 通过

- SQL 聚合全部是整数微美元：`src/store/usage-repository.ts:201-203`（明细）、`:312`（分组）、`:377`（趋势）、`:451-453`（rollup 写入）均为 `SUM(CAST(ROUND(x * 1000000) AS INTEGER))`，没有 `SUM(CAST(cost AS REAL))`。
- rollup 表金额列是 `INTEGER`（`src/store/schema.ts:93-95`），rollup 累加是整数加法（`usage-repository.ts:469-471`）。
- TS 侧只用 `toMicroUsd/fromMicroUsd`（`src/store/money.ts:2-10`）做整数累加，最后一次才转回浮点展示（`usage-repository.ts:299`、`:364`）。
- T02/T03/T04 自身没有任何美元浮点求和：T03 单笔走 llm-pricing 浮点（卡片 `tasks/T03-pricing-service.md:30` 明确允许），T04 不碰金额，T02 不碰金额。

### 3. 规则绕过 —— 通过

- `grep -n "providerId ===|id === \"(openai|…)\""` 在 `src/` 下只命中两处**注释**（`src/types.ts:5`、`src/ai/protocols.ts:35`），没有真实分支；协议→包/工厂/列表适配器都是查表（`src/registry/presets.ts:10-18`、`src/ai/protocols.ts:37-102`、`:246-296`）。
- `grep -n "\.codex|\.claude|opencode|\.gemini|readdirSync"` 在 `src/` 下**零命中**；`homedir()` 只用于 `~/.model-infra-kit`（`src/util/paths.ts:6-13`）。未读任何第三方应用数据。
- `grep -n "console\.(log|warn|…)"` 在 `src/` 下**零命中**；日志/响应统一走 `redact`（`src/ai/bridge.ts:42,51,53`）。
- 密钥不落库：`providers` 表只有 `api_key_ref`（`src/store/schema.ts:18`），`upsert` 只写 `apiKeyRef`（`src/store/provider-repository.ts:83`）；`credentials` 表只存 ref/backend（`schema.ts:102-106`），不存值。
- 唯一的环境变量读取是 `MIK_PROVIDER_TIMEOUT_MS`（`src/ai/bridge.ts:31`），不是密钥。

### 4. 失败路径 —— 通过（含一处边界，见 S11 T03 条）

- `PricingService.init/refresh`：`load()` 用 try/catch 包住 `ensureLoaded/refresh`（`src/pricing/service.ts:164-177`），失败只写 `lastError` + `onWarn` 并降级 `state()`。测试双向证明：源不可达 → `stale` 且仍能出价（`test/pricing.test.ts:202-215`）；目录本身 reject → `error` 且不抛（`:217-233`）。
- `AiBridge.test/discoverModels`：整个函数体在 try/catch 内（`src/ai/bridge.ts:149-187`），同步抛出（`registry.resolve` 的 `PROVIDER_NOT_FOUND`/`CREDENTIAL`、`requireBaseUrl` 的 INVALID_REQUEST）也都被捕获。测试覆盖未知 provider、无 baseUrl、500、401、挂死（`:220-246`、`:283-293`），全部 `ok:false`/`[]` 且不抛。
- 边界：注入的 `onWarn` 若自己抛错会冒泡（`service.ts:173`、`bridge.ts:165/184`），"永不抛错"依赖宿主传入的告警函数不抛。见 S11。

### 5. 漏测 —— 有问题（不通过）

见 S11 的分卡清单；最实质的三条是：T02 的 `loadProviderFactory` 缺包错误分支零覆盖、T02 除 openai-compatible 外 6 个协议的 `factoryOptions` 零覆盖、T03 的 `CostInfo.providerId` 零覆盖。全部 65/81 条现有测试是真的在跑（我复跑过），没有"跳过的用例"。

### 6. API 设计坑 —— 有问题（不通过）

- `resolve().apiKey === null` 语义歧义 → B2。
- `list()` 不按 appId 过滤 → S7。
- `estimate()` 同步但目录未加载：`warm()` 已在首调时后台加载（`service.ts:184-187`），断网/未加载时用 archive 兜底，不会抛，属于可接受；但手动价命中也会触发加载（S1），且 `priceFor()` 不 warm（S4）。
- `onEvent` 抛错冒泡 → S5。
- `get()` 不按 appId 过滤 → B1；`rollupAndPrune()` 全局删除 → S6。
- `add()` 不校验 id / `setDefaultModel()` 不校验 provider 存在 → S8。
- `setOverride()` 缺费率静默 $0 → S3。

### 7. 测试质量 —— 部分有问题

- 恒真断言：`test/pricing.test.ts:264-270`（S10）。
- 弱守卫：`test/ai-bridge.test.ts:304-313`（S10）。
- 依赖真实网络：**没有**。pricing 全部注入 `catalog`/`fetch`（`test/pricing.test.ts:24-37,272-298`），bridge 用 `@ai-sdk/test-server`（msw 拦截）+ 本地 `127.0.0.1:0` 挂死 server（`test/ai-bridge.test.ts:34-108`）；我复跑时断网与否都不影响（3.26s 全绿）。
- 断言强度：整体不错——`test/usage.test.ts:67-79` 断言了"不覆盖已有行"（模型名+金额都变），`test/ai-bridge.test.ts:166-169` 断言了真实出网请求头与 URL，`test/pricing.test.ts:272-298` 用下载计数器断言"第二次不重复下载"。这些不是"只断言不抛错"的水测试。
- 但"只断言长度/不抛错"的地方确实存在：`test/ai-bridge.test.ts:291-293`（未知 provider 只断言 `[]` + 1 条 warning，没断言 warning 内容）、`test/registry.test.ts:219-224`（只断言 `warnings[0]).toContain("broken")`）。

---

## 一句话结论

T03 的映射、精度、离线降级和 T02 的协议数据映射、脱敏、失败不抛都过了（65/81 测试与 typecheck 我独立复跑过），但 **T04 的 appId 隔离在 `get()` 上不成立且被测试反向固化（B1）**、**T02 的 `resolve()` 在"需要密钥却没配 ref"时静默返回 null 而 `preset.envKey` 是死数据（B2）** 这两条必须修；其余 15 条为契约/测试质量与宿主误用风险，建议随 T05 落地一起收口。
