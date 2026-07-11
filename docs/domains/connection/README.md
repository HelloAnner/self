# Connection 领域：动态数据连接与变化感知

> 状态：详细设计草案
> 领域名称：Connection
> 核心职责：持续监控外部文件或目录，可靠发现变化，并驱动 Source 归档与后续知识摄入

## 1. 为什么需要独立领域

Self 需要长期连接用户分散在不同项目、目录和文件中的知识。例如：

- 多个项目中的 `docs/`
- 不同 Git 仓库中的 `README.md` 和设计文档
- 单独维护的一份 Markdown
- 外部 Obsidian Vault
- 定期更新的导出目录

这些资料会在 Self 之外不断变化。Self 不能依赖用户每次手工执行 `source sync`，而应通过后台进程自动感知、扫描、归档和触发增量摄入。

Connection 必须与 Source 分开：

- **Connection** 决定监控什么、如何发现变化、连接是否健康。
- **Source** 决定如何为变化内容保存内部证据 Snapshot。
- **Ingestion** 决定如何解析、切片并发布到 Knowledge。

```text
外部文件 / 目录 / 项目
           │
           ▼
      Connection
  监听 + 对账 + 变化批次
           │
           ▼
        Source
   内部 Snapshot 与 Blob
           │
           ▼
       Ingestion
  解析、切片和增量发布
           │
           ▼
 Knowledge / Graph / Topic
```

## 2. 负责范围

Connection 负责：

- 持久保存需要持续监控的文件、目录和项目位置
- 维护 include/exclude、递归、符号链接和文件类型规则
- 接收操作系统文件事件
- 按计划执行定期扫描
- 使用文件清单和内容哈希做权威对账
- 识别新增、修改、删除、重命名和恢复
- 防抖、等待文件写入稳定和批量合并
- 将可靠 ChangeBatch 提交给 Source
- 记录 Connection、Scan、Change 和后台进程健康状态
- 提供实时查看、历史变化、暂停、恢复和手工扫描
- 在路径失效、磁盘卸载、权限变化时进入 degraded，而不是误判为全量删除

## 3. 不负责

Connection 不负责：

- 长期保存原始 Blob 和 Snapshot
- 解析 Markdown、PDF 或代码
- 生成 Chunk 和 Embedding
- 抽取 Entity、Relation 和 Claim
- 决定 Topic 如何刷新
- 直接修改 Knowledge 或 Graph 表
- 执行用户来源中的代码或脚本

## 4. 领域文档

- [领域模型](./model.md)
- [SQLite Schema](./schema.md)
- [扫描、监听和后台进程工作流](./workflows.md)
- [CLI 命令](./commands.md)
- [测试设计](./testing.md)

## 5. 核心边界

### 5.1 外部连接不破坏单目录原则

Connection 可以保存一个外部绝对路径，因为它描述的是被监控的外部世界；但任何被 Self 接纳的内容都必须先复制为 Self Root 内部的 Source Snapshot。

Self 实例整体移动后：

- 已归档资料、数据库和历史 Artifact 仍然完整可用。
- 外部 Target 可能进入 `unavailable`，对应 Connection 进入 `degraded`。
- 用户可以使用 `connection rebind` 指向新机器上的对应路径。
- Rebind 必须校验目标指纹，避免错误地把另一个目录当成原连接。

### 5.2 文件事件不是事实来源

`fs.watch`、FSEvents、inotify 和 Windows watcher 都可能：

- 丢事件
- 合并事件
- 重复发送
- 只给目录名不给完整语义
- 在编辑器原子保存时产生临时文件和 rename

因此原生 watcher 只负责“提示某处可能变化”，定期扫描和清单对账才是权威事实。

### 5.3 Connection 不直接归档

Connection 产生 ChangeBatch 后，通过 Application Workflow 请求 Source 接纳变化。只有 Source 完成内部 Snapshot，ChangeItem 才能进入 `archived`，随后才由 Ingestion 处理。

## 6. 默认策略

针对项目文档，建议默认：

```text
mode                 = watch-and-reconcile
recursive            = true
follow_symlinks      = false
event_debounce        = 750ms
write_settle_window   = 1500ms
reconcile_interval    = 5m
full_hash_interval    = 24h
delete_grace_period   = 30s
max_batch_size        = 500
```

默认 include：

- `**/*.md`
- `**/*.mdx`
- `**/*.txt`
- `**/*.pdf`
- `**/README*`
- `docs/**`

默认 exclude：

- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- `.next/**`
- `coverage/**`
- `.test-runs/**`
- `.DS_Store`
- `*.tmp`
- `*.swp`
- `.env*`
- 常见密钥、证书和凭证文件

用户可以覆盖规则，但敏感文件的摄入需要显式确认。

## 7. 关键不变量

1. v1 中一个 active Connection 必须且只能有一个 active Target。
2. Target 的外部路径必须经过 canonicalize 和权限验证。
3. Connection 不能监控整个 Self Root 或 `data/`、`artifacts/`、`runtime/`、`backups/` 等系统生成目录；允许以 `managed_content` 范围监控 `content/notes/` 和 `content/inbox/`。
4. 原生文件事件不能直接创建 Source Snapshot，必须经过稳定性检查和对账。
5. Connection Root 暂时不可用时，不能把全部已知文件标记为删除。
6. Cursor 只能在 ChangeBatch 被持久化并由 Source 接纳后推进。
7. 相同文件状态重复扫描不能产生重复 ChangeItem。
8. 一个 Self 实例同一时刻只能有一个 active Connection Daemon Leader。
9. Daemon 崩溃后，未完成 Batch 必须可以重新处理且保持幂等。
10. 外部路径只读；任何写回必须使用 Source/Note 的正式 Plan/Apply 流程。
11. 默认不允许 active Target 精确重复或目录范围重叠，避免同一资料被多次摄入并虚增独立证据。
12. Self 写入 `managed_content` 前必须登记带预期 Hash 的 Write Receipt，避免 watcher 把自己的写入重复摄入；Hash 不匹配时不得抑制真实外部修改。

## 8. 与现有 Source 的关系

`source add --watch` 是快捷操作：

```text
创建 Source
  + 创建绑定的 Connection
  + 执行 Initial Scan
  + 归档 Snapshot
  + 触发 Ingestion
```

规范接口仍然分开：

- `source:*` 标识知识来源和 Snapshot 历史。
- `connection:*` 标识持续监控关系和扫描状态。
- 一个 Connection 可以绑定一个目录 Source，并为目录内文件维护独立 Observation。
- Connection 删除默认只停止监控，不删除 Source Snapshot 和知识历史。

## 9. 实施优先级

第一版按以下顺序实现：

1. 单文件和本地目录 Connection。
2. 手工 `connection scan` 和清单对账。
3. 定时 polling daemon。
4. 原生 watcher 作为低延迟提示。
5. 变化批次驱动 Source 和 Ingestion。
6. 实时事件查看和健康状态。
7. systemd/launchd 用户服务安装。
8. 网络盘、可移动磁盘和更复杂连接类型。

正确性优先于实时性。即使 watcher 暂时不可用，定期 reconciliation 也必须最终发现所有变化。
