---
name: nana-wallet-flow
description: Trigger when starting any Nana Wallet feature or change. Covers the repo's two-stage development flow — stage 1 .agent-workflow/ (human/planning RPI scaffolds, the intake / research questions / design discussion side) and stage 2 openspec/ (implementation SDD, proposal through archive) — plus pointers to AGENTS.md and docs/.
license: Apache-2.0
---

# Nana Wallet development flow

Nana Wallet (Aleph Hackathon 2026, WDK Track) is a monorepo: backend at the repo
root (`src/`, `tests/`, `evals/`) and frontend in `apps/nana-wallet/`. They are
strictly separated; never cross the boundary.

## Two-stage flow — think first, then implement

Every feature goes through two stages with a hard line between **planning** and
**writing code**.

### Stage 1 — human planning (`.agent-workflow/`)

Before writing code, plan in `.agent-workflow/`. This is the RPI flow: intake,
research questions, design discussion. It is the human/planning side — define the
problem, surface the research questions, and discuss the design without touching
code. If a feature has no scaffold there yet, create one first.

### Stage 2 — implementation (`openspec/`)

Once the design is clear, implement through `openspec/` (SDD):

```
proposal → spec → design → tasks → apply → verify → archive
```

Artifacts live in `openspec/changes/<change>/`; the root context is
`openspec/config.yaml`. Each phase validates against the previous one; `apply`
writes code and `verify` checks the result against the spec.

## Where to look

- `AGENTS.md` — hard rules (front/back separation, security, mandatory PR validation), conventions.
- `docs/architecture.md` — architecture, evidence boundaries, WDK boundary.
- `docs/api.md` — HTTP `/v1` contract (source of truth: `src/contracts/http.ts`).
- `docs/evals.md`, `docs/demo-runbook.md`, `docs/local-live-runbook.md`,
  `docs/livekit-development-runbook.md`, `docs/create-wallet.md` — evals and runbooks.
- `openspec/config.yaml` — canonical planning document pointer and change rules.

## Quick checks

- Read `AGENTS.md` before editing.
- Canonical token alias is `USDT` (default `WDK_TOKEN`).
- Default `WDK_TOOLS_SOURCE=fixture`; live is explicit and gated.
