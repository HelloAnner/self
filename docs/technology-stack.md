# Self 技术选型：TypeScript + Bun

> 状态：初始技术基线
> 决策日期：2026-07-11
> 核心选择：TypeScript 7 + Bun 1.3.14 + SQLite + sqlite-vec + 模块化单体
> 当前实现：Phase 10 主体 / CLI v1.0.0 / Schema 11；持久化 Job、备份和维护状态仍使用同一 SQLite 和同一模块化单体，不引入外部队列或状态服务。

> 模型职责、千问 Embedding 建议、维度与 VectorSpace 迁移以 [`model-selection.md`](./model-selection.md) 为准；本文只定义模型接入组件和配置形态。
> npm 平台包、全新环境和 `self --init` 以 [`distribution.md`](./distribution.md) 与 Workspace Initialization 为准。

## 1. 选型结论

Self 使用 TypeScript 和 Bun 实现。第一阶段不采用 NestJS、Next.js、Electron、Prisma、LangChain、LlamaIndex、Neo4j、Qdrant、Redis 或外部常驻数据服务，而是构建一个可以编译为本地可执行文件的模块化单体 CLI。Connection 可以按用户选择启动同一二进制的本地后台进程，但它不引入新的服务端部署或数据库。

```text
TypeScript 7
   │
   ├── Bun Runtime / Package Manager / Bundler / Test Runner
   ├── Commander + Zod             CLI 与 Agent 协议
   ├── bun:sqlite + Drizzle         结构化数据库与迁移
   ├── SQLite FTS5 + sqlite-vec     全文与向量检索
   ├── Vercel AI SDK                模型 Provider 适配
   ├── unified / remark / rehype    Markdown 解析
   ├── React + native SVG           Page IR、静态 HTML 与 MVP 图形
   ├── ECharts + Cytoscape.js       大规模交互图形的后续可选渲染器
   └── bun:test + Playwright        自动化测试
```

选择 TS + Bun 的主要原因：

- Self 的核心是 CLI、文件系统、SQLite、模型 API 和 HTML 生成，TS 生态在这些方向上完整且组合成本低。
- Bun 提供 TS 运行、包管理、测试、打包、单文件可执行程序、SQLite 和 Web API，能够显著减少工具链数量。
- Page IR、CLI JSON Schema、模型结构化输出和领域对象可以共享同一套 TypeScript 类型。
- Bun 的启动速度适合高频 CLI 调用，也支持 `bun build --compile` 生成不依赖用户安装 Node.js 的可执行文件。
- `bun:sqlite` 原生支持事务、WAL、prepared statement 和扩展加载，符合 Self 单文件数据库方向。

## 2. 总体架构风格

### 2.1 模块化单体

领域按照 `docs/domains/` 拆分，初期全部编译进同一个模块化单体二进制并使用同一个 SQLite 文件。普通命令和可选 Daemon 可以是两个受协调的本地进程，但不是两个业务服务：

```text
src/
├── cli/                       # Commander 适配、人类与 JSON 输出
├── application/               # 跨领域用例和事务编排
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
│   ├── db/                    # bun:sqlite、Drizzle 和 Repository
│   ├── filesystem/
│   ├── models/                # AI SDK Provider 适配
│   ├── parsers/
│   ├── web/
│   └── logging/
├── renderer/
│   ├── components/            # React Page IR 组件
│   ├── client/                # 可选的交互式 islands
│   └── themes/
└── shared/                    # ID、时间、哈希、Result 和通用 Schema

drizzle/                       # 已审核并提交的 SQL Migration
templates/                     # 内置模板和主题
tests/
├── unit/
├── integration/
├── contract/
├── e2e/
├── fixtures/
└── scenarios/
```

### 2.2 不使用大型应用框架

核心不采用 NestJS 或类似服务端框架。Self 不是 HTTP 服务，装饰器、控制器、全局容器和服务生命周期只会增加 CLI 启动、调试和领域耦合成本。

依赖注入采用显式 Composition Root：

```ts
type AppServices = {
  db: DatabasePort;
  models: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
  files: FileStore;
  logger: Logger;
};

export function createApplication(config: AppConfig): AppServices {
  // 在唯一入口显式组装基础设施。
}
```

领域层只依赖接口和值对象，不直接 import Commander、Drizzle、AI SDK、React 或 Bun 全局对象。Bun 专属能力限制在基础设施和程序入口，使核心领域规则保持可测试。

### 2.3 不把 Effect 作为基础框架

第一版不引入 Effect 作为全局编程模型。Effect 对资源、重试和并发很强，但会让整个代码库绑定新的类型系统和学习曲线。Self 先使用：

- discriminated union 表达业务错误
- 显式 `Result<T, E>` 或异常边界
- `AbortSignal` 负责取消
- 应用服务负责重试和事务
- Job 状态机负责长任务恢复

如果后续复杂 Provider 编排证明原生 Promise 难以维护，可以只在 Model 或 Automation 基础设施层引入 Effect，并先写 ADR。

## 3. 版本基线

以下版本是 2026-07-11 的建议基线。生产依赖使用精确版本并提交 `bun.lock`；版本范围只用于说明允许的升级边界。

### 3.1 核心工具链

| 组件 | 建议版本 | 用途 | 选择理由 |
| --- | --- | --- | --- |
| Bun | `1.3.14` | Runtime、包管理、构建、测试、SQLite | 当前稳定版；一套工具覆盖整个 CLI 生命周期 |
| TypeScript | `7.0.2` | 类型检查和编辑器语言服务 | 新原生编译器，适合不依赖 TS Compiler API 的新项目 |
| `@types/bun` | `1.3.14` | Bun API 类型 | 与 Bun Runtime 同版本锁定 |
| Biome | `2.5.3` | Format、Lint、Import 整理 | 避免 ESLint + Prettier + 多插件组合 |

TypeScript 7.0 刚完成原生编译器迁移，尚未提供稳定的 Compiler API。Self 不使用 Compiler API，也不采用依赖它的 typescript-eslint，因此可以直接使用 TS 7。若某个开发工具仍要求 TypeScript 6 API，可额外安装 `@typescript/typescript6` 作为工具兼容层，但业务类型检查仍以 TS 7 为准。

### 3.2 核心运行依赖

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| `commander` | `15.0.0` | CLI 参数、子命令和帮助 |
| `@commander-js/extra-typings` | `15.0.0` | Commander 参数类型推导 |
| `@clack/prompts` | `1.7.0` | `self --init` 的 Path、Select、Password、Spinner 和取消处理 |
| `zod` | `4.4.3` | 输入校验、领域边界和 JSON Schema |
| `drizzle-orm` | `0.45.2` | SQLite Schema 和类型安全普通查询 |
| `drizzle-kit` | `0.31.10` | 开发期生成和检查 Migration |
| `sqlite-vec` | `0.1.9` | SQLite 向量表和 KNN 检索 |
| `smol-toml` | `1.7.0` | 动态读取和写入 `self.toml` |
| `uuid` | `14.0.1` | UUID v7，配合领域前缀生成稳定 ID |
| `pino` | `10.3.1` | 写入本地 JSON 结构化日志 |

Drizzle 已有 1.0 RC，但 Self 数据可靠性优先，因此先采用稳定版 `0.45.2`。升级 Drizzle 1.0 必须单独验证 Bun SQLite Driver、Migration 格式和 raw SQL 行为。

`sqlite-vec` 仍是 pre-v1 项目，必须精确锁定 `0.1.9`，封装在 `VectorIndex` 接口后面，并为每次升级执行迁移、删除、KNN、备份和恢复测试。领域代码不能直接依赖 `vec0` 表结构。

### 3.3 AI 与模型

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| `ai` | `7.0.22` | 文本、结构化输出、Embedding 和 Provider Registry |
| `@ai-sdk/openai` | `4.0.11` | OpenAI Provider |
| `@ai-sdk/openai-compatible` | `3.0.7` | 本地及其他 OpenAI-compatible Provider |

AI SDK 只作为 Model 领域的基础设施适配层，不允许 Graph、Topic 等领域直接调用 SDK。Self 自己拥有：

- 模型注册和路由
- PromptSpec 版本
- 调用预算和重试
- Invocation 审计
- Zod Schema 校验
- Provider 能力差异处理

结构化抽取统一使用 Zod Schema。模型返回只有通过 Schema、证据引用和领域规则校验后才能进入数据库。

### 3.4 文档解析

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| `unified` | `11.0.5` | AST 处理管线 |
| `remark-parse` | `11.0.0` | Markdown 解析 |
| `remark-gfm` | `4.0.1` | 表格、任务列表等 GFM |
| `remark-frontmatter` | `5.0.0` | YAML/TOML Frontmatter 节点 |
| `remark-rehype` | `11.1.2` | mdast → hast |
| `rehype-sanitize` | `6.0.0` | HTML AST 白名单清理 |
| `rehype-stringify` | `10.0.1` | HTML 序列化 |
| `cheerio` | `1.2.0` | HTML 元数据、链接和确定性 DOM 查询 |
| `linkedom` | `0.18.13` | 为 Readability 提供轻量 DOM |
| `@mozilla/readability` | `0.6.0` | 网页正文提取 |
| `pdfjs-dist` | `6.1.200` | PDF 文本、页码和结构提取 |

Markdown 必须解析为 AST，不能用正则表达式拆标题、链接和代码块。AST 节点的 source position 要传递到 NormalizedDocument 和 Chunk，保证引用可以回到原文位置。

Office、OCR 和媒体属于后续能力：

- DOCX 候选：`mammoth@1.12.0`
- OCR 候选：`tesseract.js@7.0.0` 或外部本地模型 Provider
- 音视频：优先通过可配置 Transcription Provider；FFmpeg 作为显式外部能力探测

这些组件在相应领域进入实现阶段后再正式锁定，不能因为列为候选就成为核心依赖。

### 3.5 HTML 与可视化

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| `react` | `19.2.7` | Page IR 组件模型 |
| `react-dom` | `19.2.7` | 服务端生成静态 HTML、可选客户端交互 |
| `echarts` | `6.1.0` | 时间线、统计图和关系概览 |
| `cytoscape` | `3.34.0` | 可交互知识图谱 |
| `sanitize-html` | `2.17.6` | 原始 HTML 进入渲染边界前的额外清理 |

不采用 Next.js、Vite 或完整 SPA 框架。Artifact 是本地静态产物：

- 静态组件使用 `react-dom/server` 的 `renderToStaticMarkup`。
- 需要交互的图谱和图表采用小型 client island。
- Bun.build 负责把 island、CSS 和资源编译到 Build 目录。
- 默认输出可离线打开，多文件和单文件 HTML 都要支持。
- React 只负责渲染，不能成为 Topic 或 Claim 的数据模型。

CSS 初期使用设计 Token + 普通 CSS/模块化 CSS，不引入 Tailwind。模板是 Self 的产品能力，稳定的 CSS 变量和 Page IR 组件契约比在运行期组合 utility class 更适合归档和长期重建。

### 3.6 测试

| 组件 | 建议版本 | 用途 |
| --- | --- | --- |
| `bun:test` | 随 Bun `1.3.14` | 单元、集成和契约测试 |
| `fast-check` | `4.9.0` | 属性测试和输入生成 |
| `@playwright/test` | `1.61.1` | HTML 浏览器、交互和视觉回归 |

不引入 Jest 或 Vitest。测试 Harness 使用 Bun.spawn 执行真实编译后 CLI，所有 Test Run 数据仍按 `docs/testing.md` 放入一次性本地目录。

### 3.7 后续生态

| 组件 | 建议版本 | 启用阶段 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.29.0` | Phase 11，提供 MCP Server |

MCP、HTTP API 和 Obsidian 插件都调用 Application 层，不复制业务逻辑，也不能直接操作数据库。

## 4. 各功能的具体组件选择

| Self 功能 | 主要实现 | 说明 |
| --- | --- | --- |
| CLI 命令 | Commander + Zod | Commander 解析和帮助；Zod 是参数与 JSON Schema 的权威定义 |
| 交互式 Onboarding | @clack/prompts + Setup Application Workflow | Prompt 只做展示和收集答案，不直接写文件/数据库 |
| Agent JSON 协议 | Zod 4 | 生成 JSON Schema，并在输入和输出两端校验 |
| 配置 | smol-toml + Zod | TOML 负责可读存储，Zod 负责默认值、升级和校验 |
| ID | UUID v7 + 领域前缀 | 保持时间有序且可跨目录稳定引用 |
| SQLite | `bun:sqlite` | 无额外 Node native addon，直接使用 Bun 原生驱动 |
| 普通表查询 | Drizzle ORM | 类型安全、Schema 和常规 CRUD |
| FTS/vec/PRAGMA | 参数化 raw SQL | 虚拟表和 SQLite 特性不强行套 ORM |
| Migration | Drizzle Kit 生成 + 自有 Runtime Migrator | SQL 提交代码库；运行时不执行 `drizzle-kit push` |
| 向量 | sqlite-vec | 与主库同文件；向量空间按 Embedding 模型隔离 |
| 中文 FTS | `Intl.Segmenter` 预分词 + FTS5 | 避免第一版引入平台相关中文 tokenizer 扩展 |
| 文件 Hash | Web Crypto / Bun CryptoHasher | SHA-256 内容寻址和增量检测 |
| 文件监听 | `node:fs.watch` + 定期全量 reconciliation | watch 只提供提示，扫描对账才是正确性来源 |
| 动态连接状态 | SQLite Connection/Observation/Scan/Batch 表 | 监控配置和进度可审计、可恢复，不依赖内存 watcher |
| 网页抓取 | `fetch` + Cheerio + Readability | 内建 Fetch 下载，DOM 工具提取链接、元数据和正文 |
| Markdown | unified + remark | 保留 AST 和 source position |
| PDF | pdfjs-dist | 页码、文本和引用定位 |
| 模型 | AI SDK + Self ModelGateway | Provider 适配和业务规则分离 |
| 日志 | Pino | 只写 JSON 日志；CLI 展示由 Presenter 单独负责 |
| 后台任务 | SQLite Job 表 + Bun Worker | 不引入 Redis/BullMQ；单写者协调数据库提交 |
| HTML | React server render + Bun.build | Page IR 编译为可归档静态页面 |
| 图表 | 原生 HTML/CSS/SVG；ECharts 后续可选 | MVP 的时间线、可信度和对比无需脚本运行时；复杂交互需求通过 Gate 后再引入 |
| 图谱权威存储 | SQLite 邻接表 + Recursive CTE | 与主数据库同文件；普通索引完成邻居和有界路径查询 |
| 语义近邻投影 | sqlite-vec + Graph 投影表 | 绑定 VectorSpace 的可重建 Top-K，不当作事实边 |
| 图谱交换 | JSON-LD + GraphML | 仅用于互操作导出，不代替 SQLite 事实源 |
| 图谱可视化 | 有限原生 SVG；Cytoscape.js 后续可选 | MVP 消费有限局部 Subgraph/Page IR；两者都不承担存储 |
| 单元测试 | bun:test | 与 Runtime 同工具链 |
| 属性测试 | fast-check | 验证幂等、重建等价和领域不变量 |
| HTML 测试 | Playwright | DOM、离线、交互和截图 |
| Format/Lint | Biome | 单工具、速度快、不依赖 TypeScript Compiler API |

## 5. CLI 契约的实现方式

Commander 不能成为命令协议的唯一事实来源。每条命令先定义一个独立 `CommandSpec`：

```ts
import * as z from "zod";

export const sourceAddInput = z.object({
  input: z.string(),
  kind: z
    .enum([
      "auto",
      "markdown",
      "directory",
      "obsidian",
      "web",
      "pdf",
      "image",
      "media",
      "project",
      "text",
      "jsonl",
    ])
    .default("auto"),
  mode: z.enum(["import", "snapshot", "mirror"]).default("snapshot"),
  recursive: z.boolean().default(false),
});

export const sourceAddSpec = {
  id: "source.add",
  summary: "Add and ingest a source",
  input: sourceAddInput,
  output: sourceSchema,
};
```

同一份 Spec 用于：

- 注册 Commander 参数和帮助
- 校验 Agent JSON 输入
- 生成 `self commands --json`
- 生成 `self schema command source.add`
- 生成测试覆盖清单
- 校验 JSON envelope 中的 data

Commander action 只负责把参数转换为 Spec 输入，再调用 Application Service；不在 action 内写数据库业务逻辑。

## 6. SQLite 与向量实现

### 6.1 连接层

推荐连接顺序：

1. 解析 Self Root 和扩展路径。
2. macOS 如需要，先调用 `Database.setCustomSQLite()` 指向 Self 随附的兼容 SQLite 动态库。
3. 创建 `bun:sqlite` Database。
4. 配置 PRAGMA。
5. 加载 sqlite-vec。
6. 校验 SQLite、FTS5 和 vec 版本。
7. 执行已审核 Migration。
8. 将 Database 交给 Drizzle 和 raw SQL Repository。

建议 PRAGMA 基线：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA trusted_schema = OFF;
PRAGMA wal_autocheckpoint = 1000;
```

具体值通过性能和恢复测试确定，不能把 Benchmark 参数直接用于生产。备份和正常关闭前执行受控 checkpoint；macOS 需要特别测试持久 WAL 行为。

### 6.2 macOS 扩展风险

Bun 官方文档指出，macOS 默认使用 Apple 提供的 SQLite，而该构建不支持加载扩展。Self 又需要 sqlite-vec，因此这是 Phase 0 必须解决的技术风险。

推荐策略：

- Self 发布包为每个平台携带经过校验的 SQLite 和 sqlite-vec 二进制。
- `self init` 将当前平台所需扩展复制到实例的 `runtime/extensions/<platform>/`。
- 在创建任何 Database 前调用 `Database.setCustomSQLite()`。
- 记录 SQLite、sqlite-vec、平台、架构和 checksum。
- 实例跨平台移动后，由 `self doctor` 重新补齐当前平台扩展；业务数据库和知识内容不改变。
- CI 必须覆盖 macOS arm64、macOS x64、Linux x64/arm64 和 Windows。

如果 Bun compiled executable 无法稳定携带或定位自定义 SQLite，备选方案是将 SQLite 兼容库作为安装包 sidecar，而不是退回独立数据库服务。该决定必须先通过真实打包验证。

### 6.3 Drizzle 的边界

Drizzle 用于：

- 普通 SQLite 表 Schema
- 类型安全 select/insert/update
- 开发期生成 Migration
- 常规约束和索引

raw SQL 用于：

- FTS5 virtual table
- sqlite-vec `vec0` virtual table
- Trigger
- PRAGMA
- Online Backup 或文件控制相关逻辑
- 查询计划和性能诊断

开发者可以运行 `drizzle-kit generate`，但生成 SQL 必须审查并提交。Self Runtime 只运行内置 Migrator，不在用户知识库上执行 `drizzle-kit push`。

## 7. TypeScript 配置

建议的 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["bun"],
    "jsx": "react-jsx",
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", ".test-runs"]
}
```

说明：

- `module: Preserve` 和 `moduleResolution: Bundler` 与 Bun 原生 ESM 和打包方式一致。
- TS 7 默认不再自动注入所有 `@types`，所以显式设置 `types: ["bun"]`。
- `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 对数据库结果和 Agent JSON 很有价值。
- `DOM` 类型用于 Fetch、Web Streams、React client island 和模型 SDK；领域模块仍不应直接依赖 DOM。
- `skipLibCheck` 只跳过第三方声明文件，不降低 Self 源码的 strict 检查。

随着 renderer 变大，可以拆成 `tsconfig.base.json`、`tsconfig.cli.json` 和 `tsconfig.renderer.json`，但第一阶段保持单配置降低复杂度。

## 8. Bun 配置

建议的 `bunfig.toml`：

```toml
[install]
auto = "disable"
linker = "isolated"
saveTextLockfile = true

[install.lockfile]
save = true

[test]
root = "tests"
timeout = 30000
randomize = true
coverage = false
coverageSkipTestFiles = true
coverageReporter = ["text", "lcov"]
coverageDir = ".test-runs/coverage"
pathIgnorePatterns = ["tests/fixtures/**", ".test-runs/**"]
```

约束：

- 禁用 Bun 自动安装，防止执行脚本时隐式访问网络或改变依赖。
- 使用文本 `bun.lock` 并提交版本库。
- CI 使用 `bun install --frozen-lockfile`，开发环境不要把 `frozenLockfile=true` 写死，以免正常 `bun add` 无法更新 lock。
- 测试缓存、覆盖率和运行数据都进入 `.test-runs/`。
- Bun 的全局包缓存属于开发工具数据，不属于 Self 实例；发布后的 `self` 二进制不能依赖用户机器上的 Bun cache 或 node_modules。

## 9. Package 配置

建议的初始 `package.json` 轮廓：

```json
{
  "name": "self",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.14",
  "engines": {
    "bun": ">=1.3.14 <1.4"
  },
  "imports": {
    "#self/*": "./src/*"
  },
  "scripts": {
    "dev": "bun run src/cli/main.ts",
    "build": "bun run scripts/build.ts",
    "typecheck": "tsc --noEmit",
    "format": "biome format --write .",
    "lint": "biome check .",
    "check": "bun run typecheck && bun run lint && bun test",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "test:e2e": "bun run tests/harness/main.ts suite standard",
    "db:generate": "drizzle-kit generate",
    "db:check": "drizzle-kit check"
  }
}
```

实际依赖使用 `bun add --exact` 安装并由 `bun.lock` 锁定。不要手写 `^` 范围后假定每次构建相同。

Drizzle 配置：

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infrastructure/db/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
```

Drizzle Kit 只操作开发数据库或生成 SQL，不直接连接任何真实用户 Self Root。

## 10. Biome 配置

建议的 `biome.json`：

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.3/schema.json",
  "files": {
    "includes": [
      "src/**",
      "tests/**",
      "scripts/**",
      "*.ts",
      "*.json",
      "!dist/**",
      "!.test-runs/**"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

先使用 recommended 规则建立稳定基线，再根据真实缺陷增加规则。不要一次启用全部严格规则并产生大量无意义 suppression。

## 11. Self 实例配置

`self.toml` 是用户实例配置，不是开发工具配置。建议初始结构：

```toml
format_version = 1

[workspace]
id = "workspace:ws_01..."
name = "My Self"

[storage]
database = "data/self.sqlite3"
blob_dir = "content/sources"
artifact_dir = "artifacts"
extension_dir = "runtime/extensions"

[database]
journal_mode = "wal"
synchronous = "normal"
busy_timeout_ms = 5000

[ingestion]
chunker = "semantic-v1"
default_language = "auto"
max_chunk_tokens = 800
chunk_overlap_tokens = 80

[connections]
enabled = true
max_concurrent_scans = 2
max_concurrent_hashes = 4
reconcile_interval = "5m"
full_hash_interval = "24h"
event_debounce = "750ms"
write_settle_window = "1500ms"
delete_grace_period = "30s"
max_batch_size = 500
daemon_heartbeat = "15s"
daemon_lease = "45s"

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

[retrieval]
mode = "hybrid"
text_weight = 0.35
vector_weight = 0.45
graph_weight = 0.20
rerank_limit = 50
result_limit = 20

[artifacts]
default_template = "knowledge-atlas"
default_theme = "self-light"
keep_builds = "all"

[jobs]
max_concurrency = 4
single_db_writer = true
```

注意：

- 所有业务路径必须相对于 Self Root。
- API Key 不写入 TOML，只保存环境变量名或加密 Secret 引用。
- Chunk 大小、检索权重和并发数是初始值，必须通过真实测试调优。
- `embedding_defaults` 只影响新 VectorSpace 的创建建议；Active Space、空间定义和迁移状态在 SQLite 中。
- Embedding Model、Revision、维度、Instruction、Normalize 或 Distance 变化时必须新建并迁移 VectorSpace，不能静默修改。
- 配置升级由 Workspace Migration 完成，并保留旧配置快照。

## 12. Build 与发布

### 12.1 开发运行

```bash
bun install
bun run typecheck
bun test
bun run src/cli/main.ts --help
```

### 12.2 可执行文件

使用 Bun compile：

```bash
bun build ./src/cli/main.ts --compile --outfile ./dist/self
```

发布包不是只有一个二进制，而是：

```text
self-release-<os>-<arch>/
├── self                         # 或 self.exe
├── runtime/
│   ├── sqlite/                  # 必要时提供兼容 SQLite
│   └── extensions/sqlite-vec/   # 平台原生扩展
├── templates/                   # 内置 Page IR 模板与主题
├── checksums.txt
└── LICENSES/
```

`self init` 将当前实例长期需要的模板和扩展复制到 Self Root，使实例不依赖系统全局安装。实例跨平台后可以由新平台的 Self 二进制执行 `doctor --plan-fixes` 补齐平台文件。

### 12.3 发布矩阵

- macOS arm64
- macOS x64
- Linux x64 modern
- Linux x64 baseline
- Linux arm64
- Windows x64
- Windows arm64 在 Bun 和依赖验证稳定后启用

每个平台必须执行真实 sqlite-vec load、创建向量表、删除记录、KNN、备份和 HTML E2E，不能只验证二进制能启动。

### 12.4 npm 与独立二进制双渠道

- `@helloanner/self` 是候选 npm Meta Package；无作用域 `self` 已被占用。
- 每个平台 Binary/SQLite/sqlite-vec 进入精确同版本的 Optional Dependency Package。
- npm Launcher 只定位并转发给 Bun Standalone Binary，不实现业务逻辑。
- npm 安装不通过 Postinstall 从外部 URL 下载代码。
- GitHub Release 提供无需 Node/Bun 的独立 tar/zip。
- 发布使用 npm Trusted Publishing/Provenance，Meta Package 最后发布。
- 包名、平台矩阵、Init 和 Clean Machine 测试以 [`distribution.md`](./distribution.md) 为准。

## 13. 版本策略

### 13.1 锁定规则

- Bun 通过 `.bun-version`、`packageManager` 和 CI action 三处锁定 `1.3.14`。
- npm 依赖在 `package.json` 使用精确版本。
- 提交文本 `bun.lock`。
- SQLite、sqlite-vec、Parser、Chunker、Prompt、Page IR 和 Template 都有独立版本。
- Model 名称和 Provider 配置记录在每次 Invocation 与 BuildManifest 中。

### 13.2 升级节奏

- 安全修复：验证 Fast + Standard Suite 后尽快升级。
- Bun patch：每月批量评估，必须跑跨平台 SQLite 和 compiled binary 测试。
- TypeScript patch：运行 typecheck 和全部契约测试。
- Drizzle/sqlite-vec：单独 PR，附 Migration 与全量重建等价测试。
- AI SDK/Provider：验证结构化输出、Embedding 和 Recorded/Live Suite。
- React/原生 SVG：验证历史 Page IR、离线 HTML 和视觉回归；若引入 ECharts/Cytoscape，同样必须通过这些 Gate，并验证归档资源无远程依赖。
- Major 版本：先写 ADR，再升级，不在功能 PR 中顺带完成。

### 13.3 为什么不用 `latest`

Self 的数据库和历史 Artifact 需要多年可重建。使用浮动依赖可能导致同一 commit 在不同日期生成不同 Chunk、Schema 或 HTML。开发者可以查询 `latest`，但进入仓库的版本必须精确锁定，并由升级 PR 主动改变。

## 14. 明确不选择的技术

| 不选择 | 原因 |
| --- | --- |
| Node.js 作为主 Runtime | Bun 已覆盖 Runtime、测试、打包和 SQLite；保留 Node 兼容测试即可 |
| Deno | Bun 的 npm 兼容、SQLite 和单文件构建更贴合当前目标 |
| NestJS | 面向服务端和装饰器容器，增加 CLI 与领域耦合 |
| Next.js | Self 输出静态 Artifact，不需要 Web Server Framework |
| Electron/Tauri | 第一阶段是 CLI；桌面壳不应先于核心知识引擎 |
| Prisma | 自定义 SQLite、FTS5、vec0 和单文件发布不适合依赖额外 Engine |
| TypeORM | 运行期反射和 Active Record 风格不适合严格领域边界 |
| LangChain/LlamaIndex | RAG、Claim、可信度和增量规则是 Self 核心资产，不能隐藏在通用链框架中 |
| Qdrant/Milvus | 引入外部常驻数据服务并破坏单目录、单数据库目标 |
| Neo4j | 初期 SQLite 关系表足够，图数据库只能在被性能证据证明后作为可重建索引 |
| Redis/BullMQ | 本地任务使用 SQLite Job、Lease 和 Bun Worker 即可 |
| Jest/Vitest | Bun 已提供测试运行器，避免重复工具链 |
| ESLint + Prettier | Biome 提供足够的格式化和静态检查，并且不依赖 TS 7 Compiler API |
| Tailwind | Artifact 需要长期稳定的模板和 CSS Token，而不是运行期 utility 组合 |

## 15. 必须优先验证的技术风险

在正式展开业务开发前完成以下 Spike：

1. Bun compiled binary 在 macOS/Linux/Windows 加载随包携带的 sqlite-vec。
2. macOS `Database.setCustomSQLite()` 与打包后的路径解析。
3. Drizzle 与同一个 `bun:sqlite` Connection 共同操作普通表、FTS5 和 vec0。
4. sqlite-vec 删除、更新、备份、恢复和 WAL 行为。
5. TypeScript 7 + Bun + Commander + Zod + Drizzle 的完整 typecheck。
6. AI SDK 在 Bun 下执行 structured output 和 batch embedding。
7. React server render + Bun.build 生成完全离线 HTML。
8. Playwright 打开构建产物并验证图谱和引用交互。
9. `bun build --compile` 后模板、Migration 和静态资源的定位策略。
10. 实例整体移动后 SQLite 扩展、历史 HTML 和相对路径仍可使用。
11. Daemon 单 Leader、原生 watcher 丢事件和定时 reconciliation 的最终一致性。

任何一项失败，都应先记录 ADR 和替代方案，再进入依赖该能力的领域实现。

## 16. 官方参考

- [Bun 主页与当前版本](https://bun.sh/)
- [Bun TypeScript 配置](https://bun.sh/docs/runtime/typescript)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
- [Bun 单文件可执行程序](https://bun.sh/docs/bundler/executables)
- [Bun bunfig.toml](https://bun.sh/docs/runtime/bunfig)
- [TypeScript 7.0 发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Commander](https://github.com/tj/commander.js/)
- [Zod 4](https://zod.dev/v4)
- [Drizzle + Bun SQLite](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite)
- [Drizzle Migration](https://orm.drizzle.team/docs/migrations)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [AI SDK Structured Output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [React renderToStaticMarkup](https://react.dev/reference/react-dom/server/renderToStaticMarkup)
- [Biome](https://biomejs.dev/)
- [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)
