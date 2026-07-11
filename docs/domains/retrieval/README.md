# Retrieval 领域

> 状态：待详细设计

## 目标

Retrieval 面向一个问题，从全文、向量、图谱和结构化条件中找出最相关且可解释的知识上下文。

## 负责范围

- 查询解析、改写和意图识别
- SQLite FTS、向量和图遍历召回
- 时间、来源、项目、标签和可信度过滤
- 多路结果融合、去重和重排
- 检索解释和覆盖度评估
- Ask 所需的证据上下文组装
- 引用校验和知识库外模型知识隔离

## 核心对象

- `Query`：用户问题和检索约束
- `RetrievalPlan`：可执行的多路召回计划
- `Candidate`：带分数和来源的候选知识
- `EvidenceContext`：交给模型的最小证据集合
- `Citation`：输出片段到证据的映射
- `RetrievalTrace`：召回、过滤和重排过程

## 关键不变量

- 一次 Vector 召回只查询一个 ready/active VectorSpace；不同空间的相似度分数不得直接混合。
- Query Embedding 必须由目标 VectorSpace 记录的完全相同模型和输入规则生成。
- `--embedding-model` 找不到兼容 ready 空间时必须报错，不能临时跨空间搜索。
- Active Embedding Provider 不可用时返回明确 `vector_degraded`，并降级为 FTS + Graph；不能用新 Provider Query 搜索旧空间。
- 每个返回结果都必须有稳定对象 ID 和来源。
- 默认不得把未确认 AI 派生内容与原始来源混为一谈。
- Ask 的事实结论必须由 EvidenceContext 支撑。
- 检索分数只用于排序，不能直接等同于事实可信度。
- 相同查询和相同索引快照应可重现检索计划与候选集合。

## 不负责

- 生成和更新 Chunk
- 修改图谱
- Topic 的跨章节综合和长期状态
