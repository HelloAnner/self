# Topic 领域模型

## 1. 聚合

Topic 是可变聚合根，保存名称、描述、范围、排除条件、别名、对象版本和 latest_snapshot_id。范围更新只改变 Topic 并令旧报告 stale；已经发布的 TopicSnapshot 不随之修改。

TopicSnapshot 是一次综合所使用知识的不可变投影，固定：

- TopicScope 和版本
- Retrieval Context 与 FTS、VectorSpace、Graph 水位
- 被采用的 Claim、证据谱系和局部 Graph
- Outline、Section、Conclusion、Citation 和 KnowledgeGap
- 报告可信度、覆盖度、健康状态和父版本变化摘要

SynthesisRun 记录一次完整构建的输入 Hash、规则版本、候选数量、耗时、警告和失败。Phase 7 支持 full/rebuild；Phase 8 的 refresh 在输入未失效时不创建 SynthesisRun，输入变化时仍由 Topic 生成新 Snapshot，再由 Artifact 复用未变化 Page IR 组件。

## 2. 状态

Topic 状态：

~~~text
active -> stale -> active
active/stale -> needs_review -> active
active/stale/needs_review -> deleted
~~~

- active：latest Snapshot 与已知依赖一致。
- stale：知识、Graph 或范围水位已经变化，需要重新综合。
- needs_review：依赖 Claim 被确认、否定或进入争议，不能只做普通缓存失效。
- deleted：软删除保留历史；Phase 9 已通过 Plan/Apply 删除并从 OperationChange 恢复。

TopicSnapshot 自身没有 stale 状态。历史快照描述过去一次确定输入，永远可读；是否仍适合作为 latest 由 Topic 状态表达。

## 3. 结论类型

| 类型 | 规则 |
| --- | --- |
| consensus | 同一 Claim 至少有两个不同 source_lineage_key |
| single_source | 有直接 Claim/Chunk 支持，但只有一个独立来源谱系 |
| user_opinion | Claim 的 epistemic_status 明确为 user_opinion |
| inference | Claim 的 epistemic_status 明确为 inference |
| conflict | Claim 属于仍未解决的 ConflictSet 或状态 disputed |
| unknown | 当前无支持 Claim，或已识别的问题尚缺资料 |

转载和重复副本不会增加独立来源数。Phase 7 使用 Graph Evidence 的 source_lineage_key；缺失时回退到 Source + Blob Hash。相同 Blob 的转载折叠为同一谱系。

## 4. Claim 聚类和冲突

cluster_key 由 subject、predicate、qualifier 和 ConflictSet 组成。Topic 不重新发明事实，也不把相似 Chunk 当作多个 Claim。

Graph 的自动冲突要求双方显式声明相同且非空的 qualifiers.conflict_scope。只有相同主体、谓词、时间和 conflict_scope 且位置不能同时成立时，才建立 ConflictSet。普通多值关系（例如 FAISS 同时 uses HNSW、IVF、PQ 和 CUDA）不得因 object 不同而自动判冲突。

## 5. 可信度与健康状态

Conclusion 继承 Claim 的多维可信度，同时记录：独立来源数、证据数、转载/重复数、Conflict ID 和 epistemic_status。

Section 可信度由关键 Claim 决定，不计算平均概率。Report 同时输出：

- confidence_level：high、medium、low、disputed、unknown
- coverage：Claim、独立谱系、Evidence、共识、冲突和 Gap 数量
- health_status：healthy、degraded、needs_review、insufficient
- confidence explanation：触发报告级判断的规则和未解决问题

存在未解决冲突时 health 为 needs_review；无 Claim 时为 insufficient；只有单一来源时为 degraded；存在多源共识且无冲突时为 healthy。

## 6. 不变量

1. 每个 supported Conclusion 至少有一条 Citation，Citation 必须指向 Claim Evidence 和不可变 Chunk。
2. Citation 保存 Chunk 精确字符区间和 SHA-256，可由 Section Trace 重放。
3. user_opinion 和 inference 不得升级为 consensus/fact 标签。
4. unknown 不生成伪 Citation，也不调用模型常识补齐。
5. 每次 build 创建新的 TopicSnapshot 和 ReportSection；旧行禁止 UPDATE/DELETE。
6. Topic 的 latest 指针只在完整事务成功后切换。
