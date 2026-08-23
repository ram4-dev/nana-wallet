# Apply progress: Developer 1 WDK Blockchain Flow

## Status

Standard mode (`strict_tdd: false`). Nine of eleven implementation tasks are
complete. No wallet was created, imported, unlocked, funded, or deleted. No
live read, `dryRun: false` call, or broadcast was attempted.

## Completed tasks

- [x] 0.1 Shared Node/WDK bootstrap and reproducible lockfile.
- [x] 1.1 MCP boundary lifecycle, timeouts, protocol/schema checks, and closure tests.
- [x] 1.2 Staged sanitized failures covering WDK-EVID-006 cases.
- [x] 1.3 Official MCP stdio client with fixed bundled executable and no retry.
- [x] 1.4 Wallet read/history variants and sensitive-evidence rejection.
- [x] 1.5 Raw wallet-read handoff and sanitized fixture templates.
- [x] 2.1 Operator-gated Sepolia USD₮ preview harness.
- [x] 2.3 Preview/broadcast/failure/closure templates and fixture audit.
- [x] 3.1 Architecture and Developer B handoff documentation.

## Pending live-only tasks

- [ ] 2.2 Run the human-approved `dryRun: false` capture path.
- [ ] 3.2 Run an unlocked dedicated-wallet read, a separately approved one-shot
  broadcast, verification, and lock/TTL protected-call evidence.

The blocker is intentional: no separately approved candidate, dedicated wallet,
funding, recipient, or human broadcast authorization was supplied. The manual
harness remains dormant unless its explicit opt-in environment gates are set.

## Work Unit Evidence

| Work unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
| --- | --- | --- | --- |
| 1 — Wave 0, boundary, reads, failures | `npx vitest run tests/integration/wdk-mcp.test.ts` → exit 0; 1 file, 21 tests passed, including a direct WDK core import smoke. `node --version` → `v26.4.0`; `npm ls @tetherto/wdk @tetherto/wdk-cli --depth=0` → exact requested versions. | `WDK_LIVE=1 npx vitest run tests/integration/wdk-mcp.test.ts` was not run: it requires an unlocked dedicated wallet and a human operator. No runtime claim is made. | Revert `package.json`, `package-lock.json`, `tsconfig.json`, `src/wdk/`, and `tests/integration/wdk-mcp.test.ts`. |
| 2 — USD₮ proof, fixtures, closure, docs | `npx vitest run tests/integration/wdk-transfer.manual.test.ts` → exit 0; 3 passed, 2 operator-gated tests skipped. Fixture audit command returned no matches. | `WDK_LIVE=1 WDK_ALLOW_BROADCAST=1 npx vitest run tests/integration/wdk-transfer.manual.test.ts` was not run: no separately approved candidate or broadcast authorization exists. | Revert `tests/integration/wdk-transfer.manual.test.ts`, `tests/integration/wdk-fixtures/`, and `docs/architecture.md`. |

## Verification log

| Command | Result |
| --- | --- |
| `npm run build` | Exit 0 (`tsc --noEmit`). |
| `npm run typecheck` | Exit 0 (`tsc --noEmit`). |
| `npm test` | Exit 0; 2 files passed, 1 E2E file skipped; 24 tests passed, 3 opt-in tests skipped. |
| `npx vitest run --passWithNoTests` | Exit 0; 24 passed, 3 skipped result after E2E creation. |
| `WDK_E2E=1 npx vitest run tests/e2e/wdk-mcp-connection.e2e.test.ts` | Exit 0; real bundled `wdk-mcp` stdio initialization, tool discovery, `get_networks(testnet:true)`, and raw `get_token(sepolia, usdt)` passed; 1 test passed. |
| `npm audit --omit=dev --json` | The direct MCP SDK finding is cleared after pinning `@modelcontextprotocol/sdk@1.30.0`; 3 production findings remain (2 moderate, 1 high), all with major-version fixes only. |
| `rg -n -i --glob '*.json' '(seed|mnemonic|passphrase|private.?key|api.?key|credential|secret.?config)' tests/integration/wdk-fixtures` | No matches. |
| Required documentation keyword check | Exit 0; all required terms found in `docs/architecture.md`. |
| `git diff --check` | Exit 0. |

## Implementation decisions and deviations

- The official `@modelcontextprotocol/sdk` stdio transport is used rather than
  `@ai-sdk/mcp`, which is permitted by the design and keeps this Developer 1
  boundary independent of the Agent/API layer.
- Fixture files are explicit `not-run` or blocked templates, never fabricated
  wallet outcomes. They preserve the handoff shape while preventing false live
  evidence claims.
- The manual broadcast test needs `WDK_LIVE=1`, `WDK_ALLOW_BROADCAST=1`, and
  `WDK_BROADCAST_APPROVED=1`, as well as an operator candidate; it is not run
  by the normal suite or CI.
- Official WDK documentation was cross-checked against the installed beta.2
  package: `wdk-mcp` is a stdio server over the same local daemon, the seven
  product tools are a subset of its nine registered tools, `send_token`
  defaults to `dryRun: true`, and the daemon itself does not enforce a client
  confirmation prompt. MCP Toolkit, agent skills, OpenClaw, and x402 are
  alternatives outside this Track 1 implementation.
- Follow-up review corrected the raw MCP result path: `isError: true` is now a
  staged failure rather than wallet data, `content[0].text` JSON can supply a
  transaction hash, and the manual candidate rejects every token except
  Sepolia `usdt` so ETH cannot become a product-transfer fallback.
- A second review added the uncertain-broadcast failure envelope, authenticated
  URL/token sanitization, fixture-contract assertions, explicit-only indexer
  injection, and a direct pinned EVM wallet module. The direct WDK beta.14
  import smoke passes, while the CLI's own beta.6 dependency remains a known
  separate package boundary.
- A final review moved candidate validation ahead of every MCP dispatch,
  distinguishes a pre-dispatch failure from an uncertain dispatched broadcast,
  preserves sanitized error labels, redacts case-insensitive Bearer/Basic
  credentials, and limits explicit indexer injection to `WDK_INDEXER_API_KEY`.
  The CLI beta.2 indexer base URL remains a human-managed CLI configuration.
- Security follow-up upgraded the direct `@modelcontextprotocol/sdk` pin from
  `1.20.2` to `1.30.0`; `npm ls` now shows that version both directly and
  deduped for the pinned WDK CLI.
- Safe real-connection evidence is separate from wallet evidence: the opt-in
  E2E completed MCP initialization against the installed bundled server and
  verified the built-in Sepolia `usdt` raw result (registered address and 6
  decimals) without a wallet, secret, `send_token`, or transaction broadcast.

## Risks and remaining blockers

- Production audit now reports 3 vulnerabilities: direct
  `@tetherto/wdk-wallet-evm@1.0.0-beta.11` is moderate via `ethers`; `ethers`
  is moderate via `ws`; and transitive `ws` is high for the affected 8.x
  range. Each available remediation is major-version-only, so no forced WDK
  beta change was applied.
- The exact pinned WDK CLI postinstall is approved through npm. The
  reproducible Sepolia path relies on the directly locked root EVM module,
  rather than treating any nested postinstall module as lockfile evidence.
  This does not prove a wallet configuration or live chain operation.
- Actual Sepolia test USD₮ registration, indexer availability, wallet lock/TTL,
  fee, hash, and explorer/history verification remain unproven until tasks 2.2
  and 3.2 are executed with separately approved testnet inputs.
