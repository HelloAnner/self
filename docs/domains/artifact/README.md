# Artifact 领域

> 状态：Phase 8 MVP 与 Phase 9 安全生命周期已实现，Schema 10 / Page IR v1

Artifact 把 Topic 的可信知识快照编译为可保存、可比较、可重新渲染的离线页面。它拥有 Page IR、Template、Theme、Artifact、Build、Manifest、文件归档和 Export；不生成 Topic 结论，也不把派生页面重新当作事实来源。

## 已实现能力

- `self.page-ir` v1 及严格组件类型校验。
- `knowledge-atlas` React 静态模板和 `self-light` 本地主题。
- Hero、结论卡、证据块、时间线、对比矩阵、SVG 局部图谱、冲突、未知项和资料目录。
- Schema 9 Artifact/Build/Dependency/Component/File/Export 注册。
- 每次 Build 完整归档 request、retrieval、knowledge snapshot、Page IR、confidence、changes、citations、Manifest、HTML 和内容 Hash。
- 多文件与单文件离线 HTML、Markdown/JSON Export、History、Diff、Open 和纯 Render。
- ready Build 及子记录不可变；新 Build 完成后才切换 SQLite latest 和 Root-local `latest.json`。
- 组件级内容/依赖 Hash；Refresh 只重建受影响组件，纯 Render 复用全部 Page IR 组件数据。
- MVP 图形使用有限原生 HTML/CSS/SVG，无图表脚本运行时；ECharts/Cytoscape 只在后续交互规模需要且通过历史/离线 Gate 后引入。
- Artifact delete/restore 通过通用 Plan/Operation/Audit 执行；软删除不修改或移除任何历史 Build 文件。

## 详细设计

- [model.md](./model.md)：聚合、Page IR 和不变量
- [schema.md](./schema.md)：Schema 9 表、索引、触发器和文件布局
- [workflows.md](./workflows.md)：Build、Refresh、Render、Publish 和 Export
- [commands.md](./commands.md)：Topic/Artifact/Template CLI 与错误语义
- [testing.md](./testing.md)：离线浏览器、安全、迁移、性能和真实 CLI 门禁

## 边界

- Topic 领域决定结论、可信度、引用和 KnowledgeGap；Artifact 只消费稳定 Read Model。
- Renderer 只消费完整 Page IR、Theme 和本地资源，不直接查询 SQLite 或调用模型。
- 用户显式 Export 可以位于 Root 外；内部 Build 永远保留在 Root 相对路径下。
- Artifact 是派生结果，不会自动进入 Source/Ingestion。
