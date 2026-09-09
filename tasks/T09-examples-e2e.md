# T09 — 接入示例 + 端到端验收

**优先级**：P0（验收卡）
**依赖**：T05、T07
**拥有文件**：`examples/**`、`scripts/e2e/**`

## 目标

把 SPEC 第 6 节的六个验收点变成**可重复执行的脚本**，任何人 clone 后一条命令就能看到证据。

## 交付

1. `examples/cli-agent/`：模拟自研 CLI 宿主。`ModelInfra.init()` → 加供应商 → 测试连接 → 拉模型 → 设默认 → generate / stream / tool call 各跑一次 → 打印 `usage summary`。
2. `examples/openai-sdk/`：已有 `openai` SDK 代码，只把 `baseURL` 与 `fetch` 指向 mik，业务代码零改动，验证被计量。
3. `examples/python-host/`：Python 脚本打 `http://127.0.0.1:3211/v1/chat/completions`，验证跨语言接入被计量。
4. `scripts/e2e/run.mjs`：一条命令串起全部验收，输出**通过/失败清单**与关键数字（成本、token、记录条数）。

## 验收标准（脚本必须逐条断言）

1. 全新临时目录 + 临时 db，`init` 后无 provider 也能启动。
2. 添加一个 mock provider（内置本地 mock server，**禁止外网**）→ 测试连接 ok → 拉模型非空 → 设默认。
3. curl 等价请求打代理端点完成 generate / stream / tool call 各一次，三次都被计量。
4. openai-sdk 示例完成一次调用并被计量。
5. Python 示例完成一次调用并被计量（本机有 `D:\Technology_application\Anconda_All\Anaconda3\envs\claude\python.exe`；无网络依赖）。
6. 断网模拟（指向不可达 URL）后 `pricing` 状态降级为 `stale` 且仍能出价。
7. 手动改价后：历史记录成本不变，新请求用新价。
8. 退出码 0 表示全部通过；任一失败必须非 0 且打印失败项。

## 硬性约束

- 全部离线可跑（mock server 本地起）。
- 遵守 `AGENTS.md` 九条。
