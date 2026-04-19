# Todo List Mechanism

Per-agent durable work list + minute-granular scheduled reminders, surfaced into every heartbeat's wake-up prompt.

## Two Concepts

- **Todo** — a completion-bearing work item (`id`, `title`, `description`, `subtasks[]`, `done`). One JSON file per day under `todo_list/<YYYYMM>/<DD>.json`. The path encodes the date — there is no `date` field on a Todo.
- **Scheduled Task** — a wake-up timer (`id`, `title`, `kind=weekly|date`, `time HH:MM`, `weekdays` or `date`). Stored as a single JSON list in `scheduled_tasks.json`. Not a work item — it fires `reminder`-kind heartbeats when its minute matches.

## Storage Layout (per deployed agent)

```
<agent_workdir>/
  todo_list/
    <YYYYMM>/
      <DD>.json               # JSON list of Todo objects for that day
  scheduled_tasks.json        # JSON list of Scheduled Task objects
  Runtime/
    due_reminders.json        # runtime-owned: ids due this minute
    scheduled_delivered.json  # runtime-owned: "id@now_minute" idempotency log
```

All writes use write-to-tempfile + `os.replace` so the human frontend and the agent can write concurrently without corruption.

## Heartbeat Flow

1. **Scheduler tick** — the runtime decides to wake the agent.
2. **Pre-heartbeat hook** — runs `shared/skills/todo/scripts/pre_heartbeat.py.tmpl` before the wake-up prompt is composed. It scans `scheduled_tasks.json`, matches on the current `HH:MM` (weekday for `kind=weekly`, exact date for `kind=date`), writes due ids to `Runtime/due_reminders.json`, and appends `"<id>@<now_minute>"` entries to `Runtime/scheduled_delivered.json` so the same minute never fires twice.
3. **Prompt composition** — the provider runtime reads `Runtime/due_reminders.json` + today's `todo_list/<YYYYMM>/<DD>.json` and injects two sections into the wake-up prompt:
   - `Due reminders this minute:` (titles for each due scheduled task)
   - `Today's Todos:` (indented list with subtasks and done-marks)
   Missing files degrade to empty sections, never a crash.
4. **Agent edits** — during the heartbeat the agent uses the SDK-native Read/Edit/Write tools on the day file for Todos, or the dedicated CLI scripts for Scheduled Tasks (see below).

## Agent Surface

See `shared/skills/todo/SKILL.md.tmpl` for the canonical rules. In short:

- Todos — edit `todo_list/<YYYYMM>/<DD>.json` directly with Read/Edit/Write. A helper `_write_today.py.tmpl` exists for script-level appends (hook, smoke test).
- Scheduled Tasks — CLI only, never hand-edit `scheduled_tasks.json`:
  - `scripts/add_scheduled.py.tmpl --title ... --kind weekly|date --time HH:MM [--weekdays MON,...] [--date YYYY-MM-DD]`
  - `scripts/list_scheduled.py.tmpl`
  - `scripts/delete_scheduled.py.tmpl --id s<n>`
- Convenience: `scripts/fetch_today.py.tmpl` prints today's todos as JSON.

Time comes from `now_minute` injected by the runtime — scripts and agents never call `datetime.now()` or shell out to `date`.

## Code Map (for maintenance)

Skill (portable across provider runtimes, templated with `.tmpl`):

- `shared/skills/todo/SKILL.md.tmpl` — public skill contract and rules.
- `shared/skills/todo/scripts/_common.py.tmpl` — shared id allocation + atomic write helper.
- `shared/skills/todo/scripts/_write_today.py.tmpl` — append-a-todo helper (atomic rename).
- `shared/skills/todo/scripts/fetch_today.py.tmpl` — read today's todo file.
- `shared/skills/todo/scripts/add_scheduled.py.tmpl` — add scheduled task; validates `kind` / `weekdays` / `date`.
- `shared/skills/todo/scripts/list_scheduled.py.tmpl` — list scheduled tasks as indented JSON.
- `shared/skills/todo/scripts/delete_scheduled.py.tmpl` — delete by id; non-zero exit if missing.
- `shared/skills/todo/scripts/pre_heartbeat.py.tmpl` — the hook; scans scheduled tasks, writes `Runtime/due_reminders.json`.

Provider wiring (runs the hook and injects the two sections into wake-up prompts):

- `providers/claude/run_claude.py.tmpl`
  - `_load_due_reminders_section` (~L256) — builds the "Due reminders this minute:" block.
  - `_load_today_todos_section` (~L288) — builds the "Today's Todos:" block.
  - `_run_pre_heartbeat_hook` (~L375) — shells out to `pre_heartbeat.py` before prompt composition.
  - heartbeat entry point (~L638) invokes the hook, then the section loaders feed into the wake-up prompt (first-heartbeat / new-mail / idle / reminder variants all carry both sections).
- `providers/codex/run_codex.mjs.tmpl`
  - `loadDueRemindersSection` (~L568) — mirror of the Claude section loader.
  - `loadTodayTodosSection` (~L610) — same.
  - `runPreHeartbeatHook` (~L646) — mirror of the Claude hook runner.
  - heartbeat entry point (~L892) invokes the hook, then the section loaders feed the prompt.

## Verification

Two levels, both should be re-run when this mechanism changes:

- **Template smoke** — offline render scripts exercise `buildPrompt` / equivalent against seeded fixtures; confirm both sections appear with correct minute-match filtering and subtask done-marks.
- **Real-deploy smoke** — `./deploy-agent --provider claude` and `--provider codex` each against a fresh workdir with seeded `scheduled_tasks.json` + `todo_list/<YYYYMM>/<DD>.json`. Inspect `Runtime/heartbeat_prompts.jsonl` (Claude) or `Runtime/codex_events.jsonl` (Codex) and confirm the first heartbeat prompt carries both sections. A no-fixture fresh workdir must boot cleanly and simply omit the sections.

## Concept-Name Substitution

The skill uses product-level names **Todo** and **Scheduled Task**. A rename (e.g. to "Reminder" / "Cron Task") is mechanical: update `SKILL.md.tmpl` and script headers only. JSON field names (`id`, `title`, `kind`, `time`, `weekdays`, `date`, `subtasks`, `done`) do not encode concept names and stay put.
