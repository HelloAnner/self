# Self Roadmap 索引

Roadmap 使用按日期版本化的执行文件。它不是需求愿望清单，而是实现者每天可以依次执行、检查和留下证据的工作手册。

## 当前 Roadmap

| 日期 | 状态 | 范围 | 文件 |
| --- | --- | --- | --- |
| 2026-07-11 | active | Phase 0～9 完成；Phase 10 主体与本机 v1.0.0 RC Gate 完成，待 24h Soak、五平台 CI 与外部发布确认 | [`2026-07-11-initial-implementation.md`](./2026-07-11-initial-implementation.md) |

## 文件规则

- 除本索引外，计划文件统一命名为 `YYYY-MM-DD-<short-description>.md`。
- `<short-description>` 使用小写英文 kebab-case，简要说明范围，例如 `initial-implementation`、`graph-query`、`topic-refresh`。
- 同一天可以有多个不同范围的 Roadmap，但同一范围只维护一个文件，不能用 `v2-final-final` 命名。
- 新的一天或新的版本迭代创建新的日期文件，并在开头声明 `parent` 和从上一计划结转的未完成项。
- 历史 Roadmap 不删除、不改名，不把未完成工作静默标记完成。
- 新功能进入最近日期的 Roadmap；稳定的领域规则仍写入 Architecture/Domain 文档，不能只存在于 Roadmap。
- `active`、`completed`、`superseded`、`cancelled` 是索引状态；`superseded` 必须指向替代文件。

## 执行方式

1. 打开当前日期文件，先阅读“开始前必读”和当日范围。
2. 严格按 Workstream/Phase 顺序实现；硬依赖未通过时不进入下一阶段。
3. 每完成一个 Step，运行该 Step 的验证命令并保存证据。
4. 只有阶段 Exit Gate 全部通过，才能把阶段从 `pending` 改为 `completed`。
5. 当天结束时填写完成项、未完成项、阻塞、性能基线和下一日期计划。

## 状态约定

```text
pending → in_progress → completed
                   └──→ blocked
```

- `completed`：代码、测试、文档和验收证据全部完成。
- `blocked`：记录具体阻塞、已尝试方案和解除条件，不能用它表示“还没开始”。
- 一个时间只应有一个 Workstream 标记 `in_progress`。

## Roadmap 与设计文档的边界

- [`../architecture.md`](../architecture.md)：系统和 CLI 的权威设计。
- [`../design-conventions.md`](../design-conventions.md)：术语、ID、状态和所有权。
- [`../engineering-standards.md`](../engineering-standards.md)：代码、构建、配置和部署红线。
- [`../performance.md`](../performance.md)：延迟、吞吐、内存和性能门禁。
- [`../testing.md`](../testing.md)：测试框架、真实 CLI 和 Release 门禁。
- [`../domains/`](../domains/)：各领域模型、Schema 和工作流。

Roadmap 只能安排和验证实现，不得在这里另造一套与权威设计冲突的语义。
