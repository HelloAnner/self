# Artifact Schema

> 实现版本：Schema 9，迁移文件 `drizzle/0009_artifact_builds.sql`

## 1. 表所有权

| 表 | 作用 |
| --- | --- |
| `artifact_templates` | Template ID、版本、Page IR 版本、Hash 和 Root 相对路径 |
| `artifact_themes` | Theme ID、版本、Hash 和 Root 相对路径 |
| `artifacts` | 长期 Artifact、Topic 绑定、slug、状态和 latest 指针 |
| `artifact_builds` | 不可变构建头、父链、TopicSnapshot、版本和总 Hash |
| `artifact_build_dependencies` | Document/Revision/Chunk/Claim/Entity/Relation/Template/Theme 依赖 |
| `artifact_build_components` | 组件 payload、内容/依赖 Hash 和复用来源 |
| `artifact_build_files` | Build 内每个文件的 SHA-256、字节数、媒体类型和角色 |
| `artifact_exports` | 用户显式 Export 的目标、格式、Build 和结果 Hash |

Artifact 是这些表的唯一写入者。Topic 只通过 Application 提供 TopicSnapshot Read Model。

## 2. 不变量和索引

- 一个活动 Topic 至多一个 Artifact；slug 和 Build relative_directory 唯一。
- Build 必须引用 TopicSnapshot、Template、Theme，并保存父 Build。
- ready Build 的头、依赖、组件和文件由 Trigger 拒绝 INSERT/UPDATE/DELETE。
- Dependency 使用 `(build, kind, id, role)` 唯一；组件 key/ordinal 和文件 path 在 Build 内唯一。
- Artifact latest 只指向成功发布的 ready Build；查询按 `(artifact_id, created_at DESC)` 命中历史索引。
- 所有 JSON 列通过 `json_valid`，所有内容身份为 64 位 SHA-256。

## 3. Root 文件布局

```text
artifacts/topics/<slug>/
├── topic.json
├── latest.json
└── builds/<utc>_<build-hash>/
    ├── manifest.json
    ├── request.md
    ├── query-plan.json
    ├── retrieval.json
    ├── knowledge-snapshot.json
    ├── page.ir.json
    ├── confidence.json
    ├── changes.json
    ├── citations.json
    ├── index.html
    └── assets/<theme-hash>.css
```

Build 先写入 `runtime/tmp/artifact-*`，完整成功后同文件系统 rename 到目标目录。`latest.json` 使用临时文件、fsync 和 rename 原子替换；内部路径全部保存为 Root 相对路径。

## 4. 迁移

Schema 8→9 通过现有 Migration Plan/Apply 执行，先保存 Root-local 数据库备份。旧 TopicSnapshot 不改写；第一次 `topic refresh` 若输入未失效，会跳过检索并直接从旧 Snapshot 创建首个 Artifact Build。
