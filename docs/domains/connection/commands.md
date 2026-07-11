# Connection CLI 命令设计

## 1. 命令资源

Connection 使用两个顶层资源：

- `self connection ...`：管理持续数据连接、扫描和变化历史。
- `self daemon ...`：管理当前 Self Root 的后台连接进程。

`self source add --watch` 是组合快捷命令，不替代 Connection 的正式资源模型。

## 2. 创建 Connection

### 2.1 监控目录

```bash
self connection add ~/project-a/docs \
  --kind directory \
  --name 'Project A Docs' \
  --preset docs \
  --recursive \
  --mode watch-and-reconcile \
  --interval 5m
```

### 2.2 监控单文件

```bash
self connection add ~/project-b/README.md \
  --kind file \
  --name 'Project B README'
```

### 2.3 监控 Obsidian Vault

```bash
self connection add ~/Documents/MyVault \
  --kind obsidian \
  --preset obsidian \
  --exclude '.obsidian/cache/**'

# 监控已经迁入 Self Root 的人工笔记
self connection add ./content/notes \
  --kind obsidian \
  --scope managed-content \
  --preset obsidian
```

### 2.4 创建但暂不激活

```bash
self connection add ~/project/docs --paused --no-initial-scan
```

主要参数：

```text
--kind file|directory|project|obsidian
--scope external|managed-content
--name <NAME>
--preset docs|obsidian|project|custom
--mode poll|native|watch-and-reconcile
--recursive
--follow-symlinks
--allow-overlap
--include <GLOB>                  可重复
--exclude <GLOB>                  可重复
--interval <DURATION>
--full-hash-interval <DURATION>
--debounce <DURATION>
--settle <DURATION>
--delete-grace <DURATION>
--max-file-size <SIZE>
--source <SOURCE_ID>              绑定已有 Source
--paused
--no-initial-scan
--no-daemon
```

CLI 枚举值使用 kebab-case（`managed-content`），进入 JSON/领域对象和 SQLite 后规范化为 snake_case（`managed_content`）。

`--follow-symlinks` 属于高风险范围扩展，必须在 Plan 中显示可能越过的目录边界。Connection 目标指向整个 Self Root 或系统生成目录时必须拒绝；只有 `content/notes/` 和 `content/inbox/` 可以作为 `managed-content` Target。

精确重复添加同一个 Target 且策略相同，应幂等返回现有 Connection；策略不同则返回 conflict 并提示使用 `connection update`。父子目录范围重叠默认拒绝，因为会重复摄入并扭曲来源独立性；`--allow-overlap` 必须先生成 Plan，展示重复文件范围和 Source 归属策略。

## 3. 快捷创建

```bash
self source add ~/project/docs --kind directory --watch
```

等价于：

```text
创建 Source
  → 创建绑定 Connection
  → Initial Scan
  → Snapshot
  → Ingestion
```

返回值必须同时包含 `source_id`、`connection_id`、`scan_run_id` 和 `job_id`。

`source add --watch` 与 `snapshot` 模式冲突。外部路径默认切换为 `mirror`；`import --watch` 则监控迁入后的 `content/notes/` 等 managed-content 路径，而不是继续依赖原始外部位置。

成功创建 active Connection 后，命令默认确保当前 Root 的 Daemon 正在运行。`--no-daemon` 只用于容器、调试或由外部进程管理器启动 `daemon run` 的场景；命令必须返回连接尚未被后台调度的 warning。

## 4. 查看 Connection

```bash
self connection list
self connection list --state active
self connection list --health degraded
self connection show connection:con_123
self connection status connection:con_123
self connection stats connection:con_123 --since 7d
```

人类状态输出至少显示：

```text
ID             Project A Docs
State          active
Health         healthy
Target         ~/project-a/docs
Mode           watch-and-reconcile
Last event     8s ago
Last scan      2m ago
Next scan      in 3m
Known files    184
Pending        0
Failed         0
Source         source:src_123
Daemon         running
```

`--json` 返回完整 Health、策略版本、最近 Scan 和建议动作。

## 5. 动态查看变化

### 5.1 历史事件

```bash
self connection events connection:con_123
self connection events connection:con_123 --since 1h
self connection events connection:con_123 --kind modified
self connection events --all --since 10m --json
```

### 5.2 实时跟随

```bash
self connection watch connection:con_123
self connection watch --all --jsonl
```

`watch` 是只读的事件流查看命令，不是启动后台进程。每条 JSONL 事件包含：

- event ID
- connection ID
- path（可按输出策略脱敏）
- change kind
- Scan/Batch/Item ID
- 当前处理状态
- Source Snapshot、Document Revision 和 Job ID
- UTC 时间

### 5.3 查看变化批次

```bash
self connection changes connection:con_123
self connection changes connection:con_123 --state failed
self connection batch show change-batch:cb_123
self connection batch retry change-batch:cb_123
```

## 6. 扫描和对账

```bash
# 局部或完整扫描
self connection scan connection:con_123
self connection scan connection:con_123 --path guides/agents.md
self connection scan connection:con_123 --full
self connection scan connection:con_123 --full-hash

# 扫描所有到期或全部 active Connection
self connection scan --due
self connection scan --all --detach

# 预览，不产生 ChangeBatch
self connection scan connection:con_123 --dry-run
```

`--dry-run` 返回预期 created/modified/deleted/renamed，但不能更新 Observation Cursor。

## 7. 修改策略

```bash
self connection update connection:con_123 --set interval=10m
self connection update connection:con_123 --set mode=poll
self connection update connection:con_123 --add-include 'design/**/*.md'
self connection update connection:con_123 --add-exclude 'archive/**'
self connection update connection:con_123 --set max-file-size=20mb
```

策略变化的语义：

- include/exclude 变化触发完整 reconciliation。
- follow-symlinks 从 false 变为 true 需要 Plan。
- interval 变化只更新调度。
- sensitive file mode 变宽需要显式确认。
- Target path 不通过 update 修改，必须使用 rebind。

## 8. 暂停、恢复和 Rebind

```bash
self connection pause connection:con_123
self connection resume connection:con_123

self connection rebind connection:con_123 ~/moved/project-a/docs --plan
self plan show plan:plan_123
self apply plan:plan_123
```

Rebind Plan 显示：

- 原路径和新路径
- Path Fingerprint 对比
- 已知文件匹配率
- 新增、缺失和冲突文件预览
- 是否需要完整 Hash
- 是否可能产生大规模删除

指纹明显不匹配时默认拒绝，除非用户创建新的 Connection。

## 9. Detach、Delete 和 Restore

```bash
# 停止监控，保留 Source 和全部历史
self connection detach connection:con_123 --plan

# 软删除 Connection 配置和调度关系
self connection delete connection:con_123 --plan

# 恢复软删除 Connection，恢复后先完整扫描
self connection restore connection:con_123
```

Connection 不提供直接 purge Source 数据的能力。永久删除证据仍使用 `source purge`，避免停止监控时误删知识。

## 10. 错误与重试

```bash
self connection failures connection:con_123
self connection failures connection:con_123 --unresolved
self connection retry connection:con_123
self connection retry connection:con_123 --item change-item:ci_123
```

权限错误、rebind mismatch 和敏感文件确认不能无限自动重试。

## 11. Daemon 命令

### 11.1 前台运行

```bash
self daemon run
self daemon run --connections-only
```

前台模式适合调试、容器和进程管理器。

### 11.2 本地后台进程

```bash
self daemon start
self daemon status
self daemon stop
self daemon restart
self daemon logs --follow
```

`daemon start` 启动当前 Root 的后台进程，PID、锁、日志、Lease 和 Job 全部保存在 Root。重复 start 必须返回已存在的 Daemon，而不是启动第二个 Leader。

`daemon status` 必须显示 Daemon CLI Version 和 Protocol Version。升级 Self 二进制后，如版本不兼容，写命令先要求 `daemon restart`，不得由新旧版本并发修改同一调度状态。

### 11.3 系统用户服务

```bash
self daemon install --user --plan
self apply plan:plan_123
self daemon uninstall --user --plan
```

install 生成 systemd/launchd/Windows 用户级服务定义，并显示将写入的系统位置。系统服务安装属于 Root 外显式写入，必须经过 Plan/Apply；业务数据仍只写入 Root。

## 12. 健康和诊断

```bash
self daemon status --json
self doctor --connections
self connection verify connection:con_123
self connection explain connection:con_123 --path docs/architecture.md
```

`connection explain` 回答：

- 路径是否匹配 include/exclude
- 最近 Observation 和 Hash
- 最近一次发现变化的 Scan
- 对应 ChangeItem、Source Snapshot、Document Revision 和 Ingestion Run
- 当前为什么未摄入或失败

## 13. Agent JSON 示例

```json
{
  "ok": true,
  "data": {
    "connection_id": "connection:con_123",
    "state": "active",
    "health": {
      "level": "healthy",
      "last_successful_scan_at": "2026-07-11T08:00:00Z",
      "next_scan_at": "2026-07-11T08:05:00Z",
      "pending_changes": 0,
      "failed_changes": 0,
      "reasons": []
    },
    "source_id": "source:src_123"
  },
  "meta": {
    "request_id": "req_123",
    "root": "/path/to/self-root",
    "warnings": [],
    "next_actions": []
  },
  "error": null
}
```

## 14. 退出码

沿用 Self 全局退出码，并特别约定：

- Target 暂时不可用：外部来源失败，退出码 `6`。
- 扫描部分成功：退出码 `7`。
- Daemon Leader 冲突：退出码 `4` 或资源繁忙 `8`。
- Rebind/Detach/Delete 需要 Plan：退出码 `10`。
