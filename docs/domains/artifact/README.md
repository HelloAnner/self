# Artifact 领域

> 状态：待详细设计

## 目标

Artifact 将知识和 Topic 报告编译为可保存、可比较、可重新渲染的 HTML、Markdown、JSON、图片和图表产物。

## 负责范围

- Page IR Schema 和兼容性版本
- 页面组件、模板和主题注册
- Artifact 与 Build 生命周期
- 输入快照、依赖清单和构建 Manifest
- HTML 渲染、资源打包和单文件输出
- Build 历史、父子关系和版本 Diff
- Artifact 导出、打开、软删除和恢复
- 模板变化下的纯重新渲染

## 核心对象

- `Artifact`：一个长期产物身份
- `Build`：一次不可变构建
- `PageIR`：知识表达与视觉渲染之间的中间表示
- `Template`：页面结构规则
- `Theme`：样式、字体和展示资源
- `BuildManifest`：模型、模板、知识和文件依赖
- `Export`：用户显式发布到目标位置的副本

## 关键不变量

- 每个 Build 不可变并保留父 Build。
- 最终页面中的关键陈述必须保留 Citation 映射。
- `latest` 只在新 Build 完整成功后原子切换。
- 纯样式变化可以复用 Page IR，不触发知识综合。
- 内部归档不能因用户导出文件被移动或删除而失效。

## 不负责

- Topic 知识结论的生成
- Source 和 Chunk 生命周期
- 模型供应商选择
