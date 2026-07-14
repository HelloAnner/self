# Automation 领域

> 状态：Phase 10 已实现 Schema 11 持久化 Job 与 Phase 9 安全操作底座

## 目标

Automation 为 Agent 和人类提供一致、稳定、可审计的 CLI 操作协议，并安全编排跨领域工作流。

## 负责范围

- CLI 命令注册、帮助和机器可读 Schema
- JSON/JSONL envelope、错误码和退出码
- stdin/stdout、批量请求和流式事件
- 幂等键、对象版本和并发冲突
- Plan/Apply 两阶段修改协议
- 长任务 Job、checkpoint、取消和重试
- Operation、Undo Plan 和审计历史
- 跨领域应用服务和事务编排

## 核心对象

- `CommandRequest`：规范化命令请求
- `Plan`：带前置条件和影响范围的修改计划
- `Operation`：一次已提交业务操作
- `Job`：可恢复的长任务
- `AuditEvent`：可追踪的操作事件
- `IdempotencyRecord`：Agent 重试去重记录
- `OperationChange`：一次 Operation 内每个对象的 before/after、版本和逐项状态

## 关键不变量

- Agent 不得获得绕过领域规则的任意 SQL 写入口。
- 高风险操作没有有效 Plan 就不能执行。
- Plan 生成后目标版本变化必须导致冲突。
- 相同幂等键和相同参数只产生一次业务效果。
- JSON 协议在同一主版本内保持向后兼容。
- Model Route 变更及 VectorSpace create/activate/migrate/delete 必须通过 Plan/Apply；VectorSpace/Graph/Topic 的长任务使用 Schema 11 Job 保存 checkpoint、进度、attempt 和 lease，compare/verify 保持只读校验或显式状态推进。
- `embedding_requires_vector_space` 和 `vector_space_not_found` 是 Agent 可分支处理的稳定错误码，不得只输出自然语言提示。
- `self --init` 交互答案和 `setup plan --spec` 必须生成相同规范 CommandRequest/Plan；Prompt Presenter 不得绕过 Application Workflow。
- Plan 核心内容和 Target、OperationChange、AuditEvent 在 SQLite 中不可变；Plan Manifest 同时保存在 `runtime/plans/`，SQLite 是权威状态。
- Apply 默认声明 `atomic`；返回每个受影响对象的 `succeeded|failed|skipped`。当前 Phase 9 高风险命令全部采用单事务 atomic，不伪装成已实现的部分成功批处理。
- Restore 和 Undo 从已提交 OperationChange 反向生成新版本，不回写旧版本，也不删除原 Operation/AuditEvent。

## 不负责

- 每个领域内部的不变量实现
- 数据库备份与迁移算法
- HTML 页面业务内容

## Phase 9～10 已实现边界

- `plan list|show|diff|cancel`、`operation list|show|undo --plan`、`history list|show|diff`。
- Source/Note/Connection/Entity/Relation/Claim/Topic/Artifact 的版本化 Plan、软删除、恢复和依赖传播。
- 全局 `--idempotency-key` 去重与冲突检测；对象写入的 `--if-version` 乐观并发控制。
- Source purge 只在 Connection、Note、Document、Ingestion、EvidenceContext、Topic Citation 和 Graph 引用均为零时执行，且保留 Hash-only PurgeReceipt。
- Note move 的 Undo 同时补偿 Root 内文件路径和 SQLite；任何一侧失败都会回滚另一侧。
- `job list|show|logs|watch|cancel|retry` 提供 Agent 稳定协议；Job/Event 在 SQLite 中持久化，Event 内容先脱敏再写入且不可修改。
- 长任务可用 `--wait` 同步等待，或默认/`--detach` 返回 Job；worker 通过 lease 和 PID 判断中断，失败/取消 Job 只有显式 Retry 才开始新 attempt。
- Backup、Deep Verify、Graph Build/Rebuild、VectorSpace Build 和 Topic Build/Refresh 已接入通用 Job。恢复同一个 Job 使用 checkpoint，不创建第二份业务效果。
- Backpressure 当前由单 Root 维护锁和 per-kind 串行资源边界实现；还没有跨 Root 的中央队列，也不应引入。

## 详细文档

- [`commands.md`](./commands.md)：CommandSpec、Phase 0 `version` 命令、JSON envelope 和输出规则。
- [`../../contracts/identity-events-errors.md`](../../contracts/identity-events-errors.md)：跨领域稳定 ID、事件和错误/退出码基线。
