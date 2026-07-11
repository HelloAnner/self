# Self 模型选择、向量空间与迁移规范

> 状态：模型基线草案
> 规格核验日期：2026-07-11
> 核心结论：对话模型是可替换的计算能力；Embedding 模型、维度和前处理共同定义持久化的 `VectorSpace`，绝不能像普通配置一样原地切换。

## 1. 为什么需要单独设计

Self 使用的模型至少分为对话/生成、Embedding、Reranker、视觉/OCR 和转写几类。它们虽然都叫“模型”，但对数据兼容性的影响完全不同：

| 类型 | 主要职责 | 能否直接更换 | 更换后的处理 |
| --- | --- | --- | --- |
| 对话/生成模型 | 问答、抽取、综合、Page IR 草拟 | 可以按任务切换 | 保留 Invocation、Prompt 和 Build 版本；历史结果不重写 |
| Embedding 模型 | 把 Query 和 Chunk 映射到同一向量空间 | 不可以原地切换 | 创建新 VectorSpace，重新向量化、验证并原子激活 |
| Reranker | 对已召回候选重新排序 | 可以切换 | 记录版本并回归检索质量，不需要重建 Chunk 向量 |
| 视觉/OCR/转写 | 把非文本资料转换为可摄入内容 | 可以切换，但会改变派生文本 | 产生新解析版本，不能覆盖旧 Revision |

“维度一样”不代表向量兼容。两个模型即使都输出 1024 维，坐标轴的语义也完全不同；用模型 B 生成的 Query 向量去搜索模型 A 的文档向量，结果没有意义。

## 2. 模型在 Self 中的职责

### 2.1 对话模型

对话模型只负责计算，不是事实源。它可以承担：

- 根据 Retrieval Evidence 回答问题并组织引用。
- 从 Chunk 中抽取 Entity、Relation、Claim、时间和置信信息。
- 对冲突 Claim 做对齐、分组和解释，但不能自行裁定事实。
- 构建 Topic 综合报告和 Page IR。
- 生成标题、摘要、标签、查询扩展和图表说明。
- 为 Agent 生成结构化 Plan 候选，由领域规则再次校验。

对话模型不能：

- 把自身参数记忆当成已经进入 Self 的证据。
- 绕过 Retrieval 伪造 Citation。
- 直接写 SQLite、原始文件或 Artifact Manifest。
- 让未经 Schema 校验的输出进入领域对象。
- 覆盖人工确认的 Claim、Note 或历史 Build。

### 2.2 Embedding 模型

Embedding 模型负责把语义相近的内容映射到同一向量空间，主要用于：

- Chunk 语义召回。
- Query 向量召回。
- 相似 Chunk、近重复材料和候选关联发现。
- Entity/Topic 候选聚类。
- 混合检索中的 Vector 路召回。

Embedding 不负责生成答案，也不直接证明两个 Claim 相同。向量相似度只是召回信号，最终结果仍需 FTS、Graph、Reranker、来源和证据规则共同判断。

### 2.3 Reranker

Reranker 接收 Query 和有限数量的候选正文，输出相关性顺序。建议流程是：

```text
FTS + Vector + Graph
  → 合并并去重 Top 50～100
  → Reranker
  → Evidence Context
```

Reranker 不替代第一阶段召回。它可以独立升级，但升级后必须用固定 Query/Evidence 集做 NDCG、Recall 和 Citation 回归。

## 3. 对话模型路由，而不是一个模型包办全部

建议定义稳定的任务角色，由 `ModelRoute` 绑定具体模型：

| 路由 | 任务 | 选择偏好 |
| --- | --- | --- |
| `chat_fast` | 标题、摘要、Query 改写、交互问答 | 低延迟、低成本、稳定 JSON |
| `extract` | Entity/Relation/Claim 抽取 | Schema 遵循、低随机性、一致性 |
| `reasoning` | 冲突分析、复杂 Graph/Claim 对齐 | 推理能力、长上下文、可解释阶段 |
| `synthesis` | Topic 深度报告、Page IR | 长上下文、结构化写作、引用保持 |
| `vision_fast` | 图片快速描述和预分类 | 低延迟、低成本、多模态稳定性 |
| `vision` | 图片、扫描 PDF 和图表理解 | 多模态能力、页码/区域定位 |
| `ocr` | 页面文字、版面和表格提取 | 文字准确率、Reading Order、坐标定位 |

初期可以让同一个千问模型承担多个 Route，但领域层必须使用 Route 名称，不能在业务代码中硬编码 Provider Model ID。后续替换某个 Route 不应影响其他任务。

### 3.1 千问对话模型偏好

Self 的资料以中文、英文、代码和长文档为主，优先选择：

1. 中文与中英混合语义稳定。
2. 支持结构化输出和工具调用。
3. 能准确保持 Chunk/Citation ID，不随意改写 ID。
4. 非思考模式具备低延迟，思考模式可按复杂任务开启。
5. 有固定快照或可记录的模型修订版本。
6. 本地或 OpenAI-compatible Provider 可替换。

2026-07 的 Hosted 起步方案可用千问 Plus 类稳定模型承担 `chat_fast`、`extract` 和普通 `synthesis`，复杂冲突分析再路由到 Thinking/更高质量型号。具体线上别名变化快，生产配置必须优先使用 Provider 提供的固定快照；若只能使用浮动别名，Self 需要记录每次响应中的实际模型标识，并对模型漂移告警。千问官方说明其模型支持工具使用、多语言以及 Thinking/Non-thinking 类能力，选型仍需用 Self 自己的真实语料验证。[Qwen3 官方仓库](https://github.com/QwenLM/Qwen3)

不要把“最新”写死为永久默认。模型 Registry 可以更新推荐候选，但实例 Route 的变化必须显式发生并进入 Audit。

## 4. 千问 Embedding 建议

### 4.1 默认建议

对于个人知识库的中文、英文、代码混合检索，建议第一版采用以下二选一基线：

| 部署偏好 | 推荐起点 | 维度 | 理由 |
| --- | --- | ---: | --- |
| Hosted、低运维 | Alibaba Cloud Model Studio `text-embedding-v4` | **1024** | 属于 Qwen3 Embedding 系列；官方默认 1024，支持 64～2048 自定义维度和 100+ 语言 |
| Local-first、隐私优先 | `Qwen3-Embedding-0.6B` | **1024** | 官方原生维度 1024，模型较小，适合个人设备建立本地基线 |

这两个选择不能混用，也不能因为名称都属于 Qwen3、维度都是 1024 就视为同一 VectorSpace。Hosted `text-embedding-v4` 与本地开源权重之间没有兼容承诺，必须分别建立空间。

千问官方给出的开源文本 Embedding 规格为：

| 模型 | 原生最大维度 | 上下文 | MRL 自定义维度 |
| --- | ---: | ---: | --- |
| `Qwen3-Embedding-0.6B` | 1024 | 32K | 支持 |
| `Qwen3-Embedding-4B` | 2560 | 32K | 支持 |
| `Qwen3-Embedding-8B` | 4096 | 32K | 支持 |

规格来源：[Qwen3-Embedding 官方仓库](https://github.com/QwenLM/Qwen3-Embedding)。Hosted `text-embedding-v4` 当前官方支持 2048、1536、1024（默认）、768、512、256、128、64 维，单条输入上限和批量限制以调用区域的实时文档为准。[Alibaba Cloud Model Studio Embedding 文档](https://help.aliyun.com/en/model-studio/embedding)

### 4.2 为什么默认 1024 维

1024 维是 Self 的平衡起点，不是普遍真理：

- 对 Hosted v4 和本地 0.6B 都是自然起点，接入简单。
- 对个人知识规模，召回质量、存储和 KNN 延迟通常更均衡。
- 允许在评测后为高质量空间选择 2048/2560，而不是一开始承担全部成本。
- 维度必须在建库前确定；使用 MRL 截断也属于新的空间定义。

以 float32 原始向量、200,000 个 Chunk 粗略计算，不含 sqlite-vec 索引、行和 WAL 开销：

| 维度 | 单向量 | 200,000 Chunk |
| ---: | ---: | ---: |
| 768 | 3KB | 约 586MiB |
| 1024 | 4KB | 约 781MiB |
| 2048 | 8KB | 约 1.53GiB |
| 2560 | 10KB | 约 1.91GiB |
| 4096 | 16KB | 约 3.05GiB |

真实占用必须通过 sqlite-vec Fixture 测量。不能只为了“维度更高看起来更强”选择 4096；维度收益要通过 Self 真实 Query 的 Recall@K、NDCG、Citation 命中率和延迟证明。

### 4.3 输入策略

Qwen3 Embedding 支持 instruction-aware 检索。Self 必须固定并版本化：

- Query Instruction Template。
- Document 是否添加 Instruction；默认不添加。
- 文本规范化版本。
- 最大 Token 和截断策略。
- Chunk 标题、路径、标签是否拼入输入。
- Pooling、L2 Normalize、Distance Metric。

开源 Qwen3-Embedding 官方示例建议为 Query 提供描述任务的一句 Instruction，文档不必添加；官方还建议多语言场景的 Instruction 使用英文。Self 可从以下模板开始，并用真实数据评测：

```text
Given a personal knowledge-base query, retrieve passages that provide direct evidence, relevant context, contradictions, or updates for the query.
```

修改一个标点通常不必创建新空间，但任何会系统性改变输入语义的模板或前处理变更都必须提升 `embedding_input_version`，通过评测决定增量重建或新建空间。

## 5. VectorSpace 是持久化数据格式

一个 `VectorSpace` 至少由以下字段唯一确定：

```text
provider_type
provider_endpoint_identity
model_id
model_revision_or_weight_hash
tokenizer_revision
dimensions
scalar_type
pooling
normalization
distance_metric
query_instruction_version
document_instruction_version
embedding_input_version
```

推荐生成不可变的 `space_fingerprint`：

```text
sha256(canonical_json(all_compatibility_fields))
```

只有 `space_fingerprint` 完全相同的 Query 和 Chunk Embedding 才能比较。Provider URL、API Key 和并发等运行参数不属于数学空间；模型别名解析结果、模型 Revision、维度和输入算法属于空间。

### 5.1 Hosted 模型漂移检测

如果 Provider 只提供浮动别名而不提供固定快照：

1. Registry 标记 `revision_stability = floating`。
2. 每次调用记录 Provider 返回的实际 Model ID。
3. 定期对固定、非隐私 Sentinel 文本计算 Embedding Fingerprint。
4. Fingerprint 超出数值容差时暂停向 Active Space 写入。
5. 创建告警并要求建立新 VectorSpace 或确认 Provider 兼容性。

不能把新旧模型返回的向量继续塞入同一张 vec 表。

## 6. Embedding 模型变更工作流

### 6.1 禁止原地修改

以下任一变化都必须至少新建 VectorSpace：

- Provider 或 Model ID 变化。
- 浮动别名实际 Revision 变化且兼容性未经证明。
- 维度变化。
- Normalize、Pooling 或 Distance Metric 变化。
- Query/Document Instruction 的语义版本变化。
- Tokenizer、截断或输入拼装算法发生不兼容变化。

SQLite `vec0` 表的维度在 Schema 上也是固定的；不能对现有列“顺手改个 dimensions”继续使用。

### 6.2 安全迁移状态机

VectorSpace 生命周期状态固定为 `building → verifying → ready → deprecated → deleted`，任一构建阶段可以进入 `failed` 后重试。`active` 不是可与生命周期混用的状态，而是 Workspace 指向一个 `ready` 空间的原子指针；`dual_write`、`backfill` 和 `shadow_query` 是 Migration Job 的阶段。

```text
active pointer → ready(A)
  → create building(B)
  → dual_write(A, B) for new/changed chunks
  → backfill B with checkpoints
  → verify coverage + dimensions + sample quality
  → shadow_query A/B
  → ready(B)
  → atomic move active pointer to B
  → deprecated(A) retained for rollback
  → GC A only after retention and explicit Plan
```

迁移期间：

- A 继续服务，不删除旧向量。
- 每个 Chunk 在 B 中最多一个当前 Embedding，写入保持幂等。
- B 失败不影响 A。
- Search 默认只查询一个 Active Space，不把 A/B 分数直接混合。
- Shadow Query 只比较结果和指标，不向用户伪装成正式结果。
- 激活使用短事务更新 Workspace 的 Active VectorSpace ID。
- 回滚只切回仍完整的 A，不重新计算。

### 6.3 激活门禁

新空间只有满足以下条件才能激活：

- Active Chunk 覆盖率达到配置目标，默认 100%；明确忽略项单独报告。
- 所有向量维度、dtype、有限值和 normalize 规则通过校验。
- Sentinel Fingerprint 与空间 Registry 匹配。
- 固定 Retrieval Fixture 的质量不低于允许阈值。
- Medium Profile p95 和磁盘占用符合性能预算。
- 没有未解释的 failed/partial Batch。
- 回滚空间和保留期限已写入 Plan。

### 6.4 原厂商不可用时的重建

Self 不能假设某个 Embedding Provider 永远存在。可替换性的基础是：

- 规范 Chunk 正文、标题、路径和元数据始终保存在本地 SQLite/文件中。
- 每个旧空间保存完整 Input/Instruction/Normalize/Distance 版本，但重建新空间不需要调用旧 Provider。
- 新 Provider 直接读取本地 Active Chunk，生成全新的 VectorSpace。
- 重建不重新抓网页、不依赖外部项目目录仍在线，也不修改 Chunk ID 和证据链。

如果 Active Provider A 突然不可用：

```text
Query Embedding(A) 失败
  → Circuit Breaker 打开
  → Search 明确降级为 FTS + Graph（可选缓存过的 A Query）
  → 注册 Provider/Model B
  → 创建独立 VectorSpace B
  → 从本地 Chunk 分批 Embedding + checkpoint
  → B 达到覆盖、质量和性能门禁
  → 原子激活 B
  → Hybrid Search 恢复
```

不能用 B 的 Query 向量查询 A 的文档向量。A Provider 不可用时，旧 A 空间仍可保留用于审计和未来回滚，但对新的任意语义 Query 通常无法完整服务；CLI 必须显示 `vector_degraded`，不能假装是完整 Hybrid 结果。

### 6.5 重建的可恢复性

- Build 输入水位固定为开始时的 Active Chunk 集；期间新增 Chunk 进入 catch-up 队列。
- 每批按 `vector_space_id + chunk_id + content_hash` 幂等写入。
- Job 保存最后 Chunk Cursor、成功/失败数、Token、成本和 Provider 限流状态。
- 429/超时使用有限退避；凭证/模型不存在触发 Circuit Breaker，不无限重试烧钱。
- 单个 Chunk 失败不丢弃整个批次，最终以 partial 明确列出。
- 进程退出后从 SQLite checkpoint 继续，不从零开始。
- 新空间使用独立 vec 表/Generation；失败时直接丢弃 shadow 数据，不污染 Active Space。
- 磁盘空间不足时在开始前按 Chunk 数、维度和 dtype 估算并拒绝。
- 激活后继续双写一个稳定窗口；旧空间按 Retention 保存，再通过 GC Plan 清理。

## 7. CLI 契约

### 7.1 模型注册与路由

```bash
self model list --capability chat
self model list --capability embedding
self model add --provider dashscope --capability embedding \
  --model text-embedding-v4 --revision floating
self model test model:mdl_123 --suite embedding-compat

self model route list
self model route set chat_fast model:mdl_chat_fast --plan
self model route set synthesis model:mdl_chat_deep --plan
self model usage --since 24h
```

对话 Route 切换不重写历史 Build；新的 Invocation 和 Artifact Build 记录新 Model ID。

### 7.2 VectorSpace 动作

```bash
# 查看当前空间
self vector-space list
self vector-space show vector-space:vsp_123
self vector-space active

# 从已注册 Embedding 模型创建不可变空间定义
self vector-space create \
  --model model:mdl_123 \
  --dimensions 1024 \
  --distance cosine \
  --normalize l2 \
  --query-instruction personal-knowledge-retrieval-v1 \
  --plan

# 执行创建计划并在后台回填
self apply plan:plan_123
self vector-space build vector-space:vsp_456 --detach
self job watch job:job_456 --jsonl

# 验证、影子比较和激活
self vector-space verify vector-space:vsp_456 --deep
self vector-space compare vector-space:vsp_123 vector-space:vsp_456 \
  --fixture retrieval-medium-v1
self vector-space activate vector-space:vsp_456 --plan
self apply plan:plan_789

# 旧空间只在保留期后通过计划清除
self vector-space delete vector-space:vsp_123 --plan

# Provider A 不可用时，从本地 Chunk 迁移到 B
self vector-space migrate \
  --from vector-space:vsp_123 \
  --to-model model:mdl_provider_b \
  --dimensions 1024 \
  --from-local-chunks \
  --plan
self apply plan:plan_900
self job watch job:job_900 --jsonl
```

`self model set-default --capability embedding ...` 不得直接改变 Active Space。CLI 应返回稳定错误 `embedding_requires_vector_space`，并建议 `vector-space create → build → verify → activate`。

全局 `--embedding-model` 也只能选择已经存在且 ready 的兼容 VectorSpace；如果找不到完全匹配的空间，返回 `vector_space_not_found`，不能现场用另一个模型生成 Query 向量后搜索旧数据。

## 8. 配置与数据归属

`self.toml` 保存 Provider 默认、Route 候选和资源限制；动态 Model Registry、VectorSpace、迁移进度和 Active ID 存在 SQLite。

```toml
[models]
offline = false

[models.providers.dashscope]
protocol = "openai-compatible"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
direct_api_base_url = "https://dashscope.aliyuncs.com/api/v1"
api_key_env = "SELF_DASHSCOPE_API_KEY"

[models.routes]
chat_fast = "model:mdl_chat_fast"
extract = "model:mdl_extract"
reasoning = "model:mdl_reasoning"
synthesis = "model:mdl_synthesis"
vision_fast = "model:mdl_vision_fast"
vision = "model:mdl_vision"
ocr = "model:mdl_ocr"

[models.embedding_defaults]
model = "model:mdl_qwen_embedding"
dimensions = 1024
distance = "cosine"
normalize = "l2"
query_instruction = "personal-knowledge-retrieval-v1"

[models.embedding_limits]
batch_size = 10
max_concurrency = 2
request_timeout = "30s"
```

`embedding_defaults` 只用于创建新空间的默认输入，不表示当前 Active Space，也不能覆盖 SQLite 中的不可变定义。

## 9. 对话模型变更和可复现性

每次 `Invocation` 至少记录：

- Model 和 Provider 稳定 ID。
- Provider 返回的实际模型/快照。
- Route、PromptSpec 和 JSON Schema 版本。
- Temperature、Top P、Seed 等关键参数。
- 输入 Evidence ID 列表和输入 Hash。
- 输出 Hash、Token、延迟、成本和重试信息。
- 是否使用 Thinking、工具或降级 Route。

对话模型升级后：

- 旧 Topic/Artifact 继续保留并可打开。
- 只有用户 refresh 或依赖变化才产生新 Build。
- 新旧报告可以 diff，并解释 Model/Prompt/Evidence 的变化。
- 模型输出仍必须引用原始 Evidence；“更强的模型”不提高来源本身的可信度。

## 10. 评测与选择门禁

不要只看公开排行榜。Self 需要自己的脱敏 Evaluation Set：

### Embedding/Reranker

- 中文、英文和代码混合 Query。
- 精确术语、别名、缩写和模糊语义。
- 时间更新、冲突观点和来源过滤。
- Obsidian Wiki Link、路径和标题信息。
- Recall@10/20、MRR、NDCG、Citation 命中率。
- Query Embedding p95、KNN p95、吞吐、成本和磁盘。

### 对话/抽取

- Citation ID 保持率和 Citation Precision。
- Claim/Entity Schema 合法率。
- 冲突与未知项召回率。
- 幻觉、Prompt Injection 和越权动作率。
- 首 Token 延迟、总延迟、Token 与成本。
- 同一输入的稳定性和可重试性。

任何默认模型变更都要保存 Evaluation Report、Fixture Hash、结果和批准 Operation。质量、隐私、延迟和成本共同决策，不用单一分数决定。

## 11. 推荐的第一版落地顺序

1. 先实现 Model 领域的 Provider、Model、ModelRoute、Invocation，以及 Knowledge 领域拥有的 VectorSpace Registry。
2. 选择一个千问 Embedding 基线：Hosted `text-embedding-v4@1024` 或 Local `Qwen3-Embedding-0.6B@1024`，不要同时作为 Active。
3. 固定 Input、Instruction、Normalize 和 Distance 版本。
4. 建立 50～200 条真实 Query/Evidence 小型 Golden Set。
5. 完成 Chunk Embedding、Query Embedding、sqlite-vec 和 Hybrid Search。
6. 实现 VectorSpace build/verify/activate 和旧空间回滚。
7. 再评测 4B、更高维度和 Qwen3 Reranker 是否带来可证明收益。
8. 对话模型先建立 `chat_fast`、`extract`、`synthesis` 三个 Route，复杂推理 Route 后加。

## 12. 红线

- 不同 Model/Revision/维度的向量写入同一 VectorSpace。
- 只因为维度一致就比较两个模型的向量。
- 修改 `self.toml` 后静默让旧向量变成“新模型向量”。
- 重建开始就删除 Active Space。
- 把 A/B 两个空间的相似度分数直接混合排序。
- Hosted 浮动别名漂移后继续无告警写入。
- 为了节省空间，在没有质量评测时截断维度或量化。
- 让对话模型输出绕过 Schema、Citation 和领域校验。
- 把模型输出当作新的独立来源循环摄入。
- 在日志、Evaluation Fixture 或 Artifact 中泄露 API Key 和私人全文。

模型能力会快速变化，但 Self 的历史知识必须稳定。正确的设计不是永远不换模型，而是把每次模型变化变成一个可版本化、可评测、可迁移、可回滚的动作。

## 13. 当前百炼账号可用模型基线

> 实测日期：2026-07-11
> 区域与兼容入口：中国内地（北京），`https://dashscope.aliyuncs.com/compatible-mode/v1`
> 安全说明：测试只在临时进程中注入 API Key；Key 未写入本文、仓库、测试文件或命令输出。

### 13.1 可用状态的含义

本文区分：

| 状态 | 含义 |
| --- | --- |
| **实际通过** | 已使用当前账号发送最小真实请求并获得 HTTP 200 和结构正确的结果 |
| **账号可见** | `/models` 返回了该 Model ID，但本轮没有逐个产生计费调用 |
| **不可用** | 真实请求返回 Model Not Found 或无权限 |

“实际通过”只证明 2026-07-11 当时可调用，不代表永久授权、免费额度、质量或 SLA。Self 启动和 Release Live Suite 仍需执行 `model test`。

### 13.2 文本 Embedding：实际通过

以下型号通过 OpenAI-compatible `POST /embeddings` 实测：

| Model ID | 实测维度 | 状态 | Self 建议 |
| --- | --- | --- | --- |
| `text-embedding-v4` | 2048、1536、1024、768、512、256、128、64 全部通过 | **实际通过** | **默认选择 1024 维** |
| `text-embedding-v3` | 1024、768、512、256、128、64 全部通过 | **实际通过** | v4 故障时的兼容候选，不与 v4 向量混用 |
| `text-embedding-v2` | 固定返回 1536 | **实际通过** | 旧系统兼容，不建议新建 Self 空间 |
| `text-embedding-v1` | 固定返回 1536 | **实际通过** | Legacy，仅迁移旧数据时考虑 |

实测还确认：

- `qwen3-embedding` 返回 `model_not_found`，**不可用，也不是百炼 Hosted 文本 Embedding 的正确 Model ID**。
- 百炼当前的 Qwen3 文本 Embedding Hosted 入口应使用 `text-embedding-v4`。
- `/models` 没有列出这些文本 Embedding ID，但直接调用可以成功；不能只靠 `/models` 判断 Embedding 可用性。
- v4 与 v3 即使都选择 1024 维，也必须是两个独立 VectorSpace。

### 13.3 多模态 Embedding：实际通过

多模态 Embedding 不支持 OpenAI-compatible `/embeddings`，必须调用 DashScope Direct API：

```text
POST https://dashscope.aliyuncs.com/api/v1/services/embeddings/
     multimodal-embedding/multimodal-embedding
```

本账号实测：

| Model ID | 实测输入/维度 | 状态 | 用途 |
| --- | --- | --- | --- |
| `qwen3-vl-embedding` | 文本输入，1024 维 | **实际通过** | 文本、图片、视频和跨模态检索；建议未来单独建多模态空间 |
| `tongyi-embedding-vision-plus-2026-03-06` | 文本输入，1152 维 | **实际通过** | 高质量多模态独立/融合向量候选 |
| `tongyi-embedding-vision-flash-2026-03-06` | 文本输入，768 维 | **实际通过** | 低延迟、低存储多模态候选 |

官方当前说明 `qwen3-vl-embedding` 支持 2560（默认）、2048、1536、1024、768、512、256 维，并支持独立向量和融合向量。[百炼多模态 Embedding API](https://help.aliyun.com/en/model-studio/multimodal-embedding-api-reference)

多模态空间绝不能与 `text-embedding-v4@1024` 混合。即使都选择 1024 维，模型、输入模态和坐标空间仍不同。

### 13.4 对话模型：实际通过

以下固定快照通过 OpenAI-compatible `POST /chat/completions` 最小文本请求：

| Model ID | 状态 | 建议 Route |
| --- | --- | --- |
| `qwen3.6-flash-2026-04-16` | **实际通过** | `chat_fast`、低成本 Query 改写和摘要候选 |
| `qwen3.7-plus-2026-05-26` | **实际通过** | `extract`、普通问答和 `synthesis` 首选候选 |
| `qwen3.7-max-2026-06-08` | **实际通过** | `reasoning`、复杂冲突分析和深度综合候选 |
| `qwen3.5-plus-2026-04-20` | **实际通过** | Plus 降级候选 |
| `qwen3-max-2026-01-23` | **实际通过** | Max 降级/历史复现候选 |
| `qwen-plus-2025-12-01` | **实际通过** | 旧版 Build 复现或兼容候选 |
| `qwen3-30b-a3b-instruct-2507` | **实际通过** | 固定开源权重系列的 Hosted 对照候选 |

上述 Route 是第一轮工程起点，不是质量结论。正式默认仍需通过 Self 的 Citation、Schema、中文知识综合、延迟和成本 Golden Set。

### 13.5 对话模型：账号可见但未逐个调用

账号 `/models` 清单还包含以下与 Self 相关的千问系列：

- 通用 Hosted：`qwen-flash`、`qwen-plus`、`qwen-max` 及多个固定快照。
- Qwen3：`qwen3-8b`、`qwen3-14b`、`qwen3-30b-a3b`、`qwen3-32b`、`qwen3-235b-a22b` 及 Instruct/Thinking 快照。
- Qwen3 Max/Next：`qwen3-max`、`qwen3-max-2025-09-23`、`qwen3-max-2026-01-23`、`qwen3-next-80b-a3b-instruct`、`qwen3-next-80b-a3b-thinking`。
- Qwen3.5：`qwen3.5-flash`、`qwen3.5-plus` 和 27B、35B-A3B、122B-A10B、397B-A17B 等型号。
- Qwen3.6：`qwen3.6-flash`、`qwen3.6-plus`、`qwen3.6-max-preview` 及固定快照。
- Qwen3.7：`qwen3.7-plus`、`qwen3.7-max`、`qwen3.7-max-preview` 及多个固定快照。
- 专用模型：Qwen Coder、Math、MT、Deep Research、Deep Search Planning、QVQ 和 QWQ 系列。

浮动别名适合交互试用，Self 的生产 Route 优先使用已经实测的固定快照。清单可见不等于已完成 Self 质量验证。

### 13.6 视觉理解、Omni 与 OCR：实际通过

以下型号均使用真实图片 URL 调用 `chat/completions` 并返回 HTTP 200：

| Model ID | 状态 | 建议用途 |
| --- | --- | --- |
| `qwen3-vl-flash-2026-01-22` | **实际通过** | 图片快速描述、普通图表理解 |
| `qwen3-vl-plus-2025-12-19` | **实际通过** | 高质量图片/页面/图表理解 |
| `qwen-vl-ocr-2025-11-20` | **实际通过** | 旧 OCR 稳定快照和兼容回退 |
| `qwen3.5-omni-flash-2026-03-15` | **实际通过** | 图片及未来音视频快速理解候选 |
| `qwen3.5-omni-plus-2026-03-15` | **实际通过** | 高质量 Omni 理解候选 |
| `qwen3.5-ocr` | **实际通过** | 当前 OCR 候选；浮动别名需记录实际版本 |
| `qwen3.7-plus-2026-05-26` | **实际通过** | 通用对话与视觉统一 Route 候选 |
| `qwen3.7-max-2026-06-08` | **实际通过** | 复杂图表、截图和视觉推理候选 |

账号清单另外可见：

- `qwen-vl-plus`、`qwen-vl-max`、`qwen-vl-ocr` 及 OCR 快照。
- `qwen3-vl-flash`、`qwen3-vl-plus` 及多个固定快照。
- `qwen3.5-omni-flash`、`qwen3.5-omni-plus`、Realtime 和固定快照。
- `qwen3.5-ocr`、`qwen3.5-plus`、`qwen3.7-plus`、`qwen3.7-max`。

`qwen-image-*`、`wan2.7-image*` 等图片生成模型也在账号清单中，但它们属于图像生成，不是 Source 图片理解或 OCR 模型，因此不放入 Self 的 `vision` Route。

### 13.7 当前推荐 Registry 与 Route

在完成 Self 自有 Golden Set 前，建议使用以下保守基线：

| Self 能力 | Provider Model ID | 说明 |
| --- | --- | --- |
| Active Text VectorSpace | `text-embedding-v4@1024` | 当前默认；Cosine + L2 Normalize + 固定 Instruction |
| Experimental Multimodal VectorSpace | `qwen3-vl-embedding@1024` | 单独空间，Phase 1 不与文本空间同时 Active |
| `chat_fast` | `qwen3.6-flash-2026-04-16` | 低延迟任务 |
| `extract` | `qwen3.7-plus-2026-05-26` | 结构化抽取候选，需 Schema Golden 验证 |
| `synthesis` | `qwen3.7-plus-2026-05-26` | 普通知识综合 |
| `reasoning` | `qwen3.7-max-2026-06-08` | 深度综合和冲突分析 |
| `vision_fast` | `qwen3-vl-flash-2026-01-22` | 图片、截图快速理解 |
| `vision` | `qwen3-vl-plus-2025-12-19` | 图表、复杂页面理解 |
| `ocr` | `qwen3.5-ocr` | 先记录浮动实际版本；稳定后改用快照 |

Provider Registry 只保存 Base URL 和环境变量名：

```toml
[models.providers.dashscope]
protocol = "openai-compatible"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
direct_api_base_url = "https://dashscope.aliyuncs.com/api/v1"
api_key_env = "SELF_DASHSCOPE_API_KEY"
```

运行时通过环境变量注入：

```bash
export SELF_DASHSCOPE_API_KEY='由用户在本地安全设置，不写入仓库'
```

Self 的日志、`self.toml`、Model Registry、Invocation 和测试报告都不得保存 Key 值。
