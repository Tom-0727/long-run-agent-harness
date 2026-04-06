# 项目目标
- 打造具有持续学习能力，LifeLong Running 的 Agent 机制的 Harness

# References
- Claude Python SDK Doc：https://platform.claude.com/docs/en/agent-sdk/python
- Codex SDK Doc: https://github.com/openai/codex/tree/main/sdk/typescript

# 代码风格
- 永远不要使用兼容代码，必要时请与用户沟通

# Mailbox 机制
- 每个 agent 的 mailbox/ 目录下，每个联系人对应一个独立的 .jsonl 文件（human.jsonl, agent.<name>.jsonl）
- contacts.json 维护联系人列表，human 默认存在，agent 间建联由 human 通过 platform 前端操作
- 消息 schema 使用 from/to 字段标识收发方
- 发信支持 --to（指定联系人）和 --broadcast（广播所有 agent 联系人），agent 间通信为双写模型
- Runtime/pending_messages/ 目录存放通知文件，任意文件存在即唤醒 agent
- Runtime/awaiting_reply/ 目录标记等待回复状态，仅在无 pending messages 时跳过 heartbeat

# 执行规范
- 每当对Harness做了更新，应该检查是否需要同步更新到已部署的 Agents（可以用./update
-runtime），然后获得用户批准
