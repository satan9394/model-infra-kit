# T10 — README 与发布准备

**优先级**：P2（最后做）
**依赖**：T05、T06、T07、T08、T09
**拥有文件**：`README.md`、`packages/mik/README.md`、`docs/decisions.md`

## 交付

1. 根 `README.md`：项目一句话定位 + 三种接入方式的 **5 分钟上手**（每段可复制粘贴且真实可跑）。
2. `packages/mik/README.md`：API 速查（`ModelInfra.init` / `generate` / `stream` / `fetch` / `usage` / `providers` / `models` / `pricing`），含 `ModelRequest`/`ModelResponse`/`StreamEvent` 字段表。
3. `docs/decisions.md`：记录关键取舍（为什么用 AI SDK 而非自研协议层；为什么用 llm-pricing 而非自研归一化；为什么金额用微美元；为什么 `node:sqlite`；为什么不做 CC Switch 抽取）。
4. 常见问题：`node:sqlite` 实验性告警如何消除、如何换 `better-sqlite3`、如何多 app 共库。

## 验收标准

1. README 里的每条命令都能在本机复现（自己跑一遍并贴证据）。
2. 不出现任何真实密钥。
3. `pnpm --filter model-infra-kit build` 产出 `dist/index.mjs`、`dist/server.mjs`、`dist/cli.mjs` 与对应 `.d.mts`。
4. `node dist/cli.mjs --help` 可用。
