# Knowledge 领域

> 状态：Phase 3 Document/Revision/Chunk 核心已实现；FTS/Vector 属于 Phase 4

## 目标

Knowledge 保存所有来源被打碎、规范化之后的统一知识材料，是搜索、图谱和综合报告的基础数据层。

## 负责范围

- Document、Revision 和 Chunk 生命周期
- Chunk 内容、位置、结构和来源映射
- SQLite FTS 全文索引
- Embedding 记录和多个向量空间
- Chunk 版本、失效、tombstone 和去重
- 人工 Note 与数据库表示的一致性
- 规范内容到证据 Snapshot 的回溯

## 核心对象

- `Document`：逻辑文档身份
- `Revision`：文档的不可变版本
- `Chunk`：最小可引用和可向量化片段
- `VectorSpace`：模型 Revision、维度、输入版本、Normalize 和距离度量共同定义的不可变空间
- `Embedding`：Chunk 在指定空间中的向量表示
- `Note`：用户可直接编辑的知识内容

## 关键不变量

- 每个 Chunk 必须属于一个 Revision 并能回到 Snapshot。
- 不同 Embedding 模型的向量不能混合比较。
- 只有 `space_fingerprint` 完全相同的 Query 和 Chunk 向量可以比较；维度相同不代表兼容。
- 新空间必须在旧空间继续服务时完成 build、verify 和原子 activate，并保留回滚期。
- VectorSpace 生命周期为 `building → verifying → ready → deprecated → deleted`，失败分支为 `failed`；Active 是 Workspace 指针，不是另一个可混用状态。
- Revision 发布后不可原地修改。
- FTS 和向量索引可以重建，但 Chunk 稳定 ID 和版本关系必须保留。
- Note 写回文件与数据库提交必须可恢复到一致状态。

## 不负责

- Entity 和 Claim 的业务语义
- 查询融合与重排
- 专题报告生成

## 技术验证

- [`sqlite-vector-spike.md`](./sqlite-vector-spike.md)：同一文件 SQLite 上的 Drizzle、FTS5、sqlite-vec 与 macOS Custom SQLite 结论。

## 详细文档

- [`model.md`](./model.md)、[`schema.md`](./schema.md)、[`workflows.md`](./workflows.md)、[`commands.md`](./commands.md)、[`testing.md`](./testing.md)
