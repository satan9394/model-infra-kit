# 贡献指南 / Contributing

感谢你愿意为 `model-infra-kit` 出力。本文件说明本仓库的**实际**开发方式；与代码冲突时以代码为准，
发现文档过时请直接提 PR。

## 这是什么项目

`model-infra-kit` 是一个可嵌入任意 AI 项目的**模型层**：装进宿主项目后立刻获得多供应商调用、
模型目录、token 用量、模型计价与成本统计，外加一个独立看板。

它**不是**网关平台、不是企业级 AI Gateway，也**不读**任何第三方应用的数据文件。

## 环境要求

| 工具 | 版本 |
|---|---|
| Node | ≥ 22.13（CI 用 22，本机实测 24/26） |
| pnpm | 11（版本由 `package.json#packageManager` 固定） |
| Python | 3.12（仅 `apps/dashboard/scripts/verify-viewports.py` 需要） |

```bash
pnpm install --frozen-lockfile
```

## 常用命令

```bash
pnpm --filter model-infra-kit typecheck   # 必须 0 错误
pnpm --filter model-infra-kit test        # 必须全绿
pnpm --filter model-infra-kit build       # tsdown 打包

pnpm --filter @mik/dashboard test         # 看板单测
pnpm --filter @mik/dashboard build        # 看板构建（端口 3210）
```

`--filter` 的目标名来自各包 `package.json` 的 `name`（`model-infra-kit` / `@mik/dashboard`），
不要用目录名 `packages/mik`、`apps/dashboard` 去猜。

### locale 相关改动

仓库里有一批文案断言。**只设 `LC_ALL` / `LANG`，不要设 `MIK_LANG`**：

```bash
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 pnpm --filter model-infra-kit test
```

`MIK_LANG` 会被当成用户显式指定，反过来让「跟随 OS locale」的那几条用例假红。
本机是 zh-CN，只看本地绿会掩盖英文侧缺陷。

### 平台相关改动

涉及路径分隔符、换行符、信号、分块读取、外部命令的改动，**本地绿不算数**，
必须以 CI（ubuntu / macOS / windows 三平台）结果为准。

## 目录结构

```
packages/mik/       主包（唯一对外发布的包）
  src/registry/     供应商注册表与预设
  src/credential/   凭据引用解析
  src/ai/           AI SDK 桥接
  src/pricing/      llm-pricing 封装
  src/usage/        计量与查询
  src/store/        SQLite 仓储与迁移
  src/server/       子路径导出 mik/server
  src/cli/          子路径导出 mik/cli
apps/dashboard/     Next.js 看板
examples/           接入示例
docs/               契约与决策（SPEC.md / interfaces.md / decisions.md）
```

## 硬性规则（违反即打回）

1. **不读第三方应用的数据**。不扫描 `~/.codex`、`~/.claude`、`~/.local/share/opencode` 等目录。
   用量数据必须由本模块自己产生。
2. **金额一律整数微美元累加**。禁止 `SUM(CAST(cost AS REAL))` 这类浮点求和；
   SQL 聚合用 `CAST(ROUND(x * 1000000) AS INTEGER)`。
3. **协议是一等公民**。适配器按 `protocol` 数据映射选择，禁止 `providerId === "deepseek"` 这类分支；
   供应商差异只能进 `provider.meta`。
4. **密钥永不落库、永不进日志**。provider 只存 `api_key_ref`；日志与响应统一走 `src/util/redact.ts`。
5. **不改公共接口而不改契约**。`docs/interfaces.md` 是跨模块接口契约，变更需同步更新。
6. **不阻塞启动**。目录/价格上游拉取失败只降级 + 告警，不能让 `ModelInfra.init()` 抛错。

## 提交规范

- 一个提交只做一件事；提交信息用 Conventional Commits：
  `feat(scope): ...` / `fix(scope): ...` / `docs: ...` / `chore(deps): ...` / `test(scope): ...`。
- 提交前跑一遍本包相关的 typecheck + test；**改 `package.json` 版本号后必须重跑全量测试**
  （部分测试冻结了版本号）。
- 只 `git add` 你自己改的文件，不要 `git add -A`。
- 不要提交密钥、`.env`、本地数据库（`*.db`）或个人缓存目录。

## 发布闸门

只有当**已发布包 `packages/mik` 的行为或公共接口发生变化**时才升版。

流程：升 patch/minor → 重跑全量 → `npm publish` → `gh release create` → CI 三 OS 绿 →
在**全新目录**里 `npm i model-infra-kit@<版本>` 做一次真实冒烟。

只改看板、文档、测试、示例的 PR **不升版**。

## 报告问题

- Bug / 功能建议：用 [Issue 模板](https://github.com/satan9394/model-infra-kit/issues/new/choose)。
- 安全漏洞：**不要**开公开 Issue，按 [SECURITY.md](SECURITY.md) 私下上报。
- 参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
