---
name: build-a-codex-agent
description: Use when designing or scaffolding a Codex-based long-running business agent, including deciding what belongs in AGENTS.md, skills, and subagents.
---

# build-a-codex-agent

`basic-agent` is the harness scaffold for one-shot or scheduled Codex agents on top of `@openai/codex-sdk`. This skill turns a stable business responsibility into a dedicated workdir.

## Mental model

| Layer | Role | Location | Use for | Do not use for |
| --- | --- | --- | --- | --- |
| Main agent | Durable owner and router | `AGENTS.md`, wake-up prompts, memory | Goal, identity, policy, state routing, human-facing output, final judgment | Raw research dumps, broad file scans, repeated mechanical procedures |
| Skill | Reusable capability package | `.agents/skills/<skill>/SKILL.md` plus optional `scripts/`, `references/`, `assets/` | Repeatable workflows, domain procedures, tool recipes, validation scripts | One-off task state, business ownership, final decisions |
| Subagent | Short-lived delegated worker | `.codex/agents/<name>.toml` | Noisy, bounded, independent work that returns a compact report | Trivial steps, tightly coupled reasoning, final business judgment |

Design from responsibility outward: first define what the main agent owns, then extract repeatable procedures into skills, then add subagents only for noisy or parallel stages.

## When to use

Use this skill when the user needs a new agent for a stable business responsibility, fixed workflow, or recurring scheduled job.

Good fits:

- The agent should have its own name, owner, or durable business prompt.
- The behavior belongs in a dedicated `AGENTS.md`, wake-up prompt, optional `.agents/skills/`, and optional `.codex/agents/`.
- The work is broader than adding one capability to an existing agent.

Do not use it for a one-off script, a short-lived probe, or a small capability that can be added to an existing agent.

This skill does not create a new runtime mechanism. It copies the scaffold and prepares a workdir for business-specific customization.

## Design first

Before copying or editing files, decide:

1. **Business responsibility**: one durable goal, owner, success evidence, and non-goals.
2. **Main-agent behavior**: what must always be true in `AGENTS.md`: identity, decision rules, memory use, human communication, risk boundaries, and reporting style.
3. **Skill candidates**: procedures likely to repeat across episodes or agents. Create a skill only when the workflow has stable steps, examples, scripts, or references worth reusing.
4. **Subagent candidates**: stages where context isolation or parallelism is worth the handoff cost, such as planning, evaluation, web research, source triage, data extraction, or test analysis.
5. **Side-effect boundaries**: which layer may read, write, run commands, contact humans, or touch external systems.

## Build

Run the helper:

```bash
bash {skills-dir}/build-a-codex-agent/scripts/copy.sh --dest <absolute-path-to-new-agent>
```

Useful flags: `--name <slug>`, `--no-install`.

After copying:

1. Replace `AGENTS.md` with the new agent's business-specific system prompt.
2. Add reusable capabilities as skills under `.agents/skills/<skill-name>/`; Codex auto-discovers them.
3. Decide which independent, high-noise stages should become Codex subagents under `.codex/agents/<name>.toml`.
4. Leave `src/runtime/` and `src/trajectory/` alone unless you are intentionally changing the runtime contract.
5. Wire scheduling via cron (see `scripts/cron.example`) — do not add a scheduler daemon.

## AGENTS.md guidance

The main agent prompt should be the stable operating contract, not a transcript or implementation plan. Include:

- the assigned goal and what progress means;
- how to use memory, episodes, Todo, mailbox, and scheduled tasks;
- when to ask the human versus proceed independently;
- which skills and subagents exist, when to use them, and what handoff packet they expect;
- output style and reporting cadence.

Keep volatile task details out of `AGENTS.md`; put them in episode files, Todo entries, mailbox, or the wake-up prompt.

## Skills

Create a skill when a procedure is reusable and benefits from explicit steps, scripts, or reference docs. A good skill has a sharp `description`, a short operating protocol, and optional resources loaded only when needed.

Do not create a skill for a single task, a vague preference, or knowledge that belongs in memory. If the agent merely needs a stable fact or heuristic, write a knowledge note instead.

## Codex subagents

Use subagents to keep the main agent's context focused. Good candidates are independent, decoupled stages that gather or inspect noisy context and can return a compact report, such as web research, broad file scans, source triage, planning, evaluation, or data extraction.

Do not create a subagent for trivial work, tightly coupled decisions that need the main agent's live context, or final business judgment. The main agent remains the router and decision-maker.

When creating `.codex/agents/<name>.toml`, define:

- a single responsibility and a trigger-oriented `description`;
- the expected task packet from the main agent: objective, pointers, constraints, and desired evidence;
- read/write and side-effect boundaries;
- a compact return contract: conclusion, key evidence or sources, confidence, unresolved risks, and recommended next action.

In `AGENTS.md`, teach the main agent to send pointers and scarce facts to subagents, not raw dumps, and to absorb only the distilled report back into its own reasoning.

## Common mistakes

- Putting business ownership in a skill instead of `AGENTS.md`.
- Creating subagents before defining the main agent's routing and decision contract.
- Making a subagent for every step; handoff overhead only pays off for noisy, bounded, or parallelizable work.
- Letting multiple write-capable subagents edit the same files without disjoint ownership.
- Encoding a one-off project plan as a permanent skill.
