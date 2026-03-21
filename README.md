# task-forge

Scaffold tool for creating autonomous Agent workspaces. One command creates a complete workspace with behavioral rules, memory structure, communication mailbox, and a heartbeat launcher.

Based on the design spec in [DESIGNS.md](./DESIGNS.md).

## Quick Start

```bash
./create-agent <target-directory> <agent-name>
```

Example:

```bash
./create-agent ~/agents/researcher ResearchBot
cd ~/agents/researcher
pip install -r requirements.txt
python run.py
```

## What Gets Created

```
<target-dir>/
  AGENTS.md          # Behavioral rules (always loaded by the agent)
  run.py             # Heartbeat launcher (Python, claude-agent-sdk)
  requirements.txt   # Python dependencies
  tool-notes/        # One file per non-native external tool
  mailbox/
    MAILBOX.jsonl    # Human-agent communication (append-only)
  Memory/
    knowledge/       # Distilled long-term knowledge
      factual/
      conceptual/
      heuristic/
      metacognitive/
    episodes/        # Bounded execution records
  skills/            # Reusable executable capabilities
  Runtime/           # Scheduler state (session ID, PID, heartbeat)
```

## run.py Options

```
python run.py [--interval N] [--max-turns N] [--max-budget USD]
```

- `--interval` (optional): Heartbeat interval in minutes (default: 20)
- `--max-turns` (optional): Max agent turns per heartbeat (default: 50)
- `--max-budget` (optional): Max USD budget per heartbeat (default: 5.0)

## Requirements

- Python 3.10+
- `claude-agent-sdk` (`pip install -r requirements.txt`)
- `claude` CLI installed and configured (the SDK depends on it)

## Design

- **Python SDK for agent runtime** — session persistence, structured results, hook callbacks
- **Templates as separate files** — easier to maintain than embedded strings
- **Heartbeat in run.py, not in the agent** — agent does work, launcher handles scheduling
- **Session resumption across heartbeats** — context carries over via `resume=session_id`
- **Append-only mailbox** — simple, auditable human-agent communication
