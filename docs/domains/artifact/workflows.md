# Artifact 工作流

## 1. Topic Build / Refresh

```text
TopicSnapshot ready
  -> 读取 Topic Report Read Model
  -> 固化 Synthesis/Retrieval/Knowledge 输入
  -> 创建 Artifact Build(building)
  -> 生成并校验 Page IR v1
  -> 计算依赖与组件 Hash
  -> React 静态渲染 + 本地 CSS
  -> 写完整临时归档并校验 Hash
  -> rename 发布 Build 目录
  -> 单事务写依赖/组件/文件并置 ready
  -> 切换 Artifact.latest_build_id
  -> 原子更新 topic.json/latest.json
```

任何 Citation excerpt Hash 不匹配都会在渲染前失败。失败 Build 保留错误，旧 latest 和旧 HTML 继续可用。

## 2. 增量 Refresh

Topic 当前为 active 且已有 latest Snapshot 时，重复 `topic refresh` 直接返回现有 Snapshot/Build，`retrieval_skipped=true`，不新增 Build。Topic stale/needs_review 时重新检索当前范围并比较 Claim/Section 内容；Knowledge/Ingestion 已负责仅处理变化 Chunk。

新 TopicSnapshot 为每个 Section 保存 added/modified/unchanged；Page IR 使用稳定组件 key、Claim/Chunk/Citation 依赖 Hash与父 Build 比较。未变化组件记录 `reused_from_build_id`，只重建受影响组件。HTML 仍完整快速重编译，以避免 DOM Patch 历史和页面内部不一致。

若 Schema 8 旧 Root 已有 active TopicSnapshot 但尚无 Artifact，Refresh 仍跳过知识检索，只创建第一个 Build。

## 3. 纯 Render

`artifact render TOPIC` 读取已有 TopicSnapshot/Page IR 输入，创建 `build_kind=render` 的新 Build。它不创建 RetrievalRun、SynthesisRun 或 TopicSnapshot。模板/主题不兼容时明确失败；兼容样式变化可复用组件数据并仅重新生成 HTML/资源。

## 4. History、Diff、Open

History 沿 parent Build 返回每次知识/模板/主题和 Hash。Diff 按稳定组件 key报告 added/removed/modified/unchanged，并单独指出 knowledge 和 template/theme 是否变化。

Open 只解析 SQLite latest 并检查 Root 内 index.html；若页面 stale，旧 Build 仍可立即打开。CLI 测试用 `SELF_NO_OPEN=1` 禁止启动系统应用，生产默认调用当前平台 opener。

## 5. Export

- 多文件 HTML：复制 `index.html` 和 `assets/`。
- 单文件 HTML：从归档 Page IR 重新静态渲染并内联可信 Theme CSS。
- Markdown/JSON：从归档 Page IR 确定性导出。

Export 不修改内部 Build。目标已存在时返回冲突，不静默覆盖。只有显式 `--output` 可以写 Root 外；默认目标为 `artifacts/exports/`。
