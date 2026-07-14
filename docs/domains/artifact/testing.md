# Artifact 测试

## 必须门禁

- Page IR Schema 拒绝未知组件、重复 key 和无效 Citation Hash。
- 编译后二进制真实 CLI 创建 Artifact，验证完整目录、Manifest 文件 Hash和 ready 不可变 Trigger。
- 新增一个相关 Source 后，Refresh 同时出现受影响组件 rebuilt 与未影响组件 reused。
- 第二次 Refresh `retrieval_skipped=true`，不增加 TopicSnapshot 或 Build。
- 纯 Render 不新增 Retrieval/Synthesis/TopicSnapshot，全部组件复用。
- 历史 Build、latest 和 Diff 同时可读；Export 目标冲突不覆盖。
- 多文件 HTML 的所有资源存在且为相对路径；单文件 HTML 无 stylesheet 依赖。
- Chromium 设置 offline 后可打开页面、展开可信度/证据，HTTP(S) 请求数为 0。
- 来源中的 `<script>` 只显示为 `&lt;script&gt;`，全局副作用不存在。
- 整体移动 Self Root 后，CLI status 和历史 HTML 仍可用。
- Schema 8→9 使用 Plan/Apply 和 Root-local backup。

## 性能预算

按 `performance.md`：topic open p95 ≤100ms，Page IR 读取 p95 ≤80ms，普通 React 静态渲染 p95 ≤200ms，多文件组装 p95 ≤300ms，单文件组装 p95 ≤500ms。Render 不访问模型或公网。

## 真实数据

Phase 8 在忽略提交的 `data/` 对已归档的真实 `~/notes` Topic 执行 Schema 8→9 Plan/Apply。FAISS Topic 在 active 状态下跳过检索，从既有真实 Snapshot 创建 7 组件、4 Citation 的离线 Build；模型 offline 保持 true。提交证据只保存聚合计数、Hash和性能，不保存正文、原始路径或凭证。

Phase 9 在同一忽略提交的真实 Workspace 上执行 Schema 9→10、Doctor 和 Connection dry-run，然后创建、Show、Diff、Cancel 一个 Artifact Delete Plan。Plan 从未 Apply，ready Artifact 状态保持不变。合成 E2E 另行验证 Artifact Delete/Restore/Undo 保留全部不可变 Build、Page IR、Manifest 与离线文件。
