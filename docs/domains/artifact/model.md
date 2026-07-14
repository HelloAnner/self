# Artifact 模型

## 1. 聚合

`Artifact` 是长期身份，当前首种类型为 `topic_report`。它绑定一个 Topic、稳定 slug、状态和 `latest_build_id`。`Build` 是一次不可变编译，保存父 Build、TopicSnapshot、构建类型、Page IR/Template/Theme/Renderer 版本、依赖 Hash、文件 Hash 和耗时。

状态：

```text
Build: building -> ready
                -> failed

Artifact: stale -> ready -> stale
                    |       |
                    +-> failed/deleted（后续安全流程）
```

ready Build 不允许 UPDATE/DELETE；失败 Build 可由后续恢复/GC 流程处理，但不得冒充 ready。

## 2. Page IR v1

Page IR 的权威标识为 `schema=self.page-ir, version=1`。它只包含可序列化数据：

- Artifact/Build/Parent/BuildKind
- Topic/Snapshot/Scope/Health/Confidence/Coverage
- Template 和 Theme 版本
- 有序 Component 数组
- 去重 Citation 数组

组件类型固定为：`hero`、`conclusion_cards`、`evidence_blocks`、`timeline`、`comparison_matrix`、`knowledge_graph`、`conflicts`、`knowledge_gaps`、`source_directory`。Page IR 不允许 `raw_html`、可执行脚本或远程资源节点。

每个 Component 保存：

- 稳定 `key` 和类型
- 关联 Topic Section ID（只用于 Trace，不参与内容身份）
- `content_hash`：结构化 payload 的 SHA-256
- `dependency_hash`：稳定 Claim/Chunk/Citation/Entity/Relation 依赖的 SHA-256
- Confidence/Health 投影

Citation 的页面 ID由 `Claim + Chunk + excerpt_hash` 确定，因此 TopicSnapshot 换代时未变化证据仍可复用；同时保留本次 `topic_citation_id`、Claim、Chunk、Revision、Snapshot 和 Source ID。

## 3. Template 与 Theme

Template 决定 Page IR 到页面结构的映射，Theme 只决定可信本地 CSS。二者独立版本化和 Hash。Phase 8 内置 `knowledge-atlas@1.0.0`、`self-light@1.0.0` 和 `knowledge-atlas-react-v1`。

React 只用于 `renderToStaticMarkup`。来源文本一律作为 React 文本子节点，禁止 `dangerouslySetInnerHTML`。知识图谱使用有限节点的静态 SVG，不执行来源提供的标签、URL 或脚本。

## 4. BuildManifest

Manifest 固化 Build/Parent/Kind、request/knowledge/Page IR/content Hash、Topic Synthesis 和 Retrieval 水位、模型/Prompt 投影、Template/Theme、组件 Hash、Document/Revision/Chunk/Claim/Entity/Relation 依赖以及全部归档文件的 Hash/大小/媒体类型。

它足以回答：输入是否变化、哪些组件可复用、页面能否重现、历史文件是否完整。Manifest 不保存密钥、私有模型思维过程或外部绝对业务路径。
