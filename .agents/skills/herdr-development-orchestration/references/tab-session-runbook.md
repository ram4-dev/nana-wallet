# Herdr dedicated-tab runbook

Use the installed `herdr` and `pi` binaries as the syntax authority. Run `herdr tab <command> --help`, `herdr agent <command> --help`, and `pi --help` when versions change.

## 1. Establish caller scope

```bash
test "${HERDR_ENV:-}" = 1
test -n "${HERDR_WORKSPACE_ID:-}"
test -n "${HERDR_PANE_ID:-}"
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
```

Treat `HERDR_WORKSPACE_ID` as the current space. Keep the caller focused and create development tabs with `--no-focus`.

## 2. Create a development tab

```bash
herdr tab create \
  --workspace "$HERDR_WORKSPACE_ID" \
  --cwd "$PWD" \
  --label "<task-slug>" \
  --no-focus
```

Parse `.result.tab.tab_id` and `.result.root_pane.pane_id` from the JSON response. Write both to the receipt before starting work. For another role in the same development, split from an explicit pane ID and keep focus unchanged:

```bash
herdr pane split --pane "<pane-id>" --direction right --cwd "$PWD" --no-focus
```

Use another explicit Herdr pane when a role needs its own visible lifecycle, durable session reference, or independent resumption. Pi may also use internal subagents for bounded supporting work; they may use a different model from the top-level Pi session. Keep their reasoning at `high` when configurable and record material delegated results in the receipt.

## 3. Start Pi with the required capability

```bash
herdr agent start "<unique-agent-name>" \
  --kind pi \
  --pane "<pane-id>" \
  -- \
  --provider nan \
  --model glm5.3-flash \
  --thinking high \
  --name "<task-slug>"
```

Wait until startup is stable before the first prompt. If `agent_prompt_stalled` occurs, inspect `herdr agent get`, `herdr agent explain`, and `herdr agent read`; retry only after the agent is confirmed ready. Do not lower reasoning.

After the first persisted turn, capture the exact session reference:

```bash
herdr agent get "<unique-agent-name>"
```

Record `.result.agent.agent_session.kind`, `.source`, and `.value`. Pi currently reports a session file path; treat the reported shape as authoritative rather than assuming it.

## 4. Coordinate and verify

Use `herdr agent prompt <name> <prompt> --wait --timeout <ms>`. A settled state is not implementation proof: inspect the final output and run the repository's unit, integration, typecheck, lint, build, and E2E checks that apply. If the provider throttles, run fewer agents concurrently or sequence them while retaining `high`.

## 5. Close cleanly

Before closing, ensure results are durable and the receipt contains every session reference. Then close the recorded task tab and prove it is absent:

```bash
herdr tab close "<created-tab-id>"
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
```

Never close by tab number, label, focus, or guessed ID. Never close a pre-existing tab.

## 6. Resume from context

Create a fresh dedicated tab in the same workspace and cwd. Start Pi in its returned root pane with the recorded session value:

```bash
herdr agent start "<new-unique-agent-name>" \
  --kind pi \
  --pane "<new-root-pane-id>" \
  -- \
  --session "<recorded-agent-session-value>" \
  --provider nan \
  --model glm5.3-flash \
  --thinking high
```

Confirm `herdr agent get` reports the same session value before prompting. On final completion, close the newly created resume tab and update the receipt.
