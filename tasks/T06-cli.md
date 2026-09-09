# T06 — CLI（`mik` 命令）

**优先级**：P1
**依赖**：T05
**契约**：`docs/interfaces.md` → T06 段
**拥有文件**：`src/cli/**`、`test/cli.test.ts`

## 目标

`npx model-infra-kit` / `mik <命令>` 让宿主项目 5 分钟上手。

## 子命令（V0.1 必须全有）

```
mik init                     交互式写配置（appId / db 路径 / 首个供应商）
mik serve [--port 3211]      起 HTTP 服务（调用 T07）
mik dashboard [--port 3210]  起看板（调用 apps/dashboard）
mik provider list
mik provider add <id> [--preset <presetId>] [--base-url <url>] [--api-key-ref <ref>]
mik provider remove <id>
mik provider test <id>
mik models [--provider <id>] [--refresh]
mik pricing list
mik pricing sync
mik pricing set <modelId> --input <usd/M> [--output] [--cache-read] [--cache-write]
mik usage summary [--from <date>] [--to <date>] [--app <appId>]
mik usage trends [--days 30]
mik usage logs [--limit 20]
mik usage export --format csv [--out <path>]
```

## 验收标准

1. 所有子命令可执行，`mik --help` 与 `mik <cmd> --help` 有输出。
2. 输出是**人类可读的表格/清单**，金额固定 4 位小数，token 带千分位。
3. `provider add` 支持 preset 补全；未给 `--api-key-ref` 时给出明确提示（不静默用明文）。
4. `usage export` 产出合法 CSV，表头固定，含 `ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms`。
5. 任何命令都不得把密钥写进 stdout。
6. `mik serve` / `mik dashboard` 起服务前用 `netstat -ano | findstr :<port>` 检查端口，被占用时报错退出（不要硬抢）。
7. 单测：至少覆盖参数解析、CSV 导出、`provider add` 的 preset 补全。用临时 db（`:memory:` 或 temp 文件）。
8. `pnpm typecheck` 0 错误，`pnpm test` 全绿。

## 硬性约束

- 不引入重量级 CLI 框架；用 Node 内置 `parseArgs` 或极简手写解析。
- 遵守 `AGENTS.md` 九条（尤其：端口约定、密钥脱敏）。
