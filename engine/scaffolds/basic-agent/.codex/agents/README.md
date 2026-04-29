# Codex Subagents

Put optional provider-native Codex subagents in this directory as `.toml` files. Do not add one by default unless the agent has a real, repeated stage that is independent enough to run outside the main context.

Use a subagent when a task is noisy and bounded: web research, broad file inspection, source triage, planning, evaluation, or data extraction. Keep final routing and business decisions in `AGENTS.md` for the main agent.

Each subagent should define:

- one responsibility and a trigger-focused `description`;
- the task packet it expects from the main agent;
- allowed reads, writes, tools, and side effects;
- a compact return contract with conclusion, evidence or sources, confidence, risks, and next action.

See `web_researcher.toml.example` for shape. Rename it to `web_researcher.toml` only when the new agent truly needs that role.
