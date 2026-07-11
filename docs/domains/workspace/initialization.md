# Workspace 初始化与交互式 Onboarding

> 状态：详细设计基线
> 目标：让第一次接触 Self 的用户在一个可理解、可取消、可恢复的交互流程中完成系统检查、Root 创建、来源接入、模型配置、首次索引和最终自检。

## 1. 两种入口，一套业务流程

人类入口：

```bash
self --init
self setup --interactive
self --init --root ~/Self
```

`self --init` 映射到规范命令 `self setup --interactive`，是顶层快捷入口，不创建第二套业务语义。`self init <DIR>` 仍是明确目录、适合脚本调用的底层初始化命令。

Agent/自动化入口：

```bash
self setup plan --spec ./setup.toml --json
self apply plan:plan_123 --json
self setup status --json
```

交互式 Wizard 和 Spec 都调用同一组 Application Workflow：SystemPreflight、WorkspaceInit、SourceAdd、ModelRegister/Test、VectorSpaceCreate/Build、ConnectionAdd 和 Doctor。Prompt 层不得直接写文件或数据库。

## 2. 命令解析规则

- 单独执行 `self --init` 启动交互式 Setup。
- `self --init --root <DIR>` 预选 Root，仍展示并确认路径。
- `self --init --offline` 跳过 Provider、Embedding 和网络测试。
- `self --init --resume` 查找所选 Root 内最近未完成 Setup Session。
- `self --init --no-color` 使用无颜色、屏幕阅读器友好的输出。
- `self --init --json` 非法；交互 Prompt 不能与单 Envelope JSON 混用，返回 `interactive_json_conflict`。
- stdin 不是 TTY 时不启动 Prompt，返回 `interactive_tty_required`，提示使用 `--spec`。
- Ctrl+C 表示安全取消，不把当前页面之前已成功提交的步骤伪装回滚；输出 Resume/Rollback 建议。

## 3. UI 技术选择

交互层建议使用 `@clack/prompts`：

- 支持 text、path、select、multiselect、confirm、password、spinner 和 cancellation。
- 自带 TypeScript 类型和适合 CLI 的简洁样式。
- Password Prompt 只负责遮罩输入；Secret 是否持久化仍由 Self Secret Store 决定。
- 不使用全屏 TUI，确保终端 Scrollback、日志复制、SSH 和 Screen Reader 可用。

版本进入仓库时精确锁定，并验证 Bun compiled binary、Windows Terminal、无颜色和非 TTY 行为。交互库只是 Presenter；所有步骤输入先转换为 Zod `SetupAnswer`，再调用 Application Service。[Clack prompts](https://www.npmjs.com/package/%40clack/prompts)

## 4. Setup Session

Root 确认之前不持久化私人选择。Root 创建或识别后，Session 写入：

```text
runtime/setup/<setup-session-id>.json
```

核心字段：

```text
session_id
workspace_id
setup_schema_version
cli_version
state
current_step
completed_steps
selected_profile
non_secret_answers
created_resource_ids
job_ids
warnings
started_at / updated_at / completed_at
```

Session 永远不保存 API Key、Token、Vault 正文或模型请求正文。

状态：

```text
started
  → preflighted
  → root_selected
  → workspace_ready
  → sources_configured
  → models_configured
  → indexing
  → verifying
  → completed

任意步骤 → cancelled / failed / waiting_for_user
```

## 5. Step 0：Welcome、语言和安全边界

首次画面必须说明：

- Self 的所有业务数据默认进入用户选择的 Root。
- 当前没有遥测。
- Init 本身不需要模型或网络。
- 添加外部目录默认只读；接纳内容会归档到 Root。
- Hosted 模型会把明确展示的内容发送给对应 Provider。
- 高影响操作会先生成 Plan。

选择：

- CLI 展示语言：English / 简体中文；仅影响 Presenter，不改变 Schema/状态值。
- Setup Profile：Recommended / Offline / Existing Vault / Advanced。
- 是否允许 Wizard 在模型测试阶段访问网络；默认在调用前再次确认。

## 6. Step 1：System Preflight

Wizard 自动运行 `self doctor --system`：

| 检查 | 结果 |
| --- | --- |
| CLI Build | Version、Commit、Release Channel、Manifest Hash |
| Platform | OS、Arch、ABI、CPU Baseline |
| Runtime | Bun compiled runtime capability |
| SQLite | Version、FTS5、JSON1、WAL、Backup API |
| sqlite-vec | Extension Version、Load、Insert、Delete、KNN Smoke |
| Filesystem | Atomic Rename、File Lock、Symlink、Case Sensitivity、Long Path |
| Terminal | TTY、Color、Unicode、Width、Shell |
| Resources | Available Disk、Memory、Writable Temp inside selected Root later |

结果分为：

- pass：可以继续。
- warning：能力降级但可继续，例如无颜色。
- blocking：当前平台包缺失、sqlite-vec 无法加载或二进制完整性失败。

Blocking Check 不提供“忽略并继续”。

## 7. Step 2：选择 Self Root

Wizard 提供：

1. 输入一个新目录。
2. 选择当前目录。
3. 选择已存在的 Self Root。
4. 从检测到的 Obsidian Vault 创建旁路 Self Root；默认不把 Self 系统文件塞入 Vault。

推荐默认只作为 Placeholder 展示，例如 `~/Self`，用户必须确认，不能在按 Enter 前创建。

路径检查：

- 展开 `~` 并 canonicalize 父目录。
- 显示最终绝对路径和可迁移性说明。
- 检查不存在、空目录、非空未知目录、Self Root、未完成 Init 五种状态。
- 非空未知目录自动生成 Init Plan，不直接写入。
- 显示预计系统空间；模型和 Source 的预计空间单独计算。

## 8. Step 3：初始化预览与确认

确认画面展示：

```text
Workspace root
Files/directories to create
Existing files that remain untouched
SQLite/runtime/template versions
Estimated base disk use
Network calls: none
Rollback capability
```

用户选择：Continue / Back / Show Full Plan / Cancel。

Continue 调用 Workspace Init Workflow。完成后立即运行：

```bash
self --root <ROOT> config validate
self --root <ROOT> verify --workspace
self --root <ROOT> doctor --components
```

任一核心检查失败则 Setup 进入 failed，提供 Resume/Rollback，不进入来源选择。

## 9. Step 4：选择资料来源

Wizard 支持多选：

- Obsidian Vault
- Markdown/Docs 目录
- 单个文件
- 网页
- 暂时跳过

每个本地目录继续选择：

| 模式 | 行为 |
| --- | --- |
| `snapshot` | 当前内容归档一次，不持续监控 |
| `mirror` | 外部目录只读监控，变化持续归档到 Root |
| `import` | 内容迁入 Root 的受控内容目录 |

Wizard 在执行前展示文件数、预计字节数、Ignore 规则和是否启动 Connection。大型 Vault 先创建可恢复 Job，不要求 Wizard 一直阻塞到全部 Embedding 完成。

## 10. Step 5：选择模型模式

Profile：

### Offline

- 不配置任何 Provider。
- 完成 Source、Snapshot、Chunk、FTS 和显式 Graph。
- Vector/LLM/OCR 显示 unconfigured。

### Hosted Recommended

- 从 Model Registry 展示推荐 Provider 和固定 Snapshot。
- 明确显示数据将发送到哪个 Base URL。
- 分别选择 Chat、Embedding、Vision/OCR；可以只配置其中一类。

### Local Model

- 选择 Root 内模型或明确的只读外部模型路径。
- 检查格式、大小、Runtime 和硬件资源。
- 不自动下载大模型，除非用户看到 URL、License、大小和 Hash 后显式确认独立 Download Plan。

### OpenAI-compatible Custom

- 输入 Base URL、Model ID、能力和限制。
- 必须完成 Capability Probe，不能只因接口名字相同就假设兼容。

## 11. Step 6：凭证配置

Secret 不能作为普通命令参数，因为会进入 Shell History。Wizard 使用 Masked Password Prompt，并让用户选择：

1. 只引用已经存在的环境变量。
2. 保存到操作系统 Keychain/Secret Service；明确说明这是用户授权的 Root 外 Secret Store。
3. 保存到 Root 内加密 Secret Store；需要用户口令，适合单目录迁移。
4. 本次进程临时使用，不持久化。

禁止：

- 明文写入 `self.toml`。
- 写入普通 SQLite 列、Setup Session、日志、Crash Report 或命令 Transcript。
- 在确认画面回显 Secret。
- 自动把 Secret 写进 Shell Profile。

## 12. Step 7：模型发现和真实测试

每个 Provider 先执行轻量 Discovery，再由用户确认真实调用：

```text
Provider endpoint
Model IDs to test
Capability: chat / embedding / vision / reranker
Text or test image that will be sent
Estimated number of requests
Possible cost
```

测试：

- Chat：最小结构化响应、Streaming、Schema 和 Tool Capability。
- Embedding：Dimensions、有限值、Normalize、重复输入稳定性和 Batch。
- Vision/OCR：内置非私人 Fixture，不发送用户资料。
- Reranker：固定 Query/Candidate 顺序和输出范围。

测试结果写 Model Registry 和 Invocation 元数据，但不保存 Secret。失败可以 Back/Edit/Skip；跳过会把能力标为 unverified，不能进入默认 Route。

## 13. Step 8：VectorSpace 选择

Wizard 展示：

- Provider/Model/Revision。
- Dimensions、Distance、Normalize 和 Instruction Version。
- 按当前 Chunk 数估计原始向量、索引和临时 Shadow 空间。
- Model 更换需要完整重建的提醒。

确认后生成 VectorSpace Create Plan。已有 Chunk 时启动 Build Job；新用户无资料时只创建 ready 定义或等待首批 Chunk。不同 Provider/Model 即使维度相同也不能复用空间。

## 14. Step 9：首次构建进度

展示分阶段 Dashboard：

```text
Archive      1,240 / 1,240 files
Parse        1,118 / 1,240 documents
Chunk       18,420 chunks
FTS         ready
Embedding   12,300 / 18,420
Graph links 4,211 explicit links
Enrichment  queued
```

要求：

- 使用真实 Job/Stage Read Model，不由 UI 猜进度。
- 显示当前速度、失败数、预计剩余范围和已用模型成本。
- 用户可以 Continue in Background、View Failures、Retry、Cancel。
- Continue in Background 返回可复制的 `self job watch <ID>` 命令。
- Wizard 退出不取消后台 Job。

## 15. Step 10：自动监控和 Daemon

只有用户选择 Mirror/Watch Source 时询问：

- 现在启动 Root-local Daemon。
- 本次会话内运行。
- 生成 systemd/launchd 安装 Plan。
- 暂不启动，保留 Connection paused。

默认可以启动 Root-local Daemon，但安装系统服务必须单独 Plan/确认。Wizard 显示 Target、Filter、Reconciliation Interval 和外部只读边界。

## 16. Step 11：最终自检与交付

依次运行：

```bash
self --root <ROOT> config validate
self --root <ROOT> doctor --all
self --root <ROOT> component verify --all
self --root <ROOT> model doctor --configured
self --root <ROOT> knowledge status
self --root <ROOT> graph verify
self --root <ROOT> status --verbose
```

最终界面分为：Ready、Ready with Warnings、Setup In Progress、Action Required。

显示：

- Root 路径和 Workspace ID。
- 配置的 Source/Connection 数。
- FTS、Vector、Graph 和 Topic 能力状态。
- Chat/Embedding/Vision Route 和实际 Model ID。
- 正在运行的 Job。
- Daemon 状态。
- 下一步三个建议命令。
- Setup Summary 和 Redacted Diagnostic 路径。

## 17. 系统、组件和模型查看命令

### System

```bash
self system info
self system info --json
self doctor --system
self doctor --workspace
self doctor --components
self doctor --models
self doctor --network
self doctor --performance
self doctor --all
self doctor --plan-fixes
```

### Components

```bash
self component list
self component list --status failed
self component show sqlite
self component show sqlite-vec
self component verify sqlite-vec
self component verify --all
```

Component 输出：name、kind、required、version、source、path、checksum、compatibility、status 和 remediation。至少覆盖 CLI、Bun Runtime、SQLite、FTS5、sqlite-vec、Migration、Parser、Template、Renderer、Daemon 和 Platform Package。

### Capabilities

```bash
self capability list
self capability show vector-search
self capability explain topic-html
self commands --json
```

Capability 状态：available、unconfigured、degraded、unavailable、unsupported。

### Models

```bash
self model list --available
self model list --configured
self model route list
self model show model:mdl_123
self model doctor --configured
self model test model:mdl_123
self model test --routes
self model usage --since 24h
```

默认输出不得显示 Secret、完整私人 Prompt 或正文。

### Status Dashboard

```bash
self status
self status --verbose
self status --watch
self status --json
```

Verbose Status 汇总 Workspace、Storage、Source、Connection、Jobs、Knowledge、VectorSpace、GraphGeneration、Model Route、Topic、Artifact 和最近错误。`--watch` 只刷新 Read Model，不触发隐式 Scan/Build。

### Diagnostics

```bash
self diagnostics collect --redact
self diagnostics show diagnostics:diag_123
self diagnostics verify diagnostics:diag_123
```

Diagnostic Bundle 默认保存在 Root 内，导出到 Root 外需要显式 Output Path。必须经过 Secret/私人路径/正文脱敏。

## 18. 非交互 Setup Spec

```toml
format_version = 1
root = "/home/user/Self"
profile = "hosted"
offline = false

[[sources]]
kind = "obsidian"
path = "/home/user/notes"
mode = "mirror"
watch = true

[models.chat]
provider = "dashscope"
model = "qwen3.7-plus-2026-05-26"
secret_env = "SELF_DASHSCOPE_API_KEY"

[models.embedding]
provider = "dashscope"
model = "text-embedding-v4"
dimensions = 1024

[daemon]
start = true
install_service = false
```

Spec 不允许内嵌 Secret Value。`setup plan` 输出完整影响和 Network Plan；只有 `apply` 执行。

## 19. Accessibility 与终端兼容

- 所有颜色同时有文字/符号含义。
- 支持 `NO_COLOR` 和 `--no-color`。
- 不依赖鼠标、光标绝对定位或动画理解状态。
- Spinner 在非交互日志中退化为阶段日志。
- Prompt 有默认值时明确显示；危险选项不默认 Yes。
- 密码粘贴后不回显长度之外的信息。
- 窄终端使用单列布局，表格退化为 Key/Value。
- Windows Terminal、PowerShell、SSH、tmux 和 Screen Reader 进入测试矩阵。

## 20. 安全与隐私红线

- Wizard 不能扫描未选择的目录来“推荐资料”。
- 模型测试不能默认发送用户 Source；只使用内置公开 Fixture。
- `doctor --network` 必须列出将访问的 Host 后再测试。
- Fix 操作仍遵守 Plan/Apply，Doctor 不能直接做破坏性修改。
- Setup Summary 不包含 API Key、私人文件名清单或全文。
- Wizard 取消后不留下 Root 外 Temp/Cache/Log。
- 交互选择不能绕过 PathPolicy、Predicate、VectorSpace 或领域不变量。

## 21. 错误码

| 错误码 | 含义 |
| --- | --- |
| `interactive_tty_required` | 当前环境不能运行交互 Prompt |
| `interactive_json_conflict` | 交互模式与 JSON Envelope 冲突 |
| `setup_cancelled` | 用户安全取消；可能存在可恢复已提交步骤 |
| `setup_session_not_found` | 没有可 Resume 的 Session |
| `setup_step_failed` | 当前 Step 失败，详情包含子操作错误 |
| `setup_secret_unavailable` | Secret Reference 无法解析 |
| `setup_model_unverified` | Model 测试未通过，不能成为默认 Route |
| `setup_indexing_in_progress` | 核心 Init 完成，后台索引仍在运行 |
| `component_missing` | 必需组件不存在 |
| `component_integrity_failed` | Checksum/Manifest 不一致 |
| `capability_degraded` | 能力可部分使用并包含原因 |

## 22. 测试矩阵

- 空机器、无 Bun、通过 npm Platform Package 启动。
- 空目录、非空目录、已有 Vault、已有 Self、未完成 Init。
- Offline 完整 Setup。
- Hosted Provider 成功、401、403、404、429、Timeout 和中途断网。
- Chat 成功但 Embedding 失败；FTS/Graph 仍可用。
- 大 Vault Setup 中途退出，Job 后台继续，Wizard 可 Resume。
- Secret 使用 Env、OS Keychain、Root Encrypted Store 和 Session-only。
- Ctrl+C 发生在每一个 Step。
- 无颜色、窄终端、非 TTY、JSON Spec、Windows/SSH。
- `doctor --all` 的 pass/warning/blocking 和 Fix Plan。
- Setup 完成后重复 `self --init`，进入 Inspect/Reconfigure 而不是重复 Init。

## 23. 完成定义

交互 Onboarding 只有同时满足以下条件才完成：

- 新用户能在不了解领域术语时完成第一个 Root。
- 所有选择都有可理解的结果和安全默认。
- Offline 路径不被模型配置阻塞。
- Hosted 路径完成真实 Model/Embedding Smoke Test。
- 资料接入、FTS、Vector 和 Graph 状态真实可见。
- 任意阶段可取消、恢复或清理 Self-owned 临时状态。
- Agent Spec 与交互流程产生相同规范 Plan/Operation。
- 最终 Doctor 能解释系统、组件、模型、Job 和下一步。
