# Knowledge 发布与重建工作流

Knowledge Publisher 接受完整 Snapshot 的规范文档和 present path 集合：

1. 应用有 Connection 证据的 rename，保持 Document ID。
2. Blob 与算法 fingerprint 未变化时复用 Revision。
3. 否则创建不可变 Revision，并对上一 Revision 的 Chunk 做对齐。
4. 内容 Hash 精确相同的 Chunk 复用 ID；结构 anchor 与文本相似度建立 lineage。
5. 当前 Snapshot 中消失的 Document 和 Chunk tombstone，历史 Revision/Chunk 保留。
6. 写入 Run→Document→Revision 映射并原子切换当前投影。

算法版本或 Chunk 配置变化会产生新的 fingerprint 和 Revision；完全相同的 rebuild 返回已存在 Run，不制造重复版本。增量路径的当前规范内容与使用最终原始资料在新实例全量构建的结果必须等价。
