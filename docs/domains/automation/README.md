# Automation 领域

> 状态：待详细设计

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

## 关键不变量

- Agent 不得获得绕过领域规则的任意 SQL 写入口。
- 高风险操作没有有效 Plan 就不能执行。
- Plan 生成后目标版本变化必须导致冲突。
- 相同幂等键和相同参数只产生一次业务效果。
- JSON 协议在同一主版本内保持向后兼容。
- Model Route 变更及 VectorSpace create/activate/migrate/delete 必须通过 Plan/Apply；build/compare/verify 使用可恢复 Job 或只读操作。
- `embedding_requires_vector_space` 和 `vector_space_not_found` 是 Agent 可分支处理的稳定错误码，不得只输出自然语言提示。

## 不负责

- 每个领域内部的不变量实现
- 数据库备份与迁移算法
- HTML 页面业务内容
