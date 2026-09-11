# EVO-G05 — 密钥脱敏加固 + 配置/契约真相表（G12+G13+G08）

> 来源：Product Evolution Orchestrator 第 5 轮 vertical slice（LATER 集群中「正确性与契约」耦合项）。
> 依据：`.tmp/audit-reliability.md` P2-1（redact 漏短密钥）、`.tmp/audit-architecture.md` 3.1/3.2/6.2（配置三源优先序无总表、env 清单未全进契约、ModelInfraConfig 字段缺清单）。G12 证据已由 Orchestrator 复读 `src/util/redact.ts` 核验。

## 目标

① 让「密钥永不泄露」这条核心承诺在**短密钥/非常规形态**下也成立；② 把「配置从哪来、优先级如何」与「公开配置字段/env 清单」写成契约唯一真相（interfaces.md），并用测试锁定两条既有优先序，消除文档-代码漂移。

## 用户场景

- 宿主把一个 12 字符以内的短 key 或含 `+/=` 的 key 放进错误路径（上游 4xx 回显、配置解析失败消息）→ CLI/日志里**不应**出现明文。
- 新接手的开发者（或 Worker）读 `docs/interfaces.md` 就能知道：`MIK_*` 有哪些、CLI 与库两种用法下 `db/appId` 的优先级分别是什么、`ModelInfraConfig` 有哪些字段——不必去翻两处注释。

## 当前问题（已核验）

1. **G12**：`src/util/redact.ts:4` Bearer 规则要求 `[A-Za-z0-9._\-]{8,}`（≥8 字符且受限字符集）；`:6` key=value 规则要求 `[^\s"',;]{4,}`（≥4 字符）。→ 短 key（如 `Bearer abc12`）与含 `+/=`、Unicode 的 key 不被掩码。`:7-10` 已知前缀规则同样带 `{8,}`。
2. **G13**：`docs/interfaces.md` 未列 `MIK_CONFIG`/`MIK_CACHE_DIR`/`MIK_APP_ID` 等 env 语义；`ModelInfraConfig`（`src/types.ts`）字段清单（`syncCatalog`/`recordUsage`/`onWarn`/`cacheDir`/`providers`/`defaultModel`…）未进契约；F16 只追加了部分 `ModelInfraOptions`。
3. **G08**：配置优先级无总表，且**两套代码路径优先序不同**——CLI（`cli/context.ts:140-143`）为 flag → env → `mik.config.json` → 内置默认；库嵌入（`hub.ts:315`）为 显式 config → env → 默认。二者**都是有意的**（库侧显式参数应压过环境变量），但没有任何文档说明，用户会困惑。

## 理想行为（变更点）

1. **redact 加固（`src/util/redact.ts`）**：
   - Bearer：`(Bearer\s+)\S+` → `$1[REDACTED]`（不再限制长度/字符集）。
   - 其它认证方案同理放宽：`(Basic|Digest|Token)\s+\S+` 亦掩码（任选，若实现请一并加测试）。
   - key=value：值部分由 `{4,}` 放宽为 `{1,}`（仍保留 `["']?` 前缀与分隔符匹配）。
   - 已知前缀（`sk-`/`tvly-`/`ghp_`…）：把 `{8,}` 放宽到 `{1,}`（保留前缀回显形式）。
   - **不得**破坏 `redactDeep` 的既有语义（键名后缀锚定 `SECRET_KEY_PATTERN`、token 计数值不被替换——见 :34/:40-43 与既有测试）。
2. **契约补全（`docs/interfaces.md`）**：
   - 新增「配置优先级总表」小节：一次性表格列出 CLI 路径与库路径各自的优先序，并明确说明为何不同（库侧显式参数优先于 env 是有意设计）；标注每个键属于哪一层（flag / env / `mik.config.json` / settings 表 / 内置默认）。
   - 新增「env 清单」：`MIK_DB`、`MIK_APP_ID`、`MIK_CONFIG`、`MIK_CACHE_DIR`、`MIK_OFFLINE`、`MIK_LANG`、`MIK_SERVER_TOKEN`（若存在）等，逐条写语义与作用范围。
   - 新增「`ModelInfraConfig` 字段清单」：字段、类型、默认值、是否进契约稳定面。
3. **测试锁定既有优先序**（不改变行为）：
   - CLI 侧：flag 覆盖 env、env 覆盖 `mik.config.json`（用 `openContext` 或既有 CLI 测试基建断言解析结果）。
   - 库侧：显式 `config.appId` 覆盖 `process.env.MIK_APP_ID`（`hub.ts:315` 行为）。
   - redact：新增用例覆盖短 Bearer（如 `Bearer abc`）、短 key=value（如 `token=x`）、含 `+/=` 的 key、Unicode 值；并保留/扩展现有 `redactDeep` 用例（token 计数不被替换、`apiKeyRef` 不被误杀）。

## 涉及模块

- `packages/mik/src/util/redact.ts`
- `packages/mik/test/`（redact 既有测试文件 + CLI/上下文优先序测试）
- `docs/interfaces.md`

## 不能破坏什么

- `redactDeep` 的键名锚定语义与「token 计数值不替换」；`apiKeyRef`（`env:FOO` 引用）不被误杀。
- 既有 363 个用例（尤其密钥相关断言：401/403 常量消息、`redact` 相关用例）。
- 优先级行为本身（本卡只加测试与文档，**不改** `context.ts`/`hub.ts` 的解析逻辑）。
- README 已校对内容（交叉 shell、密钥引用说明）。

## 验收标准

- A1：`redact("Authorization: Bearer abc")` 不含 `abc`；`redact("token=x")` 不含 `x`；`redact("api_key=ab+/=")` 不含原值。
- A2：既有 redact 用例全绿，且 `redactDeep` 对 `{ tokens: 12, prompt_tokens: 3 }` 不做替换、对 `{ apiKey: "sk-..." }` 做替换（回归确认）。
- A3：`docs/interfaces.md` 含三张新增内容（优先级总表 / env 清单 / `ModelInfraConfig` 字段清单），且每条与代码一致（给出对应代码行号引用）。
- A4：新增优先序测试用例通过（CLI：flag>env>file；库：config>env）。
- A5：`tsc --noEmit` 0 错误、`pnpm --filter model-infra-kit test` 全绿、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

redact 必须对非字符串输入、超长输入、深层嵌套（`redactDeep` depth>6 已有上限）保持不抛错；对不匹配的普通文本不得过度替换（例如不得把普通英文句子里的 "token" 后面的单词掩码——请用用例锁定「不误杀」边界：`"token counts are 12"` 之类）。

## 测试要求

- redact 新用例 ≥5 条（短 Bearer、短 key=value、特殊字符 key、Unicode、不误杀边界）。
- 优先序用例 ≥2 条（CLI 与库各一）。
- 契约文档可用 grep 型断言（interfaces.md 含「配置优先级」「MIK_CONFIG」等关键词）或不写测试、由 Evaluator 人工核验——如选择后者请在报告中明示。

## 范围外

G09（i18n 扩展/语言检测）、G10（协议运行时注册）、G11（DB 损坏恢复）、G14（成本对账与软预算）、G15-G19 技术债清理；任何优先级行为变更。