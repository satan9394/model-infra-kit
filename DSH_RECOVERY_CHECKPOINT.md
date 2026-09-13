# DSH Recovery Checkpoint

> 由 DSH Emergency Brake 协议生成（收到 `DSH_EMERGENCY_BRAKE.md` 后立即止损）。
> 生成时刻：`main` @ `ca37bf8`。此后**未再执行任何产品工作**。

## 1. 原始目标

以「Product Evolution Orchestrator」身份长期迭代 `model-infra-kit`（可嵌入 AI 项目的模型层）：审计 → GAP_MAP → 每轮一个 vertical slice → 独立实现 → 独立验收 → 更新产品状态。

## 2. 已完成

- 交付并发布 **40 个版本**：`0.1.7` → **`0.3.0`**（npm `model-infra-kit` 与 GitHub Release 同步）。
- **34 个已验收切片**（G01–G89 + G64 + G72b），每个都有独立 Evaluator 验收；`0.2.30` 与 `0.3.0` 的 CI 三 OS 全绿。
- 五条能力线成形：成本可信（G73/74/77/78/85/89）、按业务切分（G75）、不误导（G64/G82/G84/G86）、跨平台可用（G76/G72b）、双语与文档一致（G12–G71）。
- 最后两版：**G88**（`init` 不再静默丢弃 `cacheDir`；`trends --to` 下沿可见；看板金额口径与 CLI 统一）、**G89**（弃用 `costUsd` 点估计，字段保留仍填充、内部改由 `costLowUsd`/`costHighUsd` 两端表达）。
- 记忆与规则沉淀：`AGENTS.md`（硬性规则 + **70 余条复盘教训** + 明确标注的 BACKLOG）、`docs/product-evolution.md`（权威状态）、`tasks/EVO-G8x-*.md`（任务卡）。

## 3. 当前代码/文件状态

- **无未提交修改**：`git status --short` 空，`git diff --stat` 空。
- HEAD：`ca37bf8 docs: unmerge the backlog item from the closing-ritual line`。
- 关键模块：`packages/mik/src/{cli,usage,store,server,pricing,ai}`、`apps/dashboard`（包名 **`@mik/dashboard`**）、`scripts/{e2e,check-envs}`、`docs/interfaces.md`（契约）。
- 基线：测试 **694 例 / 38 文件**；字典 **326/326**；`tsc --noEmit` 0。
- 唯一新增未跟踪文件：**本恢复文件自身**（未提交，供人工审阅）。
- 备份/临时物：`~/.dsh/profiles/web/cordis.patch.yml.bak-before-toolweb-override-20260912-092637`（web_search 关闭前的备份）。

## 4. 已知未完成

1. `apps/dashboard/scripts/seed.mjs:306` 仍用 `summary.costUsd.toFixed(4)`（开发脚本）。
2. 空串 `MIK_CACHE_DIR` / `--cache-dir ""` 仍会静默删掉文件中既有的 `cacheDir` 键。
3. 重跑 `init` 会丢弃配置里其它手写键。
4. `--to X --days 7` 组合缺显式断言。
5. 看板区间用例是表达式副本（不 import 组件），生产回归不会变红。

（以上即 `AGENTS.md` 中 **BACKLOG（非必做）** 的①③④⑤⑥项；②⑦⑧⑨项同表。）

## 5. 当前风险

1. **未验证的空白**：`0.3.0` 的 G36 只验到「CLI 可跑 / 类型里 `@deprecated` 在 / `costUsd` 仍在」；金额 6 位精度与区间显示**未在产物上做页面级取证**（评审已申报）。
2. **`0.3.0` 是 minor 但有用户可见变化**：`costUsd` 被弃用（字段仍在）；金额在有余数时由 4 位变 6 位；次微金额由 `0.0000` 变非零。按字符串解析金额列的宿主脚本需改为数值解析。
3. 本会话 token 消耗极大（40 版 + 百余子 Agent），**本次止损即为此**。
4. 上一轮环境问题仍在：网络搜索后端已按用户要求关闭（`tool-web` 的 `search: false`），外部信息只能 `web_fetch`。
5. CI 对纯文档提交显示 `cancelled`（被后续推送取代），非失败但**不等于已验证**。

## 6. 后台任务处理

- 已中断的 Subagent：**0 个**（`list_agents(descendants)` 全部为 `ready`＝仅存储、非运行）。
- 已终止的 Job：**0 个**（`job_list` 返回空）。
- 无法确认的后台任务：**无**（控制面已确认）。

## 7. 推荐下一步

1. **人工先读本文件 + `AGENTS.md` 的 BACKLOG 段**，决定是否有任何一项值得做（我判断①可略过，②与④价值相对最高）。
2. 若要发版：遵循 `AGENTS.md` 的收尾铁律（双 locale 全量 → 独立验收 → 逐文件点名提交 → 升版 → 重跑全量 → 发布 → **用 `gh release view` 复核** → G36）。
3. 若对 `0.3.0` 的金额格式有疑虑：优先补**页面级**断言（`data-testid` + 渲染测试），而非再加单测。

## 8. 恢复方式

下一次新会话开始时：

1. 先阅读本文件。
2. 再读必要的项目入口文件（`AGENTS.md` → `docs/product-evolution.md` → 相关 `tasks/*.md`）。
3. 只选择一个明确任务继续。
4. **不自动恢复此前的全面审计/自动迭代循环。**
