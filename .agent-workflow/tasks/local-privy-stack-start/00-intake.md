# Local Privy stack startup

Date: 2026-10-22

## Outcome

Diagnose the live-voice startup failure and provide a repeatable command that starts the local frontend, API, LiveKit, worker, and required Privy signing services against the existing Nana Wallet remote Supabase project.

## Acceptance evidence

- The existing allowlisted origin remains `https://nana-privy.localhost`, without a port suffix.
- Frontend, API, and browser LiveKit signaling use HTTPS/WSS consistently.
- The real browser reaches the binding endpoint without CORS or mixed-content failures.
- Startup verifies remote database connectivity, required services, and routing. A frontend HTTP 200 alone does not constitute success.
- A second run reuses or replaces only owned processes and containers.
- Automated regression checks use disposable local data. Remote startup checks are read-only; authenticated live voice remains a separately reported manual check unless explicitly exercised.
- Documentation gives the command, first-run system authorization, readiness criteria, logs, and recovery steps.

## Authority and boundaries

The user requested investigation, documentation, and changes for one-command startup. Prior instructions require remote Supabase, the existing Privy domain, and Vault-managed secrets. The Nana Landing waitlist project must remain untouched.

Read scope: launch scripts, Compose, frontend development configuration, runbooks, current non-secret runtime settings, and read-only health/database probes.

Proposed implementation scope: startup tooling, frontend proxy configuration, tests, and documentation. No payment behavior, migrations, remote project creation, broad CORS wildcard, or unrelated worktree/container cleanup.

## Route and gate

Selected route: HumanLayer RPI. Existing launch paths disagree about origins, database targets, signing services, and readiness. The cross-service launcher needs a concrete design decision before implementation. SDD will own implementation after the required gates.

Active gate: design revision 1 proposed in `03-design-discussion.md`. No product code or launch configuration has been changed in this task.

## Worktree receipt

- Repository: `/Users/ramiro/Desktop/projects/colloseum`
- Source branch: `main`
- Source commit: `22cb8e18b72a4e356aa5035bfd19660db7b82f1e`
- Task branch: `fix/local-privy-stack-start`
- Worktree: `/Users/ramiro/Desktop/projects/colloseum.fix-local-privy-stack-start`
- Creation: `wt switch --create fix/local-privy-stack-start`
- Cleanup: retained for resumption; unrelated source work and existing worktrees preserved.
