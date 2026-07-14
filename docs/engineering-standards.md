# Self 工程规范：实现、构建、运行与部署

> 状态：强制工程基线
> 适用范围：Self 的 TypeScript 源码、SQLite、CLI、模型调用、Artifact、构建产物和部署包
> 关联文档：[总体架构](./architecture.md) · [技术选型](./technology-stack.md) · [性能边界](./performance.md) · [模型选择](./model-selection.md) · [开源分发](./distribution.md) · [测试机制](./testing.md)

## 1. 规范目的

本文件回答四个问题：

1. Self 的代码应该如何拆分和实现？
2. 哪些写法和架构行为绝对不允许？
3. Self 如何读取单目录中的 `self.toml` 并安全运行？
4. 如何从源码构建、打包、部署和升级一个可用的本地 CLI？

本文使用以下强度词：

- **必须**：违反即视为缺陷，不能合并或发布。
- **禁止**：红线，不得以“临时实现”为理由绕过。
- **应该**：默认执行；偏离时需要在代码审查中说明原因。
- **可以**：根据实际场景选择。

## 2. 最核心的工程约束

### 2.1 一个实例，一个根目录

一个 Self 实例由根目录中的 `self.toml` 唯一标识。除 CLI 二进制本身和用户显式导出的文件外，运行期业务数据必须全部位于该根目录。

```text
<self-root>/
├── self.toml
├── content/
├── data/
├── artifacts/
├── templates/
├── models/
├── runtime/
└── backups/
```

禁止隐式写入：

- `~/.self`
- `~/.config/self`
- `~/Library/Application Support/self`
- 系统临时目录
- 当前工作目录中的未知位置
- Bun、npm 或操作系统的全局缓存作为业务存储

如果命令需要临时文件，必须写入 `<self-root>/runtime/tmp/`。日志写入 `<self-root>/runtime/logs/`，锁写入 `<self-root>/runtime/locks/`，Job 状态写入根目录中的 SQLite 和 `runtime/jobs/`。

### 2.2 原始资料、知识底座和 Artifact 分离

- 原始资料保存在 `content/`，作为证据和重建输入。
- 规范内容、Chunk、向量、图谱和状态保存在 `data/self.sqlite3`。
- HTML、报告、Page IR 和 Build 归档保存在 `artifacts/`。
- 任何层都不能把未经确认的 AI Artifact 当作原始事实再次摄入。

### 2.3 模块化单体

Self 第一阶段只有一个模块化单体二进制和一个 SQLite 文件。该二进制可以按次执行 CLI Command，也可以按用户选择以 Connection Daemon 模式运行；两种模式共享相同领域代码、锁和事务规则。领域目录是代码和数据所有权边界，不是拆服务的理由。

禁止为了“架构先进”提前引入：

- 微服务
- 独立向量数据库
- 图数据库
- Redis 和外部任务队列
- 常驻 Web Server
- 全局依赖注入容器

只有真实性能、隔离或扩展证据才能触发架构变更，并且必须先写 ADR。

## 3. 代码目录和依赖方向

### 3.1 推荐目录

```text
src/
├── cli/
│   ├── main.ts
│   ├── commands/
│   ├── presenters/
│   └── protocol/
├── application/
│   ├── commands/
│   ├── queries/
│   └── workflows/
├── domains/
│   ├── workspace/
│   ├── connection/
│   ├── source/
│   ├── ingestion/
│   ├── knowledge/
│   ├── graph/
│   ├── retrieval/
│   ├── topic/
│   ├── artifact/
│   ├── model/
│   ├── automation/
│   └── operations/
├── infrastructure/
│   ├── db/
│   ├── filesystem/
│   ├── models/
│   ├── parsers/
│   ├── watchers/
│   ├── web/
│   └── logging/
├── renderer/
│   ├── page-ir/
│   ├── components/
│   ├── client/
│   └── themes/
└── shared/
    ├── ids/
    ├── errors/
    ├── result/
    ├── time/
    └── schema/
```

### 3.2 允许的依赖方向

```text
CLI ───────────────┐
                   ▼
Renderer ──→ Application ──→ Domain
                   ▲           ▲
                   │           │
Infrastructure ────┴───────────┘（只实现 Domain/Application 定义的 Port）
```

具体规则：

- Domain 不得 import Application、CLI、Infrastructure、React、Drizzle、Commander 或 AI SDK。
- Application 可以依赖多个 Domain 的公开 API，但不能依赖 CLI Presenter。
- Infrastructure 实现 Domain/Application 定义的 Port，不向 Domain 暴露 SDK 类型。
- CLI 只做解析、鉴权/确认、调用 Application 和输出转换。
- Renderer 只消费 Page IR 或稳定 Read Model，不直接查询领域内部表。
- Shared 只放真正跨领域、无业务归属的基础类型；不能成为杂物目录。

### 3.3 领域公开 API

每个领域只通过明确入口暴露能力：

```text
domains/source/
├── index.ts              # 对外公开的类型和 Port
├── model/
├── services/
├── events/
├── errors.ts
└── internal/             # 领域外禁止 import
```

禁止跨领域深层 import：

```ts
// 禁止
import { SourceRow } from "#self/domains/source/internal/source-row.ts";

// 允许
import { type Source, SourceId } from "#self/domains/source/index.ts";
```

`index.ts` 只用于领域边界，禁止建立整个项目的巨大 barrel file。循环依赖必须通过重新划分职责或领域事件消除，不能使用动态 import 掩盖。

## 4. 文件、函数和复杂度限制

### 4.1 单文件限制

生产源码使用以下强制上限，按非空、非纯注释逻辑行计算：

| 类型 | 目标 | 警告线 | 硬上限 |
| --- | --- | --- | --- |
| 普通 `.ts` 文件 | ≤ 250 行 | 300 行 | 500 行 |
| React `.tsx` 组件 | ≤ 200 行 | 250 行 | 400 行 |
| 单个测试文件 | ≤ 350 行 | 500 行 | 800 行 |
| 单个函数/方法 | ≤ 40 行 | 60 行 | 80 行 |

超过警告线必须在代码审查中说明拆分计划。超过硬上限禁止合并。

允许不受普通源码硬上限约束的文件：

- 自动生成代码
- 已提交的 SQL Migration
- 测试 Fixture 和 Golden 数据
- 纯 Schema 常量
- 模板静态数据

例外文件必须包含生成来源或用途说明，且不能隐藏业务流程。禁止通过压缩格式、超长单行或移除空白规避行数检查。

仓库应提供 `scripts/check-size.ts`，在 `bun run check` 中强制执行。

### 4.2 函数复杂度

- 嵌套层级应该不超过 4 层。
- 参数超过 5 个时改用命名参数对象。
- 一个函数只能承担一个可命名职责。
- 一个 Command Handler 不得同时负责解析参数、业务决策、SQL 和输出格式化。
- 超过两个独立失败阶段的流程应拆为明确 Step 或 Workflow。
- 大型 `switch` 应使用穷尽检查；不得有无解释的 default 分支吞掉新状态。

### 4.3 文件拆分依据

按职责拆分，不按“每个函数一个文件”拆分。一个功能通常包含：

```text
source-add/
├── spec.ts               # Zod 输入输出和命令元数据
├── handler.ts            # Application 调用
├── presenter.ts          # human/json 输出
└── source-add.test.ts
```

以下信号说明必须拆分：

- 文件同时出现领域规则、SQL 和 CLI 文案。
- 修改一个功能经常触碰无关代码。
- 测试只能通过大量全局 mock 才能执行。
- 文件中出现多个不同原因导致的变化。
- 类型、流程、序列化和 UI 混在一起。

## 5. TypeScript 实现规范

### 5.1 类型规则

- 必须保持 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。
- 禁止使用显式 `any`；外部不可信值使用 `unknown` 并通过 Zod 或类型守卫校验。
- 禁止用 `as SomeType` 代替运行时校验。
- 非空断言 `!` 只允许在已由同一作用域明确验证的极少数边界使用。
- 领域状态使用 discriminated union，不使用互相矛盾的多个 boolean。
- ID 使用 branded type 或不可误用的封装，禁止所有 ID 都退化为普通 string。
- 时间统一使用 UTC ISO 8601 字符串或明确的 Epoch 类型，不混用本地时间。
- 数据库 Row、领域 Entity、CLI DTO 和 JSON 输出类型必须分离。

示例：

```ts
type SourceState =
  | { kind: "registered" }
  | { kind: "syncing"; jobId: JobId }
  | { kind: "ready"; revisionId: RevisionId }
  | { kind: "failed"; error: SourceFailure };
```

禁止：

```ts
type SourceState = {
  isReady: boolean;
  isSyncing: boolean;
  isFailed: boolean;
};
```

### 5.2 导出和命名

- 默认使用 named export，禁止无必要的 default export。
- 文件名使用 `kebab-case.ts`，类型和类使用 `PascalCase`，函数和变量使用 `camelCase`。
- boolean 使用 `is/has/can/should` 前缀。
- Command、Event、Error 使用明确业务动词，如 `AddSource`、`SourceSnapshotCreated`。
- 禁止 `utils.ts`、`helpers.ts`、`common.ts` 持续膨胀；工具应按具体职责命名。
- 缩写只允许行业稳定缩写，如 `CLI`、`SQL`、`FTS`、`URL`、`ID`。

### 5.3 Side Effect

模块 import 时禁止：

- 打开数据库
- 读取配置
- 访问网络
- 创建目录或日志文件
- 注册全局进程监听器
- 启动 Worker 或 Timer

所有副作用都在 Composition Root 或明确 Application Workflow 中发生。Clock、ID、文件系统、模型和网络均通过 Port 注入，以支持确定性测试。

### 5.4 注释

注释解释“为什么”和约束，不复述代码。以下情况必须注释：

- 不直观的 SQLite 行为
- 缓存失效规则
- 兼容旧格式的分支
- 安全边界和路径校验
- 算法取舍和已知限制

禁止保留没有 issue/计划关联的长期 `TODO`。临时 workaround 必须记录删除条件。

## 6. 领域与应用服务规范

### 6.1 Domain

Domain 中只能包含：

- 聚合、实体和值对象
- 领域服务
- 领域错误
- 领域事件
- Repository/Port 接口
- 纯业务不变量

Domain 禁止知道：

- SQLite 表名
- 文件绝对路径
- 模型供应商名称
- CLI flags
- HTTP 状态码
- React 组件

### 6.2 Application

Application Service 负责用例和跨领域编排：

```text
校验命令意图
  → 加载领域对象
  → 调用领域规则
  → 调用基础设施 Port
  → 在正确边界提交事务
  → 记录 Operation / Event
  → 返回稳定 DTO
```

Application 不得返回 Drizzle Row、Commander Option 或 AI SDK Result。

### 6.3 Infrastructure

- 每个 Repository 必须有明确领域所有者。
- SQL 只位于 `infrastructure/db/` 或已提交 Migration。
- Provider SDK 只位于对应 Adapter。
- Adapter 把 SDK 错误转换为 Self 稳定错误。
- 文件、网络和模型调用必须支持 `AbortSignal`。
- 重试只能针对明确可重试错误，并使用有上限的 backoff。
- 禁止捕获所有错误后返回空数组或 `undefined`。

## 7. CLI 实现规范

### 7.1 Command Handler 边界

每个 CLI Command 按固定顺序工作：

1. Commander 解析原始参数。
2. Zod 校验并规范化 Command Input。
3. 解析 Self Root 和运行上下文。
4. 调用单个 Application Use Case。
5. Presenter 转换为 human 或 JSON envelope。
6. Main 根据稳定错误设置退出码。

Command Handler 禁止直接：

- 执行 SQL
- 调用模型 Provider
- 修改文件
- 决定领域状态转换
- 调用 `process.exit()`

只有 `src/cli/main.ts` 可以设置最终退出码。底层库通过 typed error 返回失败。

### 7.2 输出

- stdout 只输出命令结果。
- stderr 输出诊断、进度和错误。
- `--json` 下 stdout 必须只有一个合法 JSON envelope。
- `--jsonl` 下每行都是独立 JSON，不混入人类日志。
- Pino 日志不直接输出到 Agent stdout。
- 错误不得暴露 API Key、Token、完整模型请求或用户私人全文。

### 7.3 命令协议兼容

- 同一 CLI 主版本内不删除已有字段或改变字段类型。
- 新增字段默认可忽略。
- 错误码和退出码视为公开 API。
- 命令 Spec、帮助、JSON Schema 和测试覆盖表必须由同一来源生成。

## 8. 错误、日志和可观测性

### 8.1 错误模型

错误必须包含：

```ts
type SelfError = {
  code: string;
  message: string;
  category: "usage" | "not_found" | "conflict" | "state" | "external" | "internal";
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
};
```

对外 JSON 中不直接序列化 `cause`，只记录脱敏诊断。禁止依赖错误 message 文本进行程序判断。

### 8.2 日志

结构化日志至少带：

- `request_id`
- `operation_id`
- `job_id`
- `workspace_id`
- `domain`
- `event`
- `duration_ms`
- `error_code`

禁止记录：

- 密钥和认证头
- 未脱敏 Cookie
- 完整私人文档
- 完整 Embedding
- 模型内部推理
- 不受限的 CLI stdin

日志采用轮换和保留策略，仍然位于 Self Root。

## 9. 文件系统与路径规范

### 9.1 Path 类型

代码中明确区分：

- `WorkspaceRoot`
- `WorkspaceRelativePath`
- `ExternalInputPath`
- `TemporaryPath`
- `ExportPath`

写入业务数据前必须：

1. 规范化路径。
2. 解析 `..`、符号链接和大小写差异。
3. 验证目标仍在 Self Root 内。
4. 拒绝指向设备、socket 或未知特殊文件的路径。

外部输入可以位于 Root 外，但只能读取；摄入前先保存内部 Snapshot。

### 9.2 原子文件写入

重要文件使用：

```text
写入 runtime/tmp 中的同文件系统临时文件
  → flush
  → 校验内容或哈希
  → fsync（关键元数据）
  → 原子 rename 到目标
  → 必要时 fsync 父目录
```

禁止直接覆盖：

- `self.toml`
- `latest.json`
- 原始 Snapshot
- Build Manifest
- 备份 Manifest

正式 Workflow 写入 `content/notes/` 或 `content/inbox/` 前，必须向 Connection 登记带预期 content hash 和 Operation ID 的 ManagedWriteReceipt。只有 path 与 hash 完全匹配的 watcher 事件可以被抑制；这避免重复摄入自身写入，同时不会隐藏用户并发修改。

### 9.3 删除

- 普通删除先 tombstone。
- 永久文件删除只能来自已批准的 Purge/GC Plan。
- 递归删除前必须验证 canonical path 位于允许目录。
- 禁止拼接用户输入后直接执行 `rm -rf`。
- 删除失败必须保留数据库和文件之间可恢复的中间状态。

## 10. SQLite 和事务规范

### 10.1 数据库边界

- 使用唯一 `data/self.sqlite3`。
- WAL 和 SHM 与数据库放在同一目录。
- 启动时验证 `foreign_keys`、FTS5、sqlite-vec 和 Migration 版本。
- 每张表只有一个领域拥有写入规则。
- Domain/CLI/Renderer 禁止执行 SQL。
- FTS5、vec0、PRAGMA 和 Trigger 使用命名 raw SQL 模块，其余优先 Drizzle。

### 10.2 事务红线

“单写者”表示同一时刻只允许一个短 SQLite 写事务，不表示 Daemon 永久独占数据库。CLI 与 Daemon 可以并存：通过 `BEGIN IMMEDIATE`、`busy_timeout`、对象版本和幂等键协调写入。只有 Migration、Restore、Deep Repair 等 Maintenance 操作获取 Workspace 独占锁。

事务内禁止：

- 调用模型
- 发起 HTTP 请求
- 等待用户输入
- 执行耗时文件解析
- 启动或等待 Worker
- 睡眠重试

正确流程是：

```text
事务外准备输入和派生结果
  → 检查对象当前版本
  → 开启短事务
  → 写入领域状态和 Operation
  → 提交
  → 事务外发送后续事件或执行可重试工作
```

任何跨文件与数据库操作必须设计恢复协议，而不是假装文件系统和 SQLite 能加入同一个 ACID 事务。

### 10.3 Migration

- Migration SQL 必须进入版本控制并人工审查。
- 禁止在真实实例执行 `drizzle-kit push`。
- 运行时只允许 Self 自己的 Migrator 执行已内置 Migration。
- 破坏性 Migration 必须先备份并生成 Plan。
- 每个 Migration 必须测试空库、真实旧版本、执行中断和重复执行。
- 新 CLI 打开更高格式数据库时必须拒绝写入。

## 11. 并发和 Job 规范

- SQLite 采用多读者、单写者策略。
- Daemon Leadership Lock 只保护 Connection 调度权，不阻止普通 CLI 进行受控写事务。
- Worker 不共享可写 Database Connection。
- CPU 密集解析和 Embedding 准备可以进入 Bun Worker。
- Worker 只返回结构化结果，由中心 Writer 提交数据库。
- 所有长任务有 Job ID、状态机、checkpoint 和 AbortSignal。
- 任务重试必须幂等，不得重复创建 Source、Chunk、Embedding 或 Build。
- 取消任务不能留下 `ready` 的半成品。
- 进程退出时停止接收新任务，等待短事务结束，再释放锁。

## 12. 模型调用规范

- 只有 ModelGateway 可以调用 AI SDK 或 Provider。
- Domain 只能请求能力，如 `extractClaims`、`embedChunks`，不能指定某家供应商。
- 每次调用记录 Model ID、Provider、PromptSpec、Schema、输入对象 ID、用量和耗时。
- 发送最小必要上下文，不默认上传完整知识库。
- 所有结构化输出必须通过 Zod。
- 模型返回不能直接写数据库，必须经过领域不变量和证据校验。
- Embedding 批次失败必须精确到 Chunk，不得把整个 Source 静默标记成功。
- Embedding Provider 不可用不得诱导跨 VectorSpace 查询；必须显式降级 FTS + Graph，并允许从本地 Chunk 换厂商重建。
- 不保存或伪造模型内部 chain-of-thought。
- Provider 限流、超时和内容过滤必须映射成稳定错误。
- 模型重试必须有预算上限，不能无限消费 Token。

## 13. `self.toml` 运行时配置规范

### 13.1 唯一配置文件

实例的正式配置固定为：

```text
<self-root>/self.toml
```

不支持散落的全局业务配置。开发仓库中的 `bunfig.toml` 是 Bun 工具配置，与实例 `self.toml` 无关。

### 13.2 Root 发现顺序

Root 按以下顺序确定：

1. CLI `--root <DIR>`
2. 环境变量 `SELF_ROOT`
3. 从当前目录向父目录查找 `self.toml`

规则：

- 显式 `--root` 优先级最高。
- 如果向上查找到多个嵌套实例，使用最近的一个并在 `--trace` 中说明。
- Root 解析后立即 canonicalize，此后不能重新依赖 cwd。
- `self help`、`self version` 和 `self commands --json` 不要求存在 Root。
- 其他命令找不到 Root 时返回稳定的 `workspace_not_found`，不能自动在 cwd 初始化。

### 13.3 配置加载顺序

```text
编译期安全默认值
  → 读取 <root>/self.toml
  → smol-toml 解析为 unknown
  → Zod 校验和填充默认值
  → 解析 Secret 引用
  → 应用明确允许的 CLI 临时覆盖
  → 生成不可变 RuntimeConfig
```

配置优先级：

```text
CLI 当前命令参数 > 明确允许的环境变量 > self.toml > 编译期默认值
```

环境变量只用于：

- `SELF_ROOT`
- 密钥与 Secret
- CI/测试明确允许的运行参数
- 少量紧急诊断开关

禁止为每个 TOML 字段自动生成环境变量覆盖，否则无法判断实际生效配置。

### 13.4 配置 Schema

顶层建议：

```toml
format_version = 1

[workspace]
[storage]
[database]
[connections]
[ingestion]
[models]
[retrieval]
[artifacts]
[jobs]
[logging]
[security]
```

要求：

- 顶层必须包含 `format_version`。
- 未知字段默认报错，防止拼写错误静默失效。
- 错误信息包含 TOML 路径和期望类型，但不泄漏 Secret。
- 所有业务路径使用 Root 相对路径。
- API Key 只能保存为环境变量名或加密 Secret 引用。
- `models.embedding_defaults` 只影响以后创建空间的建议值；Active VectorSpace 不允许通过 `config set` 改变。
- Embedding Model、Revision、维度、Instruction、Normalize、Distance 或输入版本变化必须通过 VectorSpace 创建、构建、验证和激活 Plan。
- 修改数据库格式、扩展路径和存储目录必须重启。

### 13.5 读取实现

```ts
import { parse } from "smol-toml";

export async function loadRuntimeConfig(root: WorkspaceRoot): Promise<RuntimeConfig> {
  const path = root.resolve("self.toml");
  const content = await Bun.file(path).text();
  const parsed: unknown = parse(content);
  const config = selfConfigSchema.parse(parsed);
  return resolveRuntimeConfig(root, config);
}
```

禁止：

- `import config from "./self.toml"` 读取用户实例配置，因为 bundler 可能在构建时内嵌。
- 在多个模块中各自读取 TOML。
- 把可变 config object 作为全局变量传播。

配置在 Composition Root 读取一次，转换为 readonly RuntimeConfig，再注入需要的服务。

### 13.6 配置修改

用户可以手工编辑，也可以使用：

```bash
self config get retrieval.mode
self config set retrieval.mode hybrid
self config validate
self config effective --redact
```

`config set` 必须：

1. 读取当前配置和版本。
2. 应用单个受控变更。
3. 完整校验新配置。
4. 写入临时文件。
5. 保存旧配置快照。
6. 原子替换 `self.toml`。
7. 输出是否需要 restart/rebuild。

禁止在解析失败时“修复”并覆盖用户原文件。

### 13.7 热更新

普通 CLI 每次启动读取一次配置。Connection Daemon 只允许热更新：

- 日志级别
- 非结构性并发上限
- 部分网络超时

以下变化必须重启或执行 Plan：

- 数据库和目录路径
- SQLite 扩展
- Active VectorSpace、Model Route，或任何 Embedding 兼容字段
- Chunker 版本
- 模板兼容主版本
- 安全策略

## 14. Runtime 启动和退出生命周期

### 14.1 启动顺序

```text
解析最小全局参数
  → 处理 help/version 等无 Root 命令
  → 发现并规范化 Self Root
  → 读取和校验 self.toml
  → 初始化 Root 内日志
  → 检查目录权限和可用空间
  → 获取所需实例锁
  → 配置兼容 SQLite 并打开数据库
  → 加载 sqlite-vec，检查 FTS5
  → 检查配置/数据库/CLI 协议兼容性
  → 运行安全 Migration
  → 构建 AppServices
  → 执行 Command
  → 输出结果
```

启动失败时不得留下已获取但未释放的锁，或只写了一半的配置和 Migration。

### 14.2 退出顺序

```text
停止接收新工作
  → 触发 AbortSignal
  → 等待或 checkpoint 当前 Job
  → 提交/回滚短事务
  → flush 日志
  → 根据策略 checkpoint WAL
  → 关闭数据库
  → 删除本进程临时文件
  → 释放锁
  → 设置稳定退出码
```

支持 SIGINT 和 SIGTERM。第一次信号触发优雅退出，第二次信号可以强制退出，但必须尽最大努力留下可恢复 Job 状态。

### 14.3 运行模式

| 模式 | 用途 | 约束 |
| --- | --- | --- |
| `read-only` | search、show、trace | 不获取写锁，不运行写 Migration |
| `write` | add、sync、build、update | 获取写协调权，使用短事务 |
| `maintenance` | migrate、restore、deep verify | 独占锁，拒绝其他写操作 |
| `daemon` | Connection watch/job runner | 状态仍全部在 Root，不改变数据边界 |

## 15. Build 规范

### 15.1 构建必须可重复

- Bun、TypeScript 和依赖精确锁定。
- 必须提交 `bun.lock`。
- CI 使用 `bun install --frozen-lockfile`。
- Build 不允许运行自动更新或从公网动态下载模板。
- 构建产物记录 Git commit、版本、目标平台、Bun 版本和构建时间。
- 能使用时设置 `SOURCE_DATE_EPOCH`，减少无意义二进制差异。

### 15.2 构建前门禁

正式构建顺序固定为：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run check:size
bun run db:check
bun test
bun run build
bun run release:verify
bun run test:e2e:phase10
```

Phase 10 RC 的聚合入口是 `bun run verify:phase10`，它还会生成脱敏 Roadmap 证据并在忽略提交的 `data/` 上执行真实 Backup/Restore。公开发布前另需 24h Soak 和 GitHub 跨平台 Matrix；本机通过不能代替远端资格。

任何一步失败都禁止生成可发布版本。禁止使用 `--no-verify`、跳过类型检查或暂时关闭失败测试完成发布。

### 15.3 构建脚本

复杂构建逻辑写在有类型的 `scripts/build.ts`，不要堆积在 package.json 或 Shell：

```ts
const result = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  compile: {
    outfile: `dist/${target}/self`,
    target,
  },
  minify: true,
  sourcemap: "external",
});

if (!result.success) {
  throw new Error("Self build failed");
}
```

构建脚本同时负责：

- 复制当前平台 SQLite/sqlite-vec
- 复制内置 Migration
- 编译和复制模板、主题和 client island
- 生成第三方 License 清单
- 生成 checksum
- 写入 `build-manifest.json`
- 对最终二进制执行 `self version` 和 sqlite-vec smoke test

### 15.4 Debug 与 Release

| 构建 | 行为 |
| --- | --- |
| Dev | `bun run src/cli/main.ts`，源码映射和详细日志 |
| Test | 编译真实 CLI，启用故障注入和 Test Provider |
| Release | minify、外部 source map、关闭测试后门、生成 checksum |

故障注入和 Test Provider 必须通过构建条件彻底禁止在 Release 中被用户意外启用。

## 16. 本地快速打包

### 16.1 推荐命令

```bash
# 开发运行
bun run dev -- --help

# 快速构建当前平台，不跑全部 Release Suite
bun run package:local

# 完整发布构建
bun run package:release -- --target bun-darwin-arm64
```

`package:local` 仍必须运行 typecheck、lint、size check 和关键 smoke test；它只能跳过 Large、Live Model 和长稳测试，不能跳过基本正确性。

### 16.2 本地产物

```text
dist/local/self-darwin-arm64/
├── self
├── runtime/
│   ├── sqlite/
│   └── extensions/sqlite-vec/
├── templates/
├── migrations/
├── build-manifest.json
├── checksums.txt
└── LICENSES/
```

快速验证：

```bash
./dist/local/self-darwin-arm64/self version
./dist/local/self-darwin-arm64/self init ./.test-runs/manual/instance
./dist/local/self-darwin-arm64/self \
  --root ./.test-runs/manual/instance doctor
```

## 17. 部署规范

### 17.1 部署模型

Self 有两个独立生命周期：

```text
CLI 发布包                         Self 实例目录
├── self binary                   ├── self.toml
├── platform runtime      ─init→  ├── content/
├── built-in templates            ├── data/
└── migrations                    ├── artifacts/
                                  └── runtime/
```

- CLI 可以安装到 `~/.local/bin`、Homebrew、包管理器或直接从解压目录运行。
- Self 实例始终是用户显式选择的普通目录。
- 升级 CLI 不得自动移动或重新组织实例数据。
- 实例目录复制到另一台机器后，业务内容完整；平台扩展可以由新 CLI 补齐。

### 17.2 本地安装

最简单部署方式：

```bash
tar -xf self-darwin-arm64.tar.gz
./self-darwin-arm64/self version
./self-darwin-arm64/self init ~/self-data
```

可选安装到 PATH：

```bash
install -m 0755 ./self-darwin-arm64/self ~/.local/bin/self
```

平台 sidecar 不能仅依赖二进制相邻路径永久存在。首次 `init` 或 `doctor --plan-fixes` 应将实例需要的扩展和模板复制到 Root，并记录 checksum。

npm 渠道：

```bash
npm install --global @helloanner/self
self --init
```

npm Meta Package 通过平台 Optional Dependency 携带相同 Release Binary。npm Launcher 只进行平台选择和进程转发；不得包含业务逻辑、联网下载代码或在安装时创建 Root。独立 tar/zip Release 仍必须完全不依赖 Node.js/Bun。

### 17.3 禁止的部署方式

- 要求独立 tar/zip Release 用户安装 Node.js 或 Bun；npm 渠道可以使用用户已有 Node/npm 作为安装和极薄 Launcher。
- 运行时从 npm 动态下载依赖。
- 把数据库或向量数据放进 Docker Volume 之外的未知位置。
- 默认启动公网监听端口。
- 自动上传用户知识以完成初始化。
- 安装脚本修改 shell 配置但不告知用户。
- 升级二进制时静默执行破坏性数据库 Migration。
- npm Postinstall 从外部 URL 下载或执行未包含在 Registry Tarball 中的代码。
- `self --init` 在未确认 Root、Network Plan 或 Model Test 前扫描目录、联网或发送用户资料。

### 17.4 Docker 的定位

Docker 只用于：

- CI 跨环境测试
- Linux Release 构建
- 可选的隔离运行

Docker 不是 Self 的主要部署方式。若使用 Docker，必须将整个 Self Root 挂载为单个目录：

```bash
docker run --rm \
  -v "$PWD/my-self:/self-root" \
  self-cli:VERSION \
  self --root /self-root status
```

镜像不能在未挂载位置保存业务数据；容器删除后，挂载目录仍然是完整实例。

### 17.5 常驻运行

默认 CLI 是按命令启动和退出。Connection watch/daemon：

- 必须由用户显式启用。
- PID、socket、日志和 checkpoint 全部位于 Root。
- 默认只监听本地 socket，不开放公网端口。
- 使用文件锁和 SQLite Lease 保证一个 Root 只有一个 active Leader。
- 原生 watcher 只提供事件提示，定时 reconciliation 负责最终正确性。
- 外部 Target 暂时不可用时，Target 进入 `unavailable`、所属 Connection 进入 `degraded`，禁止批量生成删除。
- systemd/launchd 配置可以生成，但必须通过 Plan 显示系统写入位置并由用户批准安装。
- daemon 和普通 CLI 使用相同 Application Service 和锁协议。

## 18. 版本和兼容规范

Self 至少维护五类版本：

| 版本 | 作用 |
| --- | --- |
| CLI SemVer | 用户可见功能和命令协议 |
| `format_version` | `self.toml` 格式 |
| Database Schema | SQLite Migration 版本 |
| Page IR | Artifact 渲染兼容性 |
| Domain Algorithm | Parser、Chunker、Prompt、Confidence 等 |

启动时建立兼容矩阵：

- 老 CLI + 新数据库：只读诊断或拒绝，不写入。
- 新 CLI + 老数据库：先展示 Migration Plan，安全 Migration 可按策略执行。
- 新模板 + 老 Page IR：通过兼容层或保留旧 Renderer。
- 新 Embedding Model/Revision/维度/Instruction/Normalize/Distance + 老向量：创建新 VectorSpace，不混用。
- 新 Chunker + 老 Revision：生成重建 Plan，不静默替换。

每个 BuildManifest 必须记录相关算法和模型版本，确保历史结果可解释。

## 19. 安全红线

以下情况绝对不允许：

1. 在 Self Root 外隐式写业务数据。
2. CLI Handler、Domain 或 React 组件直接执行 SQL。
3. 在 SQLite 事务内调用网络、模型或耗时解析。
4. 使用 `any` 或强制类型断言绕过外部输入校验。
5. AI 输出未经 Schema、证据和领域校验直接入库。
6. Agent 获得任意 SQL、任意文件写入或 Shell 执行入口。
7. 高风险修改绕过 Plan/Apply。
8. 用最后写入覆盖冲突 Claim 或历史 Revision。
9. 覆盖旧 Artifact Build。
10. 删除 Source 时不计算下游影响。
11. 自动运行破坏性 Migration 而没有备份和确认。
12. 日志、错误或 Artifact 泄漏密钥和认证信息。
13. 将网页中的指令当作 Agent 或系统命令执行。
14. 在 HTML 中输出未清理的脚本、事件属性或危险 URL。
15. 使用 `eval`、`new Function` 或执行来源携带的代码。
16. 无限重试模型、网络、锁或失败 Job。
17. 捕获异常后静默返回空结果并标记成功。
18. 通过删测试、关闭严格类型或降低门禁掩盖缺陷。
19. 单个生产源码文件超过 500 逻辑行。
20. 未经 ADR 引入新的数据库、服务、框架或全局状态容器。

## 20. 测试与质量门禁

每个功能 PR 必须同时包含：

- 领域不变量测试
- 真实 SQLite 集成测试
- CLI human 和 JSON 契约测试
- 正常、错误和取消路径
- 增量路径
- 全量重建或恢复路径
- 目录外写入检查（涉及文件时）
- Migration 测试（涉及 Schema 时）
- HTML/浏览器测试（涉及 Renderer 时）

合并前必须通过：

```bash
bun run typecheck
bun run lint
bun run check:size
bun run db:check
bun test
bun run test:e2e
```

发布前遵循 `docs/testing.md` 的 Release Suite，不能以单元测试全部通过代替真实 CLI 验收。

## 21. Code Review 检查表

### 架构

- [ ] 代码位于正确领域和层。
- [ ] 依赖方向没有反转。
- [ ] 没有跨领域内部 import。
- [ ] 没有引入新的全局状态。
- [ ] 文件和函数没有超过限制。

### 数据

- [ ] 所有写入都在 Root 内。
- [ ] 原始证据、规范数据和 Artifact 没有混淆。
- [ ] 数据库事务足够短。
- [ ] 增量和重建语义明确。
- [ ] 删除、迁移和失败具有恢复路径。

### CLI 与 Agent

- [ ] Command Spec、帮助和 JSON Schema 一致。
- [ ] 错误码、退出码和 partial 状态正确。
- [ ] 写操作支持幂等和版本冲突。
- [ ] 高影响操作使用 Plan/Apply。
- [ ] stdout 没有混入日志。

### 安全与隐私

- [ ] 外部输入经过 Schema 和路径校验。
- [ ] 模型只收到最小上下文。
- [ ] 日志和错误已脱敏。
- [ ] HTML 内容已清理。
- [ ] 没有隐式网络和无限重试。

### 验证

- [ ] 单元、集成、契约和 E2E 覆盖正确层次。
- [ ] 使用真实 CLI 验证最终状态。
- [ ] 失败测试保留可复现目录。
- [ ] 变更已更新对应设计文档。

## 22. 规范例外

确实需要偏离规范时：

1. 在 PR 中说明问题、原因、范围和风险。
2. 对架构、数据边界或依赖方向的例外写 ADR。
3. 给出退出例外的条件和计划。
4. 增加测试防止例外范围扩大。
5. 不允许以“先这样”“以后再拆”作为唯一理由。

安全红线、Root 外写入、破坏性操作门禁和历史证据保护不接受临时例外。

## 23. 第一阶段落地顺序

1. 创建 `package.json`、`tsconfig.json`、`bunfig.toml` 和 `biome.json`。
2. 实现 `scripts/check-size.ts` 和统一 `bun run check`。
3. 实现 Workspace Root 发现和 canonical path 类型。
4. 定义 `self.toml` Zod Schema、加载器和 `config validate`。
5. 实现 Composition Root 和无 Root 命令。
6. 实现 Runtime 启动/退出框架与 typed error。
7. 建立 `bun:sqlite` 连接、扩展检查和 Migration Runner。
8. 实现 Build Script、当前平台 package 和 build manifest。
9. 使用真实 packaged CLI 初始化一次性实例。
10. 验证实例移动、目录外零写入和 sqlite-vec 加载。

完成这十项后，再开始 Source 和 Ingestion 业务开发。这样后续功能会自然遵守配置、路径、构建、错误、测试和部署边界，而不是在项目变大后返工。
