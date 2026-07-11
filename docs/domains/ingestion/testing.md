# Ingestion 测试矩阵

> 状态：Phase 3 gate passed

- 编译后二进制真实解析 Markdown、text、HTML、JSONL 和 PDF；图片附件明确 skipped。
- 同一 Snapshot/配置重复 Build 不增加 Run、Revision、Chunk 或映射。
- 损坏 JSONL 使 Run failed，且不发布半成品；修复后的新 Snapshot 可 ready。
- 在 Knowledge 发布后强制退出，`ingestion retry` 不重复业务对象。
- Connection ChangeItem 只有在 Knowledge 发布成功后进入 `ingested`；managed Note 自写扫描通过 WriteReceipt 去回声。
- Parser/Normalizer/Chunker 与 config fingerprint 固定，遍历顺序不影响结果。
- 所有输入和 Root 位于 `data/test-runs/phase-3-real-cli/`，不读取私人 Vault。
