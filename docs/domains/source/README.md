# Source 领域

> 状态：待详细设计

## 目标

Source 负责把文件、目录、Vault、网页和媒体等外部信息变成 Self 根目录内可追溯的证据快照。

## 负责范围

- 数据源注册、分类和配置
- `import`、`snapshot`、`mirror` 三种模式
- 接纳由 Connection 或一次性导入流程提交的文件清单
- 网页抓取入口和抓取边界
- 内容寻址存储、去重和版本快照
- Snapshot 发布和失败重试
- Source 删除、恢复及影响分析的源头信息

## 核心对象

- `Source`：一个持续或一次性的信息来源
- `SourceSpec`：类型、位置、包含规则和同步策略
- `Snapshot`：一次不可变的来源快照
- `Blob`：按内容哈希保存的原始对象

## 关键不变量

- 进入摄入流程的内容必须已有内部快照。
- Snapshot 一旦发布不可原地修改。
- 相同 Blob 可以被多个 Source 和 Snapshot 引用。
- mirror 模式不能把外部绝对路径当成唯一证据。
- mirror 模式的持续扫描和 Cursor 由 Connection 拥有，Source 只拥有归档结果。

## 不负责

- 持续监听外部文件和目录（由 Connection 领域负责）
- 从内容中提取正文或 Chunk
- 计算 Embedding
- 判断知识真伪和可信度

## 与 Connection 的边界

Connection 发现外部变化并提交可靠 ChangeBatch；Source 接纳 ChangeBatch，将变化内容保存为 Self Root 内部的 Blob、Snapshot 和版本。`source add --watch` 是两个领域的应用层组合命令，不表示 Source 自己拥有 watcher 或后台调度。

## 输出事件

- `SourceAdded`
- `SnapshotCreated`
- `SourceChanged`
- `SourceDeleted`
