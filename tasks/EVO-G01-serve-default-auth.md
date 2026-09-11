# EVO-G01 — `mik serve` 默认安全：无 token 拒绝写端点 + 出站防护 + 计量防伪造

> 来源：Product Evolution Orchestrator 第 1 轮 vertical slice（G01，P0）。
> 四视角审计见 `.tmp/audit-reliability.md`（P0-1）。证据已由 Orchestrator 独立核验（server.ts:129/173、api.ts:195/237/277、http.ts readJsonBody）。

## 目标

让 `mik serve` **安全默认（safe by default）**：未配置 token 时写端点一律拒绝；出站端点（refresh/sync/test）禁止非 http(s) 与链路本地/云元数据地址；usage 上报禁止伪造他人 appId；JSON 体只接受 application/json（封死 no-cors 浏览器简单请求通道）。

## 用户场景

开发者本地跑 `mik serve`（不配 token）；本机被攻陷进程或恶意网页不得：① 增删改 provider/定价；② 让服务器携带宿主的真实 API 密钥向攻击者 URL 发请求（test/refresh 出站）；③ 往账单注入伪计量。配了 token 的部署保持原有鉴权行为不变。

## 当前问题（已核验）

- `server.ts:129` token 缺省归一 undefined；`:173` `if (token && …)` 使鉴权门整体跳过 → 全部写端点裸奔（api.ts:237/246/257/265/277/304/339/383）。
- `api.ts:277` refresh → 对 provider.baseUrl 出站（SSRF 原语）；`api.ts:265` test 同理；`api.ts:339` pricing/sync 任意出站。
- `api.ts:195` usage/events 的 `body.appId` 可覆盖 hub.appId → 计量伪造。
- `http.ts readJsonBody` 不校验 Content-Type → `text/plain` 的合法 JSON 也接受（浏览器 no-cors 简单请求可达）。

## 理想行为（变更点）

1. **默认拒绝写**：无 token 时，所有非公共写端点（POST/PATCH/PUT/DELETE，除 /api/health 外）一律 401，消息给出指引（如何设置 --token / MIK_SERVER_TOKEN）。GET 读端点保持公开。有 token 时保持现有行为（safeEqual 恒时比较、Bearer 严格解析都别动）。
2. **出站防护**：`refresh`（models）、`pricing/sync`、`provider test` 出站前校验 baseUrl：仅 `http`/`https`，且 host **不是**链路本地/云元数据（169.254.0.0/16、fe80::/10、0.0.0.0、`[::]`）；**允许 loopback**（127.0.0.1/8、::1——本地 mock/开发合法）。违规 → 400 INVALID_REQUEST（报文 redact 后提示）。
3. **计量防伪造**：`POST /api/usage/events` 的 `body.appId` 只允许等于 `hub.appId`（缺省取 hub.appId），否则 400。
4. **Content-Type 门**：`readJsonBody` 仅接受 `application/json`（含 `+json`/charset），否则 415。
5. **CLI/文档**：serve 启动时若无 token 且 TTY，打印一行「写端点已禁用，设置 --token 或 MIK_SERVER_TOKEN 启用」；README serve 一节与 docs/interfaces.md 端点表补「默认拒绝写」说明。

## 涉及模块

- `packages/mik/src/server/server.ts`（鉴权门默认拒绝写）
- `packages/mik/src/server/api.ts`（usage/events appId 校验、出站 guard）
- `packages/mik/src/server/http.ts`（readJsonBody Content-Type）
- `packages/mik/src/server/openai.ts`（若 refresh/test 出站点在桥接层则改 `src/ai/bridge.ts`；以实际调用链为准）
- `packages/mik/src/cli/commands/serve.ts`（启动提示）
- 测试：`packages/mik/test/server.test.ts`（新增用例 + 修正既有无 token 写用例）
- `scripts/e2e/run.mjs`（serve 调用补 token，若其 F19/写路径依赖无 token 写）
- 文档：README.md serve 节、docs/interfaces.md 端点表

## 不能破坏什么

- token 存在时的全部既有鉴权行为（safeEqual、www-authenticate、Bearer 解析）。
- /api/health 永远公开；GET 读端点无 token 可用（看板依赖）。
- 本地 mock（baseUrl=http://127.0.0.1:3212/v1）的 refresh/test 必须继续可用（loopback 放行）。
- 流式 /v1/chat/completions、计量、CORS 选项行为。
- 方法：改完跑 `pnpm --filter model-infra-kit typecheck` + `tsc --noEmit` 0 错误、全量 vitest、`node scripts/e2e/run.mjs`、`node scripts/check-envs.mjs`（三环境），贴命令与输出。

## 验收标准

- A1 无 token：`POST /api/providers` → 401 + 指引文案；`GET /api/health` → 200；`GET /api/providers` → 200。
- A2 有 token：正确 Bearer 写请求 → 成功；错 token → 401（保持现有）。
- A3 `POST /api/usage/events` body.appId ≠ hub.appId → 400；缺省 → 成功。
- A4 provider baseUrl 为 `http://169.254.169.254/` → refresh/test/sync 拒绝 400；`http://127.0.0.1:3212/v1` → 允许；`file:///etc/passwd` → 拒绝。
- A5 content-type `text/plain` + 合法 JSON → 415；`application/json` → 成功。
- 全量测试/typecheck/e2e/check-envs 全绿。

## 错误场景

401 无 token 写、401 错 token、400 伪造 appId、400 非法 baseUrl、415 非 JSON 内容类型——全部为稳定 code + redact 后消息，不泄露配置与密钥。

## 测试要求

- server.test.ts 新增：上述 A1-A5 各 1+ 用例；把既有「无 token 直接 POST 写端点」的用例改为带 token 的 helper（或显式断言新 401 行为）。
- 断言 e2e 不残留「无 token 写」路径。
- 不要改与本次无关的行为；任何既有用例失败必须解释是「预期翻转」还是回归。

## 范围外（明确不做）

G02-G07（孤儿进程、双 readline、循环依赖、i18n 契约、文档校对、REPL 提示符键）、自动生成 token 的 UX 发明、任何新功能。