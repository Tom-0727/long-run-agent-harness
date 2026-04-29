---
name: heartbeat-extension-authoring
description: Create or modify hidden per-workdir heartbeat extensions for this harness. Use when asked to add pre-heartbeat prompt injection, post-heartbeat accounting/export/audit, or customize heartbeat lifecycle behavior for this deployed agent.
---

# heartbeat-extension-authoring

Heartbeat extensions are runtime files, not agent-facing skills. Put them under `.harness/heartbeat`.

## Layout

```text
.harness/heartbeat/
  pre/*.json
  post/*.json
  scripts/*
```

## Manifest

Pre manifests inject stdout into the next heartbeat prompt:

```json
{
  "name": "custom-context",
  "command": ["uv", "run", "python", ".harness/heartbeat/scripts/custom_context.py"],
  "timeout_ms": 5000,
  "inject_as": "prompt_section"
}
```

Post manifests receive the heartbeat result through `HEARTBEAT_PAYLOAD_FILE` and do not inject prompt text:

```json
{
  "name": "usage-export",
  "command": ["uv", "run", "python", ".harness/heartbeat/scripts/usage_export.py"],
  "timeout_ms": 5000
}
```

## Script Contract

- Read JSON from `HEARTBEAT_PAYLOAD_FILE`.
- Use `AGENT_DIR`, `HEARTBEAT_PHASE`, and `HEARTBEAT_EXTENSION_NAME` if needed.
- For pre scripts, print only the prompt section to stdout.
- For post scripts, write only extension-owned files and keep stdout short.
- Do not modify `Runtime/metrics.json`, `Runtime/events.jsonl`, or pending message markers.
