# Model 领域

> 状态：待详细设计

> 跨领域模型选择、千问 Embedding、维度和迁移规则见 [`../../model-selection.md`](../../model-selection.md)。

## 目标

Model 为对话、Embedding、重排、OCR、转写和视觉理解提供可替换、可观测、可复现的模型能力。

## 负责范围

- 模型和 Provider 注册
- 能力、上下文长度、维度和限制描述
- `chat_fast`、`extract`、`reasoning`、`synthesis`、`vision_fast`、`vision`、`ocr` 等任务路由和降级策略
- 本地模型路径与云模型配置
- 调用预算、速率限制、重试和超时
- 调用输入范围、输出摘要、耗时和用量记录
- Prompt/Schema 版本及结构化输出校验
- 模型可用性和兼容性测试

## 核心对象

- `Model`：一个可调用模型及其固定能力
- `Provider`：本地或远程模型提供者
- `ModelRoute`：任务到模型的选择策略
- `Invocation`：一次可审计模型调用
- `PromptSpec`：版本化的提示和输出 Schema
- `BudgetPolicy`：成本、Token 和并发限制

## 关键不变量

- 模型 ID 必须解析到明确 Provider、名称和关键参数。
- Embedding Model、Revision、维度、Instruction、Normalize 和 Distance 必须进入兼容性描述并绑定 Knowledge 所有的 VectorSpace。
- 结构化输出未经 Schema 校验不得进入领域模型。
- 模型切换不能静默重解释历史数据。
- `model set-default --capability embedding` 不能直接改变 Active VectorSpace。
- Hosted 浮动模型别名必须记录实际版本，并通过 Sentinel Fingerprint 监测漂移。
- 凭证不能以明文进入普通配置、日志或 Artifact。

## 不负责

- 具体知识业务规则
- VectorSpace、Embedding 和向量索引的长期存储；它们属于 Knowledge
- Agent 的 Plan/Apply 协议
