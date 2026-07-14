# Model CLI Contract

```text
self model add --provider <name> --capability embedding --model <provider-id>
  --revision <fixed|floating-id> --dimensions <n[,n...]>
self model add --provider <name> --capability chat --model <provider-id>
  --revision <fixed|floating-id>
self model list [--capability embedding]
self model show <model-id>
self model test <model-id> --suite embedding-compat
```

`dashscope` 可以使用内置 OpenAI-compatible Endpoint Identity，但仍只读取 `SELF_DASHSCOPE_API_KEY` 或 `self.toml` 指定的环境变量。`model test` 是显式网络操作；没有凭证时退出 external error，不把失败伪装成 capability 可用。

Chat Model 由 `graph build|rebuild --model <model-id>` 显式使用；Phase 5 不设置会静默调用云模型的全局抽取默认值。

Phase 6 中 `self ask --model <model-id>` 可显式选择 Chat Model；未指定时只在已有 active Chat Model 中确定性选择，不自动注册或联网发现模型。`--allow-model-knowledge` 是当前调用的显式越界授权，不修改 Provider 或 Workspace 默认值。
