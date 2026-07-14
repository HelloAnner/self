# Retrieval SQLite Schema

> 状态：Schema 7 current

FTS Generation 与 Chunk Embedding 属于 Knowledge；`retrieval_query_cache` 仍只缓存 Query Embedding。Schema 7 新增 Retrieval 自有的回答证据表：

| 表 | 含义 |
| --- | --- |
| `retrieval_runs` | Query Hash、计划版本、FTS/Vector/Graph 水位、阶段耗时和 warning |
| `retrieval_candidates` | 每路候选、rank、score、Claim 与是否进入 Context |
| `evidence_contexts` | Context Hash、预算、Item 数量、Prompt 版本与 active/stale 状态 |
| `evidence_context_items` | E-key 到 Chunk→Revision→Snapshot→Source 的不可变定位 |
| `answer_runs` | Answer 状态、结果类型、模型/Invocation、验证版本与 cache 状态 |
| `answer_statements` | 原子结论、结论类型、可信度和 support 状态 |
| `answer_citations` | Statement 到 Context Item 的精确原文范围与 Hash |

所有表仍在唯一的 `data/self.sqlite3`。`retrieval_runs` 只保存 Query Hash，不保存默认 Query 历史；Answer 正文属于用户请求产生的本地业务数据，可以持久化并审计。

EvidenceContext 与 Answer 状态为 `active|stale`。Knowledge 发布、Graph Generation 激活或 Claim moderation 会保守地使活跃回答失效；旧记录不覆盖、不删除，仍可 Trace。后续可在不改变正确性的前提下把保守全失效优化为精确依赖失效。

索引覆盖：Query Hash Answer cache、Retrieval selected candidate、Context Chunk/Source、Answer Citation 点查。外键确保 Citation 不能引用 Context 之外的 Item。
