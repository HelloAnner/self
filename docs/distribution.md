# Self 开源分发、安装与首次初始化

> 状态：发布与安装设计基线
> 决策目标：让全新环境能够通过 npm 或独立二进制安装 Self，并在不污染系统、不覆盖已有文件、不依赖特定模型厂商的前提下创建第一个可迁移实例。

## 1. 这份设计解决什么

公开 GitHub 仓库不等于可用的开源产品。Self 还必须回答：

- 用户如何通过 npm 获得真正可运行的 CLI？
- 用户没有安装 Bun 时是否仍能运行？
- SQLite、sqlite-vec、模板和 Migration 如何随平台分发？
- 第一次执行是否会偷偷创建目录、联网或写入 Home？
- 一个全新目录、非空目录、旧实例和损坏实例分别如何初始化？
- 安装、升级和卸载如何与用户的 Self Root 解耦？
- npm 包、GitHub Release 和源码构建如何证明来自同一次发布？
- 开源许可证、安全策略、贡献流程和供应链证明如何建立？

本文件拥有“发布渠道、安装体验和首次运行”的跨领域契约。Workspace 的具体初始化状态机见 [`domains/workspace/initialization.md`](./domains/workspace/initialization.md)。

## 2. 核心结论

Self 采用三层分发：

```text
GitHub Source
  ├── npm meta package: @helloanner/self
  │     └── platform optional dependency
  │           └── Bun standalone Self binary + native sidecars
  ├── GitHub Releases
  │     └── per-platform tar.gz / zip + checksums + SBOM
  └── future package managers
        └── Homebrew / WinGet / Scoop packages over the same release artifacts
```

原则：

- npm 是安装入口，不是运行时业务架构。
- 用户通过 npm 安装后不需要另外安装 Bun。
- npm 渠道允许使用已经存在的 Node.js 作为极薄的二进制启动器；Self 业务仍运行在 Bun 编译的独立可执行文件中。
- GitHub Release 的独立包完全不要求 Node.js 或 Bun。
- npm 安装期间不从任意 URL 下载二进制；平台二进制作为 npm Optional Dependency 由 Registry 完整性机制分发。
- CLI 安装和 Self 实例是两个生命周期；升级或卸载 CLI 永远不删除用户 Root。

Bun 官方支持把 TypeScript/JavaScript 入口编译为包含 Bun Runtime 的独立可执行文件，并支持跨平台 Target。[Bun standalone executable](https://bun.sh/docs/bundler/executables)

## 3. npm 包名

截至 2026-07-11：

- 公共 npm 的无作用域包 `self` 已被其他项目占用，禁止尝试接管或制造混淆。
- `@helloanner/self` 当前查询不到公开包，可作为候选名。
- 发布前必须确认 npmjs.com 上拥有 `helloanner` 用户或 Organization Scope；GitHub 用户名不自动授予 npm Scope。

规范包名：

```text
@helloanner/self                    # 用户安装的 meta package
@helloanner/self-darwin-arm64       # 平台包
@helloanner/self-darwin-x64
@helloanner/self-linux-x64
@helloanner/self-linux-x64-baseline
@helloanner/self-linux-arm64
@helloanner/self-windows-x64
```

如果最终使用 Organization Scope，只允许在 Phase 0 的 Package Namespace ADR 中统一替换，不在代码、工作流和文档里形成多个品牌包名。

## 4. 为什么不直接把 TS 源码发布为一个 npm CLI

直接发布 TypeScript/Bun 源码存在问题：

- `npm install -g` 不能保证用户安装了 Bun。
- bun:sqlite、Custom SQLite 和 sqlite-vec 具有平台约束。
- 首次启动可能现场下载依赖，破坏可重复性和离线能力。
- 不同用户机器会得到不同 Bun/依赖组合。
- Windows、macOS 和 Linux 的扩展加载行为不同。

因此 npm 主包只负责：

1. 声明当前版本的各平台可选包。
2. 检测 `process.platform`、`process.arch` 和必要的 Linux ABI。
3. 定位已由 npm 安装的平台包。
4. 原样转发 argv、stdio、exit code 和 signal 给 Self Binary。
5. 在平台不支持或可选包缺失时给出确定性安装错误。

启动器不得包含 Workspace、数据库、模型或领域业务逻辑。

## 5. npm 包结构

### 5.1 Meta Package

```text
packages/npm-self/
├── package.json
├── bin/self.js
├── README.md
└── LICENSE
```

概念 `package.json`：

```json
{
  "name": "@helloanner/self",
  "version": "0.1.0",
  "description": "A local-first personal knowledge operating system for AI agents",
  "license": "LICENSE-TO-BE-DECIDED",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/HelloAnner/self.git"
  },
  "homepage": "https://github.com/HelloAnner/self",
  "bugs": "https://github.com/HelloAnner/self/issues",
  "bin": {
    "self": "bin/self.js"
  },
  "engines": {
    "node": ">=20"
  },
  "optionalDependencies": {
    "@helloanner/self-darwin-arm64": "0.1.0",
    "@helloanner/self-darwin-x64": "0.1.0",
    "@helloanner/self-linux-x64": "0.1.0",
    "@helloanner/self-linux-x64-baseline": "0.1.0",
    "@helloanner/self-linux-arm64": "0.1.0",
    "@helloanner/self-windows-x64": "0.1.0"
  }
}
```

最终 License 未决定前不能发布。示例中的 Node Engine 只是 npm Launcher 的兼容基线，必须由真实 CI 矩阵验证后冻结。

### 5.2 Platform Package

```text
@helloanner/self-<platform>-<arch>/
├── package.json
├── bin/self or bin/self.exe
├── runtime/sqlite/
├── runtime/extensions/sqlite-vec/
├── templates/
├── migrations/
├── build-manifest.json
├── checksums.txt
└── LICENSES/
```

每个平台包：

- 通过 `os`、`cpu`，必要时通过 `libc` 限制安装平台。
- 与 Meta Package 使用完全相同的 SemVer。
- 依赖版本必须精确，不能使用 `^`、`~` 或 `latest`。
- 包含已经完成 `self version`、SQLite/FTS/sqlite-vec 和 init smoke test 的产物。
- 记录 Git Commit、Bun、SQLite、sqlite-vec、Migration、Template 和构建环境。
- 不执行联网 Postinstall Script。

npm 的 `optionalDependencies` 允许不适用于当前平台的依赖安装失败而不阻断主包安装，适合平台包选择；Self Launcher 必须对“当前平台包实际缺失”给出明确错误。[npm package.json](https://docs.npmjs.com/files/package.json/)

## 6. 安装入口

### 6.1 npm Global

```bash
npm install --global @helloanner/self
self version
```

npm 官方的全局安装形式为 `npm install -g <package_name>`。[npm global install](https://docs.npmjs.com/downloading-and-installing-packages-globally/)

### 6.2 一次性试用

```bash
npx --yes @helloanner/self version
npx --yes @helloanner/self init ./my-self
```

一次性执行仍遵守相同 Init 规则，不能将 Self 业务数据放进 npm Cache。

### 6.3 Bun 用户

```bash
bun add --global @helloanner/self
self version
```

Bun 安装相同 npm Meta Package；实际执行的仍是平台 Self Binary。

### 6.4 独立 Release

```bash
tar -xf self-darwin-arm64.tar.gz
./self-darwin-arm64/self version
./self-darwin-arm64/self init ~/Self
```

该渠道不需要 Node.js、npm 或 Bun。

## 7. 安装后绝不能自动做什么

`npm install`、Postinstall 和第一次 `self version/help` 禁止：

- 自动创建 `~/Self`、`~/.self` 或当前目录实例。
- 自动扫描 Home、Documents 或 Obsidian Vault。
- 自动启动 Daemon 或安装 systemd/launchd 服务。
- 自动请求模型 Key、登录账号或访问模型 Provider。
- 自动运行数据库 Migration。
- 将遥测、机器信息或文件名发送到网络。
- 修改 Shell Profile、PATH、Git 配置或系统权限。
- 从 GitHub、CDN 或任意脚本 URL再次下载可执行代码。

安装只安装 CLI。人类用户显式运行 `self --init` 进入引导；高级用户和 Agent 使用 `self init <DIR>` 或 Setup Spec。

## 8. 全新环境的推荐路径

```text
Install CLI
  → self version
  → self --init
      → system preflight
      → choose and initialize Root
      → choose sources
      → configure and test models
      → create VectorSpace / first indexes
      → final doctor
```

示例：

```bash
npm install -g @helloanner/self
self version --json
self --init
```

`doctor --system` 不要求 Root，只检查平台 Binary、CPU/ABI、SQLite、扩展、可执行权限和安装 Manifest。Root Doctor 检查实例内容。

高级/非交互路径仍可逐步执行：

```bash
self doctor --system
self init ~/Self
self --root ~/Self doctor
self --root ~/Self model list
self --root ~/Self source add ~/Documents/Obsidian --kind obsidian --mode mirror --watch
```

`self --init` 的完整交互、模型测试、进度和恢复契约见 [`domains/workspace/initialization.md`](./domains/workspace/initialization.md)。

## 9. `self init` 产品语义

### 9.1 参数

```bash
self init <DIR>
self init <DIR> --json
self init <DIR> --plan
self init <DIR> --offline
self init <DIR> --with-vault <PATH> --mode import|mirror
self init resume <DIR>
self init rollback <DIR> --plan
```

v1 要求显式 `<DIR>`；不使用隐式 Home 默认值，避免在错误位置创建知识库。

### 9.2 空目录

空目录或不存在目录可以安全直接初始化：

1. Canonicalize 目标和父目录。
2. 检查父目录写权限、可用磁盘、平台能力和符号链接边界。
3. 创建 Init Journal 和 Workspace ID。
4. 在临时路径创建配置、数据库、Migration、模板和 Runtime Assets。
5. 校验 SQLite、FTS5、sqlite-vec、Manifest 和 Root 外写入。
6. 原子发布目录/文件。
7. 最后写入 `self.toml` 作为完整实例标志。
8. 返回下一步建议；不自动联网或添加 Source。

### 9.3 非空但不是 Self 的目录

默认不写入：

```text
init_requires_plan
```

`self init <DIR> --plan` 必须列出：

- 已存在的文件和冲突路径。
- Self 将新增的目录和文件。
- 哪些内容会被识别为 Source 候选。
- 是否需要 `--with-vault`、import 或 mirror。
- 回滚时能删除哪些 Self-owned 文件。

Apply 只能新增 Self-owned 路径，不能覆盖未知文件。

### 9.4 已经是 Self Root

- 相同格式且健康：幂等返回当前 Workspace，不重复创建。
- 旧格式：返回 Migration/Upgrade Plan，不在 init 内静默迁移。
- Init 未完成：返回 `init_incomplete`，建议 resume/rollback。
- 数据损坏：进入只读诊断，允许 doctor/backup，不尝试重新 init 覆盖。

## 10. Init 创建的最小实例

```text
<ROOT>/
├── self.toml
├── content/
│   ├── sources/
│   ├── notes/
│   └── inbox/
├── data/
│   └── self.sqlite3
├── artifacts/
├── models/
├── runtime/
│   ├── init/
│   ├── extensions/
│   ├── templates/
│   ├── locks/
│   └── logs/
└── backups/
```

空目录可以保留，但所有正式路径都由 Manifest 声明。任何 Temp、WAL、SHM、Socket、PID 和 Checkpoint 也必须位于 Root。

## 11. Init 原子性与恢复

Init Journal 位于：

```text
runtime/init/<operation-id>.json
```

记录：

- CLI/Config/Schema 版本。
- 目标 Root Identity。
- 每个即将创建的路径和预期 Hash。
- 已完成 Step 和 Checkpoint。
- 临时文件、最终文件和是否可回滚。
- 失败码和恢复建议。

失败处理：

- 只删除当前 Init Operation 创建且 Hash 未被用户改变的文件。
- 未知文件和用户在 Init 期间新增的文件永不删除。
- 数据库正式发布前在临时名称完成 Migration 和 Integrity Check。
- `self.toml` 只在所有核心文件验证成功后发布。
- 进程 Kill 后 `resume` 从最后持久 Checkpoint 继续。

## 12. 模型和网络初始化

初始 Workspace 不要求任何模型 Key即可创建和使用：

- FTS、Source、Snapshot、Document、Revision、Chunk 和显式文档 Graph 可以离线工作。
- Embedding、LLM、OCR 和多模态能力显示 `unconfigured`，不是 Init Failure。
- `self setup models` 是独立、可重复、可跳过的流程。
- Key 只通过环境变量、系统 Secret Store 或加密 Secret 引用注入。
- Self 不把 Key 写进 `self.toml`、SQLite 普通列、日志或诊断包。

首次 Model Setup：

```bash
export SELF_DASHSCOPE_API_KEY='set locally by the user'
self --root ~/Self model add --provider dashscope --capability chat --model <MODEL>
self --root ~/Self model test model:mdl_123
```

## 13. 升级

```bash
npm install --global @helloanner/self@latest
self version
self --root ~/Self doctor
self --root ~/Self migrate plan
self --root ~/Self apply plan:plan_123
```

规则：

- npm 升级只替换 CLI，不修改实例。
- 新 CLI 打开旧数据库时先判断兼容矩阵。
- 只读兼容时允许 status/doctor/backup。
- 破坏性 Migration 必须 Plan/Apply，并在执行前创建可验证备份。
- Page IR、模板和旧 Renderer 保留兼容路径。
- VectorSpace 和 Graph Rebuild 不是数据库 Migration，不能混成一个不可回滚步骤。

## 14. 卸载

```bash
npm uninstall --global @helloanner/self
```

卸载只移除 CLI/npm 包：

- 不搜索或删除任何 Self Root。
- 不停止未明确属于该版本的未知进程。
- 如需停止 Daemon，先由用户运行 `self --root <DIR> daemon stop`。
- 删除实例必须使用 Self 的 Root Delete/Purge Plan；永远不由 npm Uninstall Hook 完成。

## 15. 发布流水线

```text
Tag / Release PR
  → verify clean SemVer and changelog
  → install frozen dependencies
  → typecheck / lint / unit / integration
  → build every platform artifact
  → platform sqlite-vec + init + E2E smoke
  → generate checksums / SBOM / licenses
  → publish GitHub Release candidates
  → publish platform npm packages
  → publish meta package last
  → install from public npm in clean machines
  → verify provenance and package contents
  → mark GitHub Release stable
```

Meta Package 必须最后发布，防止用户安装到尚未存在的平台版本。同一版本发布失败后不得覆盖已发布 npm Tarball；修复使用新的 SemVer。

## 16. npm 发布安全

推荐使用 npm Trusted Publishing：

- GitHub Actions 使用 OIDC，不保存长期 `NPM_TOKEN`。
- Workflow 需要 `id-token: write`。
- npm Package 配置绑定准确的 GitHub Owner、Repo 和 Workflow Filename。
- `package.json.repository.url` 必须精确指向本仓库。
- 公共仓库和公共包通过 Trusted Publishing 自动获得 Provenance Attestation。
- Release Environment 配置人工审批和受保护 Tag。
- 发布后检查 npm Provenance、Tarball 文件清单和 Git Commit。

npm 官方建议通过 Trusted Publisher 建立 CI 与 Registry 的 OIDC 信任，公共包会自动生成 Provenance。[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

发布 Workflow 必须显式设置：

```text
registry-url: https://registry.npmjs.org
```

不能继承开发者机器、公司代理或镜像 Registry 配置。

## 17. 版本与渠道

| Channel | npm Dist Tag | 用途 |
| --- | --- | --- |
| Nightly | `nightly` | 自动构建，不保证数据格式稳定 |
| Preview | `next` | Developer Preview/Search Alpha 测试 |
| Stable | `latest` | 通过 Release Suite 的公开版本 |

规则：

- `latest` 只能由受保护 Release Workflow 发布。
- Nightly 不能自动迁移 Stable Root；建议使用测试实例。
- CLI SemVer、Config Format、Database Schema、Page IR 和算法版本分别记录。
- Platform Package 与 Meta Package 版本严格一致。

## 18. 全新环境测试矩阵

至少覆盖：

| 环境 | 安装 | Init | 核心验证 |
| --- | --- | --- | --- |
| macOS arm64 | npm + tarball | 新目录/非空目录 | custom SQLite、vec、迁移、卸载保留 Root |
| macOS x64 | npm + tarball | 新目录 | Rosetta/原生识别、路径和签名 |
| Linux x64 modern | npm + tarball | 新目录/只读父目录 | glibc、Daemon、备份 |
| Linux x64 baseline | npm + tarball | 新目录 | 旧 CPU 指令兼容 |
| Linux arm64 | npm + tarball | 新目录 | Extension Load、HTML |
| Windows x64 | npm + zip | 新目录/含空格路径 | `.exe`、文件锁、Long Path、卸载 |

每个平台测试：

1. 干净用户 Profile，无 Bun、无 Self 配置。
2. 从 Public Registry 安装，不使用 Monorepo Link。
3. `self version/help/doctor --system` 不创建 Root。
4. Init 新目录成功且全部写入 Root。
5. Init 非空目录不覆盖。
6. Init 中途 Kill 后 resume/rollback。
7. Source → Chunk → FTS/vec smoke。
8. CLI 升级和数据库 Migration Plan。
9. npm Uninstall 后 Root 可由独立 Binary 打开。
10. Package Contents、License、SBOM、Checksum 和 Provenance 检查。

## 19. Init 与安装错误码

| 错误码 | 含义 |
| --- | --- |
| `unsupported_platform` | 没有当前 OS/Arch/ABI 平台包 |
| `platform_package_missing` | Optional Dependency 未正确安装 |
| `binary_integrity_failed` | Binary/Sidecar 与 Manifest 不一致 |
| `init_target_required` | v1 未显式提供目标目录 |
| `init_requires_plan` | 非空未知目录需要 Plan |
| `init_path_conflict` | 将创建的路径与未知文件冲突 |
| `init_incomplete` | 检测到未完成 Init Journal |
| `workspace_already_exists` | 目标已经是健康 Self Root；幂等输出对象 |
| `workspace_format_too_new` | CLI 不能安全写入更高格式实例 |
| `workspace_migration_required` | 需要独立 Migration Plan |
| `insufficient_disk_space` | 预估空间不满足初始化 |
| `sqlite_extension_unavailable` | 当前平台 sqlite-vec 无法加载 |

错误输出必须提供 `recoverable`、`suggested_action` 和稳定退出码。

## 20. 纯开源发布的仓库门禁

第一次公开 npm Preview 前必须具备：

- OSI 批准的根 `LICENSE`；当前只有公开源码而没有 License，不等于已经授予开源使用权。
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md` 和私密漏洞报告方式
- `CHANGELOG.md`
- Issue/PR Templates
- Maintainer、Release 和 Deprecation Policy
- 第三方 License 清单和 SBOM
- 可重复构建说明
- GitHub Actions CI/Release Workflow
- npm Namespace 所有权和 Trusted Publisher
- Signed Tag/Release、Checksum 和 Provenance

License 是需要 Maintainer 明确决定的产品/法律选择。推荐评估 Apache-2.0（包含明确 Patent Grant）与 MIT（简洁宽松），未决定前文档和 Package 示例只能使用占位符，禁止误标 License。

## 21. 实施顺序

1. 决定 License 和 npm Scope，写 ADR。
2. 建立 Monorepo Package/Platform Package 结构。
3. 完成一个本机 Bun Binary + Platform Package Spike。
4. 完成 npm Meta Launcher，不含业务逻辑和下载脚本。
5. 实现 Workspace Init Journal、Plan、Resume 和 Rollback。
6. 建立无 Bun 的 Clean Machine npm Install E2E。
7. 扩展全部 Release Matrix。
8. 建立 GitHub Release、SBOM、Checksum 和 npm Trusted Publishing。
9. 发布 `next` Preview 并从公共 npm 回装验证。
10. 只有 Release Suite 全部通过后移动 `latest`。
