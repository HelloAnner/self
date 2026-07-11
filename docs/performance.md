# Self 性能边界与响应时间预算

> 状态：性能基线草案
> 核心目标：交互操作毫秒级、慢任务立即异步化、后台构建不阻塞现有查询和页面访问。

> 模型职责、千问 Embedding、维度和 VectorSpace 迁移规则见 [`model-selection.md`](./model-selection.md)。

## 1. 性能目标的正确拆分

“所有操作都是毫秒级”应理解为：

1. 用户或 Agent 发出命令后，Self 必须在毫秒级完成响应或返回 Job。
2. 已经入库、已建立索引的数据查询必须是毫秒到亚秒级。
3. 已有 Page IR 的 HTML 组装和已有 Artifact 打开必须是毫秒到亚秒级。
4. 新资料解析、Embedding、图谱抽取、全量重建和 LLM 综合可以较慢，但必须在后台运行。
5. 后台任务运行期间，旧索引、旧 Topic 和旧 HTML 必须继续可用。

以下能力不能承诺纯毫秒级完成：

- 首次为大量文档计算 Embedding
- 远程模型生成 Query Embedding
- LLM 问答和 Topic 深度综合
- OCR、音视频转写和大型 PDF 解析
- 全量 FTS、向量或图谱重建
- 大规模 Backup、Restore、Verify 和 Migration

这些操作的同步部分仍必须快速：校验请求、创建 Job、保存 checkpoint 并返回 `job_id` 的目标是 p95 小于 100ms。

## 2. 延迟层级

### 2.1 Tier 0：即时控制操作

不访问模型、不扫描大目录、不做大查询：

| 操作 | p50 目标 | p95 目标 | 硬性行为 |
| --- | ---: | ---: | --- |
| `self version`、`help` | 10ms | 30ms | 不打开 Workspace 数据库 |
| Root 发现和 `self.toml` 解析 | 10ms | 40ms | 配置应在单次启动只读一次 |
| `self status` | 30ms | 100ms | 只读轻量汇总，不触发扫描 |
| `config get`、`commands --json` | 20ms | 80ms | 不访问网络和模型 |
| `job show`、`daemon status` | 20ms | 80ms | 使用有索引的点查 |
| 创建后台 Job 并返回 ID | 40ms | 100ms | 不在返回前执行慢任务 |

### 2.2 Tier 1：本地数据库点查

| 操作 | p50 目标 | p95 目标 |
| --- | ---: | ---: |
| `get <ID>` | 10ms | 50ms |
| `source show`、`topic show` | 20ms | 80ms |
| `trace` 单条证据链 | 30ms | 120ms |
| `connection events --limit 100` | 30ms | 100ms |
| Graph 一跳邻居 | 30ms | 100ms |

所有点查必须使用稳定 ID 和覆盖索引。禁止为展示一个对象加载整个领域集合。

### 2.3 Tier 2：本地检索

下列预算不包含首次 Query Embedding 的远程网络时间：

| 操作 | p50 目标 | p95 目标 | 数据规模 |
| --- | ---: | ---: | --- |
| FTS Top 20 | 30ms | 100ms | Medium 基准 |
| sqlite-vec KNN Top 50 | 50ms | 150ms | Medium 基准 |
| Graph 2 跳受限扩展 | 50ms | 150ms | Medium 基准 |
| Hybrid 融合与去重 | 80ms | 250ms | 不含远程 Embedding/重排 |
| 本地规则重排 | 30ms | 100ms | ≤ 100 个候选 |

检索预算必须拆阶段记录：

```text
query_parse_ms
query_embedding_ms
fts_ms
vector_ms
graph_ms
merge_ms
rerank_ms
hydrate_ms
total_ms
```

不能只记录总耗时，否则无法区分 SQLite、模型和网络瓶颈。

### 2.4 Tier 3：HTML 与 Artifact

必须区分“知识综合”和“HTML 渲染”：

```text
Topic Build/Refresh
  = 检索 + Claim 对齐 + LLM 综合 + Page IR
  = 慢任务

Artifact Render
  = 读取 Page IR + React 组件 + CSS/资源组装
  = 快任务
```

| 操作 | p50 目标 | p95 目标 |
| --- | ---: | ---: |
| `topic open` 打开 latest | 20ms | 100ms |
| 读取现有 Page IR | 20ms | 80ms |
| React 静态渲染普通报告 | 50ms | 200ms |
| 图表/图谱配置序列化 | 30ms | 150ms |
| 普通多文件 HTML 组装 | 100ms | 300ms |
| 普通单文件 HTML 组装 | 150ms | 500ms |
| 仅主题/CSS 重新 Render | 100ms | 400ms |

“普通报告”基准：

- ≤ 50 个 Section
- ≤ 1,000 个 Citation
- ≤ 500 个图谱节点
- ≤ 5MB 未压缩 Page IR
- 不在 Render 阶段访问模型或公网

超出普通报告规模时仍需线性、可取消地处理，并输出具体超限原因；不能无界加载和序列化。

### 2.5 Tier 4：模型交互

| 操作 | 性能要求 |
| --- | --- |
| Query Embedding 本地模型 | 目标 p95 ≤ 150ms，按具体模型基准调整 |
| Query Embedding 远程模型 | 受网络影响；必须单独显示耗时并缓存 |
| LLM Ask | 尽快流式输出；目标首个可展示事件 p95 ≤ 1.5s |
| Topic 深度综合 | 后台 Job，不设毫秒完成承诺 |
| Claim/Relation 抽取 | 后台批处理，有吞吐和成本预算 |

远程 Provider 延迟不能算作 SQLite 查询性能。`--trace` 必须明确分离本地执行和外部等待。

### 2.6 Tier 5：后台数据处理

以下工作默认异步：

- Source 首次归档
- Connection Initial Scan 和大规模 reconciliation
- 文档解析和 Chunking
- Embedding 批处理
- Graph/Claim enrichment
- Topic build/refresh
- 索引 rebuild
- Backup、Restore、Deep Verify、GC 和 Migration

它们的性能以吞吐、资源占用、可恢复性和对前台影响衡量，不以单次响应毫秒数衡量。

## 3. 基准数据规模

所有延迟指标必须注明数据规模，不能在空数据库上宣称“毫秒级”。

| Profile | Document | Chunk | Entity/Relation | 原始资料 | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| Small | 1,000 | 10,000 | 30,000 | 1GB | PR 和开发循环 |
| Medium | 20,000 | 200,000 | 600,000 | 20GB | 主要交互性能目标 |
| Large | 100,000 | 1,000,000 | 3,000,000 | 100GB | 容量、退化和架构决策 |

本文的 p95 交互指标默认以 Medium Profile 为准。Large Profile 用于验证是否平稳退化；在 sqlite-vec 稳定 ANN 能力不足时，不承诺 1,000,000 Chunk 仍满足 Medium 的 KNN 延迟。

达到 Large Profile 性能边界时，优先考虑：

- VectorSpace 和活跃/历史分区
- 项目、时间、类型等前置过滤
- 更小的候选集合和分层召回
- sqlite-vec 稳定 ANN 能力
- 可重建的专用索引

不能在没有基准证据时直接引入外部向量服务。

## 4. 基准硬件

性能预算至少在以下参考环境测量：

- 4 个现代 CPU Core
- 16GB RAM
- 本地 SSD/NVMe
- macOS arm64、Linux x64 和 Windows x64 中至少两类
- Release 编译后的 Self CLI
- 冷缓存和热缓存分别记录

结果必须附：

- Self/Bun/SQLite/sqlite-vec 版本
- 数据集 Profile 和 Hash
- 操作系统、CPU、内存和磁盘类型
- 是否冷启动
- 是否有后台 Index/Connection Job
- Query Embedding 和 Reranker 类型

## 5. CLI 响应原则

### 5.1 100ms 异步边界

命令如果无法稳定在约 100ms 内进入执行阶段，应：

1. 校验参数。
2. 计算幂等键。
3. 创建或复用 Job。
4. 持久化最小计划和 checkpoint。
5. 返回 `job_id`、状态和预估阶段。

```json
{
  "ok": true,
  "data": {
    "job_id": "job:job_123",
    "state": "queued"
  },
  "meta": {
    "accepted_in_ms": 47
  }
}
```

`--wait` 表示用户选择等待，不改变命令内部的 Job 模型。

### 5.2 禁止隐藏慢操作

以下只读命令禁止隐式触发：

- 模型调用
- Connection Scan
- FTS/Vector rebuild
- Topic refresh
- Migration
- 大型文件解析

例如 `self status` 只能显示 Connection stale，不能为了得到“最新状态”现场扫描所有目录。

### 5.3 渐进结果

Hybrid Search 可以：

1. 先完成 FTS。
2. 并行计算 Query Embedding。
3. 合并 Vector/Graph 候选。
4. 在 JSONL 或交互终端中发送阶段事件。

但最终 JSON envelope 只能在结果稳定后输出一次，不能混入进度日志。

### 5.4 `self --init` 交互性能

- Prompt 切换、路径校验和本地选项响应目标 p95 < 100ms。
- System Preflight 按组件逐项展示真实结果，不等待全部结束才刷新。
- Source 枚举先给快速估算，完整 Hash/归档进入 Job。
- 模型、Embedding、首次索引和 Graph Enrichment 都显示外部等待/后台进度，不能阻塞 UI 假装“初始化卡住”。
- 用户选择 Continue in Background 后，Wizard 应在 p95 100ms 内保存 Setup Session 并返回 Job/Resume 命令。
- `status --watch` 只读取持久 Read Model，刷新本身不触发 Scan、Model Test 或 Rebuild。

## 6. Query Embedding 策略

向量 KNN 通常很快，真正可能变慢的是把用户新 Query 转成向量。

优化顺序：

1. 对规范化 Query + Embedding Model ID 做缓存。
2. 同一个会话复用相同 Query Embedding。
3. FTS 与 Query Embedding 并行。
4. 提供本地 Embedding Model 作为低延迟选项。
5. 远程 Provider 设置连接复用、超时和有限重试。
6. `--mode text` 明确跳过 Embedding。
7. Provider 失败时可以返回带 warning 的 FTS/Graph partial，不能伪装成完整 hybrid。

Query Embedding Cache 必须位于 Self Root，Key 至少包含：

- 规范化 Query Hash
- 完整 VectorSpace `space_fingerprint`
- Model ID、Revision 和 Dimensions
- Query Instruction 与输入前处理版本

## 7. SQLite 查询规范

### 7.1 所有热点查询必须有索引

必须通过 `EXPLAIN QUERY PLAN` 验证：

- ID 点查
- Connection 到期调度
- pending Job/Batch
- Source → Revision → Chunk
- Claim → Evidence
- Topic/Artifact latest
- FTS 过滤
- VectorSpace 分区

在 Medium Profile 上出现意外全表扫描，视为性能缺陷。

### 7.2 避免 N+1

- 列表和报告一次批量加载关联对象。
- Citation Hydration 使用批量 ID 查询。
- 禁止在循环中逐条查询 Chunk、Claim 或 Entity。
- Drizzle 生成 SQL 仍需检查实际 Query Plan。

### 7.3 结果必须有上限

- Search 默认 20，硬上限由配置控制。
- Graph Traversal 必须限制 depth、node 和 edge。
- CLI List 使用 cursor pagination。
- Topic Build 使用分阶段候选预算。
- JSON 输出不能一次序列化百万行。

### 7.4 Prepared Statement

- 稳定热点 SQL 使用 cached prepared statement。
- 动态过滤使用参数绑定，不拼接用户输入。
- 大量写入使用受控批次和短事务。
- 批次大小由 Benchmark 确定，不使用无界事务。

## 8. HTML 性能规范

### 8.1 Render 禁止做的事

Artifact Render 阶段禁止：

- 调用 LLM 或 Embedding
- 查询外部网页
- 重新抽取 Claim
- 重新做完整 Retrieval
- 扫描所有 Source
- 现场生成大型图片模型结果

Renderer 的输入必须是完整 Page IR、Theme 和本地资源。

### 8.2 Page IR 组件化缓存

每个 Section/Component 记录：

- Component Type
- Content Hash
- Dependency Hash
- Renderer Version
- Theme Version

未变化组件复用结构化数据；最终 HTML 通常可以完整快速重编译，以保证一致性。不要为了局部写 HTML 而制造难以验证的 DOM Patch 历史。

### 8.3 资源策略

- CSS 和 client island 以内容 Hash 命名。
- 相同资源在 Artifact Build 中去重。
- 图片按需生成缩略图，不在打开页面时现场处理。
- 大型图谱默认分层/分页，不一次渲染全部节点。
- 单文件 HTML 超过配置上限时提示使用多文件输出。

### 8.4 打开优先

用户请求 Topic 时：

1. 立即打开 latest 已完成 Build。
2. 如果 stale，显示更新时间和原因。
3. 后台创建 refresh Job。
4. 新 Build 成功后原子更新 latest。

不能让用户为了新资料等待旧页面也无法打开。

## 9. 后台索引与前台查询隔离

### 9.1 Shadow Build

FTS、Vector 和 Graph 大规模重建采用：

```text
旧索引继续服务
  → 新索引在独立版本/表构建
  → 校验数量、Hash 和查询样本
  → 短事务原子切换 active version
  → 延迟清理旧索引
```

禁止在重建开始时删除当前可用索引。

### 9.2 增量优先级

后台调度优先级建议：

1. 用户当前命令依赖的小范围 Query Embedding
2. 新近修改文件的增量索引
3. Topic 用户主动 refresh
4. 普通 Connection Batch
5. 全量 Graph enrichment
6. 低优先级 Rebuild、Verify 和 GC

高优先级不能饿死低优先级；调度器使用配额和 aging。

### 9.3 Backpressure

- Job Queue 设置最大 pending 数。
- Embedding 按 Provider 并发和 Token 预算限流。
- Connection 大批变化拆成可恢复 Batch。
- 内存队列满时落盘或触发 reconciliation，不无限增长。
- 系统资源不足时降低后台并发，不牺牲交互查询。

## 10. Connection Daemon 性能边界

| 指标 | 目标 |
| --- | --- |
| 空闲 CPU | p95 < 1% 单 Core |
| 空闲 RSS | 目标 < 150MB |
| 原生事件 Callback | < 5ms，只入队不 Hash |
| 单文件变化进入 Scan | 防抖后 p95 < 2s |
| 小文件变化完成 Snapshot | 本地 SSD p95 < 5s，不含模型 |
| 无变化 reconciliation | 与文件数线性，避免读取完整内容 |
| Daemon Heartbeat | 默认 15s，避免高频 WAL 写入 |

策略：

- 原生事件只做提示。
- metadata 无变化不读取文件内容。
- 完整 Hash 默认按 24h 分散执行，不集中在同一时刻。
- 多 Connection schedule 增加 jitter，避免同时扫描。
- 机器休眠时停止无意义轮询，恢复后合并成一次 reconciliation。
- 电池模式可以降低后台并发，但不能关闭最终对账而不提示。

## 11. 内存边界

- 文件解析优先使用 Stream/Iterator，禁止默认 `readAll` 大文件。
- 单个文件超过 `max_file_bytes` 时进入 ignored 或专用流式解析器。
- Search Candidate、Graph Expansion、Citation 和 Page IR 全部设硬上限。
- Embedding 批次使用固定窗口，不把全部 Chunk Vector 同时放入内存。
- Worker 传递结构化批次或文件引用，不复制大型 Buffer。
- JSON/JSONL 大输出使用流式编码。
- 处理结束及时释放 PDF、DOM 和模型上下文对象。

任何可能由用户数据控制长度的 Array、Map、Queue 都必须有上限或分页策略。

## 12. 缓存边界

允许缓存：

- Query Embedding
- Prepared Statement
- 解析器静态资源
- Template/Theme 编译结果
- Page IR Component
- 已验证的 Source Blob Hash

每个缓存必须明确：

- Key
- Value
- 最大大小
- 失效条件
- 所属目录/表
- 是否可安全删除和重建

禁止：

- 无上限内存缓存
- 只以文件路径不含内容 Hash 作为内容缓存 Key
- 跨 Embedding Model 复用向量
- 使用缓存掩盖 stale/failed 状态
- 将 Root 外全局缓存作为运行必需数据

## 13. 性能观测

### 13.1 Trace

所有关键命令支持 `--trace`，返回：

- 各阶段耗时
- SQLite Query 数
- 扫描/读取/Hash 字节数
- Cache hit/miss
- 模型和网络等待
- Candidate 数与裁剪数
- Job 排队时间
- HTML Component 数和输出大小

默认日志记录聚合性能，不记录私人 Query 和正文。

### 13.2 慢操作日志

建议阈值：

- SQLite 单 Query > 100ms
- 本地点查命令 > 200ms
- Hybrid 本地阶段 > 500ms
- Artifact Render > 1s
- Event Callback > 20ms
- Job Queue 等待超过配置 SLO

慢日志包含 Query/Operation 名称和 Query Plan Hash，不直接记录敏感参数。

### 13.3 性能命令

规划命令：

```bash
self doctor --performance
self perf benchmark --profile small
self perf benchmark --profile medium --suite retrieval
self perf explain operation:op_123
self perf stats --since 24h
```

Benchmark 写入 `.test-runs/` 或 Root 内显式 performance 目录，不污染业务数据。

## 14. 性能测试机制

### 14.1 PR

- 关键函数 microbenchmark 只检测灾难性退化。
- Small Profile 执行 FTS、Vector、Hybrid 和 Render smoke。
- 不用共享 CI 主机的一次绝对数字直接阻断 PR。

### 14.2 Nightly

- 固定机器或稳定 Runner。
- Medium Profile 冷/热缓存基准。
- Connection 24h 变化模拟。
- Background Index 与前台 Query 并发。
- HTML Render 和 Playwright 打开时间。

### 14.3 Release

- Small/Medium 全套。
- Large 容量与退化趋势。
- 所有目标平台的 compiled binary。
- 与最近 Release 比较 p50、p95、吞吐、内存和磁盘。

### 14.4 回归门禁

在固定 Runner 和相同数据集下：

- 关键 p95 退化超过 20%：默认阻止发布并调查。
- 内存增长超过 20%：默认阻止发布并调查。
- 出现非预期全表扫描：阻止发布。
- Render 引入模型/网络：直接阻止合并。
- 后台构建导致现有 Search 不可用：直接阻止发布。

可以更新基线，但必须解释数据、算法或质量收益，不能只抬高阈值掩盖回归。

## 15. 性能与正确性的优先级

性能优化不能破坏：

- Source Snapshot 证据完整性
- Claim 引用和可信度
- 增量与全量重建等价性
- Plan/Apply 安全边界
- SQLite 事务和崩溃恢复
- Root 单目录约束
- HTML 安全清理

禁止为了速度：

- 跳过内容 Hash 和版本检查
- 在 Source 未稳定时归档半文件
- 静默丢弃变化或 partial 错误
- 让缓存成为唯一数据副本
- 关闭 fsync/事务而没有恢复设计
- 把用户知识上传到未授权服务
- 降低 Citation 校验标准

正确性是硬约束，性能是在硬约束内优化。

## 16. 分阶段性能验收

### Search Alpha

- Medium FTS/Vector/Hybrid 本地阶段满足 Tier 2 p95。
- Query Embedding 耗时被独立显示。
- Connection 后台工作不阻塞 Search。
- 无意外全表扫描和无界 Candidate。

### Knowledge Alpha

- Ask 在 Provider 可用时流式返回阶段事件。
- Citation Hydration 无 N+1。
- Graph 受限扩展满足预算。

### MVP

- `topic open` 立即打开 latest。
- 已有 Page IR Render 满足 Tier 3 p95。
- Topic Refresh 在后台运行，旧 Build 持续可用。
- HTML 离线打开和交互性能通过浏览器测试。

### v1.0

- Medium Profile 所有交互预算稳定。
- Large Profile 平稳退化且无内存失控。
- 24h Daemon、索引和查询并发长稳通过。
- 性能 Trace、慢日志和诊断命令可用。

## 17. 第一阶段实施清单

1. 为 CLI Main、Root Config 和 SQLite Open 建立 cold-start benchmark。
2. 建立 Small/Medium 可重复 Fixture Generator。
3. 为 FTS、sqlite-vec 和 Hybrid 分阶段计时。
4. 实现 Query Embedding Cache。
5. 为热点 SQL 保存 EXPLAIN QUERY PLAN Golden。
6. 实现有上限的 Candidate、Graph 和 Citation Hydration。
7. 将所有慢任务统一为可快速接受的 Job。
8. 建立旧索引服务与 Shadow Rebuild。
9. 为 Page IR → HTML 建立独立 Render Benchmark。
10. 为 Connection Daemon 建立 idle CPU/RSS 和变化延迟基准。
11. 将 Heartbeat 默认调整为 15s、Lease 为 45s，并测试接管延迟。
12. 在固定 Nightly Runner 建立版本趋势报告。

性能目标不是最后再做的优化项。每个领域在实现第一条真实 Workflow 时，就必须同时建立该 Workflow 的阶段计时、上限和基准。
