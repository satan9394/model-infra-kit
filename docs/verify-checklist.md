# 验证清单（指挥用）

每张卡交证后，指挥**独立复跑**，不采信 Worker 的自述。

## 通用（每卡必查）

- [ ] `cd packages/mik && pnpm exec tsc --noEmit` → 0 错误
- [ ] `cd packages/mik && pnpm exec vitest run` → 全绿，且**测试总数不低于上一卡**
- [ ] Worker 只改了卡里声明的文件（`git status` 或文件时间比对）
- [ ] 没有新增对 `_research/` 的依赖，没有读 `~/.codex`、`~/.claude`、`~/.local/share/opencode`
- [ ] 没有把密钥写进代码、测试、日志、fixture
- [ ] 金额聚合仍是整数微美元（grep `SUM(CAST` / `* 1000000`）
- [ ] 没有 `if (providerId ===` 之类协议分支（grep）
- [ ] 上游失败路径不抛错（人工审阅 `init()` / `test()` / `discoverModels()`）

## 按卡专项

| 卡 | 专项验证 |
|---|---|
| T02 | 预设数量与字段完整；mock server 覆盖 401/500/超时；`languageModel()` 真能产出模型对象 |
| T03 | 映射逐字段核对；override 优先级；未定价返回 missing；断网降级不抛错 |
| T04 | 幂等；appId 隔离；onEvent 只触发一次 |
| T05 | generate/stream/fetch 三条路径都落库；失败也落库；模型解析三种情况 |
| T06 | 每个子命令能跑；CSV 表头固定；端口占用时退出 |
| T07 | 流式与非流式；401；SSE 收到事件；openapi.json 可解析；只监听 127.0.0.1 |
| T08 | 3210 起得来；空数据不崩；SSE 自动刷新；生产构建通过 |
| T09 | `node scripts/e2e/run.mjs` 退出码 0；逐条验收点有断言 |

## 对抗性评审（大改动才派）

派一个**全新上下文**的评审 Worker，只给它：diff + 验收标准 + `AGENTS.md`。
要求它反向挑错：找漏测、找绕过规则的地方、找会让宿主踩坑的 API 设计。
评审结论写进 `docs/reviews/<卡号>.md`。
