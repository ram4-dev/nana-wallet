# Tasks: Developer 1 WDK Blockchain Flow

## Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 420–520 lines |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Logical units: Wave 0 → boundary/reads → manual evidence/docs |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

Same branch; size exception accepted.

### Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Wave 0, MCP boundary, reads, failures | Same branch | `npx vitest run tests/integration/wdk-mcp.test.ts` | `WDK_LIVE=1`; unlocked Sepolia wallet | Revert package, WDK, read/test files |
| 2 | USD₮ proof, fixtures, closure, docs | Same branch | `WDK_LIVE=1 WDK_ALLOW_BROADCAST=1 npx vitest run tests/integration/wdk-transfer.manual.test.ts` | One Sepolia USD₮ broadcast; ETH gas-only; lock/TTL; opt-in only | Revert transfer artifacts; retire wallet |

## Phase 0: Bootstrap

- [x] 0.1 **GREEN:** Create `package.json`/`package-lock.json` with `engines.node: ">=22.18.0"`, exact direct `@tetherto/wdk@1.0.0-beta.14` and `@tetherto/wdk-cli@1.0.0-beta.2`, plus only needed TypeScript/Vitest/MCP tooling. Verify `node --version`, `npm ls @tetherto/wdk @tetherto/wdk-cli`, and `npx vitest run --passWithNoTests`; rollback package files.

## Phase 1: Boundary/Reads (RED → GREEN → REFACTOR)

- [x] 1.1 **RED:** `tests/integration/wdk-mcp.test.ts` covers bundled executable/no shell, allowlisted env, handshake/call timeouts, exit, protocol/schema errors, close, no restart. Depends 0.1; run `npx vitest run tests/integration/wdk-mcp.test.ts`; rollback file.
- [x] 1.2 **RED (WDK-EVID-006):** Same file: discovery/connection/schema, invalid recipient/validation, RPC/indexer unavailable, gas, insufficient Sepolia USD₮, locked/expired wallet, preview/broadcast failures, uncertain broadcast; assert stage, sanitized error/status. Depends 1.1; run command; rollback additions.
- [x] 1.3 **GREEN:** Create `src/wdk/mcp-client.ts` for bounded stdio/raw invocation, sanitized stderr, staged failures, closure, no uncertain retry; no cap/allowlist/freshness/matching/one-shot/replay/confirmation guards (Developer B). Depends 1.2; evidence green; run same command; rollback file.
- [x] 1.4 **RED:** Add Sepolia address, test USD₮ balance, history (`unavailable|stale|empty|non-empty`), and secret rejection. Depends 1.3; run `npx vitest run tests/integration/wdk-mcp.test.ts`; rollback additions.
- [x] 1.5 **GREEN → REFACTOR:** Create `src/wdk/direct-wallet-reads.ts` and sanitized fixtures in `tests/integration/wdk-fixtures/`, preserving WDK shapes/context. Depends 1.4; evidence green; run same command; rollback paths.

## Phase 2: Manual Evidence

- [x] 2.1 **RED:** Add operator-gated `tests/integration/wdk-transfer.manual.test.ts`: Sepolia test USD₮ `dryRun:true` links recipient/token/amount/network/fee with no broadcast; record input equality. Skip broadcast without env. Depends 1.5; run `npx vitest run tests/integration/wdk-transfer.manual.test.ts`; rollback file.
- [ ] 2.2 **GREEN:** Extend `src/wdk/mcp-client.ts` only for raw `send_token` evidence and `dryRun:false` capture; preserve `baseUnits`, fee/gas, hash, verification fields for Developer B; implement none. Depends 2.1; run `WDK_LIVE=1 WDK_ALLOW_BROADCAST=1 npx vitest run tests/integration/wdk-transfer.manual.test.ts`; rollback additions.
- [x] 2.3 **REFACTOR/VERIFY:** Populate preview/broadcast/failure/closure fixtures; audit `rg -n -i --glob '*.json' '(seed|mnemonic|passphrase|private.?key|api.?key|credential|secret.?config)' tests/integration/wdk-fixtures`; reject matches and normalized/API/session fields. Depends 2.1 evidence-contract implementation; rollback fixtures.

## Phase 3: Handoff

- [x] 3.1 Update `docs/architecture.md` with active spec `openspec/changes/developer-1-wdk-blockchain-flow/specs/wdk-blockchain-evidence/spec.md`, versions, Sepolia USD₮/ETH-gas-only boundary, raw fields, lifecycle, failures, gate, handoff. Verify `rg -n 'wdk-mcp|22.18.0|beta.14|beta.2|Sepolia|USD₮|gas|dryRun|locked|expired|unavailable|stale' docs/architecture.md`; rollback docs.
- [ ] 3.2 Run reads with `WDK_LIVE=1 npx vitest run tests/integration/wdk-mcp.test.ts`; launch one approved broadcast only with `WDK_LIVE=1 WDK_ALLOW_BROADCAST=1 npx vitest run tests/integration/wdk-transfer.manual.test.ts`. Record hash/explorer or unavailable, lock/TTL, protected-call failure; rollback run artifacts/wallet.
