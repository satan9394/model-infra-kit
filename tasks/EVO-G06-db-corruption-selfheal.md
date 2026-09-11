# EVO-G06 — SQLite 损坏自愈（G11）

> 来源：Product Evolution Orchestrator 第 6 轮 vertical slice（LATER 集群，数据耐久性）。
> 依据：`.tmp/audit-reliability.md` P2-2 / P3-3（`Store.open` 无完整性检查；坏库仅抛 `STORAGE`，唯一出路是人工删库）。

## 目标

账本（SQLite）文件损坏时，**启动不失败、数据不静默丢失**：把损坏文件隔离留存（不删除），自动以空库继续启动，并**大声告警**指引人工恢复。健康库与既有一切行为零变化。

## 用户场景

开发者的机器异常断电/磁盘坏页导致 `usage.db` 损坏。此前：任何 `mik` 命令与宿主启动都直接报 `STORAGE` 错误，用户只能自己删库（**账本永久丢失**）。此后：启动仍成功（空账本），损坏文件被移到隔离目录并在告警里给出路径，用户可事后用 SQLite 工具抢救数据。

## 当前问题（已核验）

- `packages/mik/src/store/database.ts` 打开流程：建目录 → `assertWritableFile` → 打开驱动 → `assertWritableDatabase`（探针写+ROLLBACK）→ `migrate`；**全程无完整性检查**，失败仅 `throw storageError(...)`。
- `packages/mik/src/store/schema.ts` 的迁移本身是安全的（每批迁移有事务 BEGIN/COMMIT/ROLLBACK + `INSERT OR IGNORE` 防并发竞争）——缺陷在**迁移之前的既有损坏态**。
- 仓库已有隔离惯例可复用：F04 把凭据删除改为移入 `~/.model-infra-kit/trash/`（见 `packages/mik/src/credential/store.ts`）。

## 理想行为（变更点）

1. **打开时的完整性探测**（仅针对**文件型**库，`:memory:` 跳过）：
   - 在既有 `assertWritableDatabase` 探针之后、`migrate` 之前，执行 `PRAGMA quick_check`（比 `integrity_check` 快，够用于"是否可用"判断）。
   - **只在明确的损坏签名上判定为损坏**：`quick_check` 返回非 `ok` 行，或驱动错误信息匹配损坏特征（如 `SQLITE_CORRUPT`、`database disk image is malformed`、`file is not a database`）。**权限/锁/路径类错误不得**被误判为损坏。
2. **隔离（不删除）**：判定损坏时，把主库文件及其同级 `-wal`/`-shm` 兄弟文件**移动**到 `~/.model-infra-kit/trash/db-corrupt-<UTC 时间戳>/`（复用 F04 的 trash 根目录与命名风格）；隔离失败则仍抛 `STORAGE`（**绝不删除原文件**）。
3. **重建并继续启动**：隔离成功后以同一路径创建**空库**（走正常 `migrate` 建表），并发出**醒目告警**（走既有 `onWarn` 通道，redact 后输出），内容含：损坏文件被隔离到的**完整路径**、账本已重置为空的说明、以及"可用 SQLite 工具从隔离文件抢救数据"的指引。
4. **不阻塞启动原则**（项目规则 6）：`quick_check` 必须是有界成本——若库大于某阈值（建议 64 MiB，常量并写注释）则**跳过** quick_check 仅依赖探针结果，避免大库拖慢启动；跳过时不做损坏判定（宁可漏判也不阻塞）。
5. 库大小阈值与探测结论应可通过既有 `onWarn` 观察，便于排障。

## 涉及模块

- `packages/mik/src/store/database.ts`（探测 + 隔离 + 重建编排）
- `packages/mik/src/store/trash.ts`（若 F04 的隔离工具可复用则复用；不可复用则在此新增最小 `quarantineFile`/`quarantineDbSiblings` 工具，与 credential 侧保持同一 trash 根）
- `packages/mik/test/`（store 既有测试文件 + 新增损坏场景用例）
- 可选：`docs/interfaces.md` 若新增公共行为约定（如 trash 路径规则）则补一小节

## 不能破坏什么

- 健康库：**不得**产生隔离目录、**不得**产生告警、数据与 WAL/busy_timeout/外键设置零变化。
- 既有错误语义：权限/锁/路径错误仍抛 `STORAGE`（带原指引），不触发隔离。
- `:memory:` 库路径完全跳过新逻辑。
- 迁移行为（事务 + `INSERT OR IGNORE`）与并发冷启动语义不变。
- 既有 store/migration/CLI/hub 测试全绿。

## 验收标准

- A1 **损坏自愈**：构造损坏库（复制健康库后覆盖文件头若干字节，或用 `file is not a database` 等价手段）→ 打开成功；新库为空且已建表；原文件出现在隔离目录中（**内容不变、未被删除**）；发出一次醒目告警且含隔离路径。
- A2 **健康库零打扰**：正常打开 → 无隔离目录创建、无告警、`usage_events` 既有行数不变。
- A3 **不误判**：不可写目录 / 只读文件 / 锁冲突场景 → 仍抛 `STORAGE`，**不**创建隔离目录（不得把权限问题当成损坏）。
- A4 **隔离失败兜底**：隔离移动失败（如目标不可写）→ 抛 `STORAGE` 且**原文件仍在原地**（绝不删除数据）。
- A5 **大库跳过**：超过阈值的库跳过 quick_check（可用伪造 size 或注入阈值参数测试），启动不失败。
- A6 全量：`tsc --noEmit` 0 错误、`pnpm --filter model-infra-kit test` 全绿、`node scripts/e2e/run.mjs` exit 0、`node scripts/check-envs.mjs` 三环境 PASS。

## 错误场景

- 损坏 + 隔离目录不可写 → `STORAGE`，原文件保留。
- `-wal`/`-shm` 存在但主库健康 → 不动任何文件。
- `-wal` 损坏而主库健康（quick_check 通过）→ 不隔离（保守：宁可让 SQLite 自行忽略 WAL，也不误伤主库）。
- quick_check 抛错但签名不明确 → 视为**非损坏**，按原错误抛出（保守优先）。

## 测试要求

- ≥4 个新用例：损坏自愈（A1）、健康零打扰（A2）、不误判（A3）、隔离失败兜底（A4）；大库跳过（A5）可用注入阈值实现。
- 测试必须**真实验证隔离文件内容**（如比对字节数/可读性），不得只断言目录存在。
- 清理测试临时目录时遵守仓库规则（回收站/临时目录），不得 `rm -rf` 用户数据目录。

## 范围外

G09（i18n 扩展）、G10（协议运行时注册）、G14（成本对账与软预算）、任何自动数据修复/备份调度、任何优先级或金额口径变更。