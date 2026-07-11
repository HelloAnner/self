# Workspace 领域

> 状态：Phase 1 初始化、配置与 CLI 骨架已实现；完整 Onboarding 按 Phase 2～4 继续

## 目标

Workspace 代表一个完整、自包含、可迁移的 Self 实例，负责确定“当前命令正在操作哪个知识世界”。

## 负责范围

- Self 根目录发现与初始化
- `self.toml` 配置加载、校验和版本迁移
- 标准目录布局与相对路径解析
- 实例 ID、格式版本和能力清单
- 单实例锁、只读模式和基本健康状态
- CLI 命令及 Schema 的能力发现
- `self --init` 交互式 Setup、System/Component/Model 自检和 Setup Session

## 核心对象

- `Workspace`：实例身份、根目录和生命周期状态
- `WorkspaceConfig`：版本化配置快照
- `Capability`：当前二进制、扩展和模型支持的能力
- `PathPolicy`：目录边界、相对路径和外部路径规则

## 关键不变量

- 业务数据不得在根目录外隐式落盘。
- 数据库和配置中的业务路径必须是根目录相对路径。
- 初始化不得覆盖未知文件。
- 不兼容的配置或数据库格式必须阻止写入，但允许诊断和备份。

## 不负责

- 外部资料的具体同步协议
- 文档解析和向量化
- 备份内容与恢复算法

## 主要依赖

无业务领域依赖；被其他所有领域依赖。

## 详细文档

- [`model.md`](./model.md)：Workspace 聚合、状态、路径值对象和不变量。
- [`schema.md`](./schema.md)：SQLite 所有权、规划表和数据库版本行为。
- [`initialization.md`](./initialization.md)：npm 安装后的 Init、`self --init` 交互式引导、组件/模型检测、恢复和非交互 Spec。
- [`../../distribution.md`](../../distribution.md)：开源发布、npm 平台包、升级、卸载和供应链安全。
