# Proposal: Developer 1 WDK Blockchain Flow

## Intent and Outcome

Prove Track 1's WDK boundary. Supply Developer B sanitized MCP fixtures for wallet facts, preview, and testnet broadcast; document API → MCP → daemon → Sepolia flow and lifecycle.

## Scope

### In Scope

- `src/wdk/`: bundled `wdk-mcp` stdio lifecycle and reads.
- `tests/integration/wdk*`: smoke checks for reads, preview, broadcast, lock/TTL, failures.
- `docs/architecture.md`: versions, Sepolia/USD₮, RPC/indexer, schemas, lifecycle, limits, handoff.
- Wave 0: Node.js `>=22.18.0`; `@tetherto/wdk@1.0.0-beta.14`; `@tetherto/wdk-cli@1.0.0-beta.2`; dedicated limited-funds test wallet.

### Out of Scope / Non-goals

- Exclude Fastify/API, `ToolLoopAgent`, sessions, normalization, README, security, mainnet, persistence, and policy implementation.
- Developer B owns product spending-cap, recipient-allowlist, and conversational confirmation.

## Business Rules and Constraints

- Use bundled `wdk-mcp` stdio. Sepolia USD₮ is required; native ETH is gas only; no native-asset product fallback.
- Call `send_token(dryRun: true)` before a separately approved `dryRun: false` broadcast.
- Hand off raw amount, token, recipient, network, and fee evidence for Developer B's controls.
- `package.json`/lockfile are an authorized same-branch, shared Wave 0 bootstrap exception, not Developer 1 product ownership.
- Human operator may handle/back up seed, mnemonic, passphrase, or private key only through approved offline administration; these MUST NOT enter repository, fixtures, logs, transcripts, or SDD evidence. RPC/indexer/API credentials MUST NOT enter those artifacts.

## Capabilities

### New Capabilities
- `wdk-blockchain-evidence`: MCP lifecycle, wallet reads, transfer evidence, failures, and handoff fixtures.

### Modified Capabilities
- None.

## Approach

Pin runtime/dependencies; initialize MCP; verify Sepolia USD₮ reads/history; dry-run; gate broadcast; capture raw inputs/outputs, explorer/history, and lock behavior.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/wdk/` | New | WDK/MCP |
| `tests/integration/wdk*` | New | Smoke evidence |
| `docs/architecture.md` | New | Setup contract |
| `package.json`, lockfile | Shared exception | Wave 0 bootstrap |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Beta schemas or RPC/indexer differ | High | Pin/capture installed evidence |
| Hot-wallet/funding failure | Medium | Limited wallet, finite TTL, lock |
| History delayed/unavailable | Medium | Distinguish from empty |

## Rollback Plan

Remove WDK source/tests/docs and shared bootstrap edits; discard demo-wallet state. Revert dependents to mocked/unconfigured behavior; no mainnet or persisted secrets.

## Open Decisions / Assumptions

Wave 0 verifies RPC, recipient, indexer, and schemas. Sepolia USD₮, ETH-for-gas, Node, and dependency versions are fixed.

## Success Criteria

- [ ] MCP initializes with expected tools and runtime/dependency versions.
- [ ] Sepolia address/balance succeed; history succeeds or has a documented unavailable error.
- [ ] Dry-run proves no broadcast; approved USD₮ send returns a real hash and explorer/history evidence when available.
- [ ] Raw amount/token/recipient/network/fee fixtures, failures, and lock evidence reach Developer B.
