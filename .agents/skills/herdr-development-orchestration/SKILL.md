---
name: herdr-development-orchestration
description: "Trigger: orquestar desarrollo en Herdr, tab dedicada, retomar sesión. Aísla, coordina, preserva y cierra sesiones de desarrollo."
license: Apache-2.0
metadata:
  author: "ramiro"
  version: "1.0"
---

## Activation Contract

Load this skill when development must run through Herdr in dedicated tabs, including parallel work, cleanup, or contextual resumption.

## Hard Rules

- Require `HERDR_ENV=1`; otherwise stop without controlling Herdr.
- Require a fresh Worktrunk worktree before creating the Herdr development tab. The tab cwd must be that worktree, never the source worktree.
- Create one dedicated tab per development in `HERDR_WORKSPACE_ID`; do not create another workspace unless explicitly requested.
- Start implementation with Pi using `nan/glm5.3-flash` and reasoning `high`. Never lower reasoning to bypass limits; reduce concurrency, sequence work, split it, or wait.
- Pi may delegate to internal subagents. Keep their reasoning at `high` when configurable; they do not need their own Herdr panes or the same model as the parent Pi session.
- Record every created tab and pane plus each `agent_session.value` in the task receipt. Never record secrets.
- Keep unrelated tabs and panes untouched. Close exactly the tabs created for completed development after results and verification are durable.
- Resume by creating a new tab in the same workspace and starting the agent with the recorded session reference and reasoning `high`.

## Decision Gates

| State | Action |
|---|---|
| New development | Create a labeled tab with `--no-focus` |
| Bounded supporting work | Allow Pi internal subagents and record material results |
| Independent visible session | Split a pane and start another explicit Pi/GLM `high` agent |
| Provider limit | Lower parallelism; keep reasoning `high` |
| Paused work | Preserve session reference before closing |
| Completed and verified | Close the recorded tab and confirm absence |
| Resume | New tab, same cwd, recorded session |

## Execution Steps

1. Load `worktree-first-development`, read `references/tab-session-runbook.md`, and create `.agent-workflow/tasks/<slug>/herdr-session.md` from the receipt asset.
2. Snapshot git state and current topology; create and record the fresh Worktrunk worktree before the dedicated tab.
3. Create the dedicated tab in the current workspace with the worktree as cwd.
4. Start top-level agents with explicit names, cwd, provider, model, and reasoning. Capture returned IDs; never infer them.
5. Dispatch bounded roles, wait for settled states, inspect outputs, and independently verify implementation.
6. Update the receipt with worktree, session references, checks, and resumption data.
7. Close only recorded tabs after completion or safe pause; list tabs to prove cleanup.

## Output Contract

Return task slug, workspace/tab IDs, agent/session references, model and reasoning, checks, cleanup proof, and exact resumable state. Do not expose credentials.

## References

- `references/tab-session-runbook.md`
- `assets/development-session-receipt.md`
