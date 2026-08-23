# Apply progress: Developer 1 WDK Blockchain Flow

## Status

Standard mode (`strict_tdd: false`). All eleven implementation tasks are
complete. The user explicitly authorized a task-level closure amendment that
accepts the recorded production `handleMessage` agent + bundled `wdk-mcp` E2E
as the equivalent runtime harness for tasks 2.2 and 3.2; no duplicate
broadcast is required.

## Completed tasks

- [x] 0.1 Shared Node/WDK bootstrap and reproducible lockfile.
- [x] 1.1 MCP boundary lifecycle, timeouts, protocol/schema checks, and closure tests.
- [x] 1.2 Staged sanitized failures covering WDK-EVID-006 cases.
- [x] 1.3 Official MCP stdio client with fixed bundled executable and no retry.
- [x] 1.4 Wallet read/history variants and sensitive-evidence rejection.
- [x] 1.5 Raw wallet-read handoff and sanitized fixture templates.
- [x] 2.1 Operator-gated Sepolia USD₮ preview harness.
- [x] 2.2 Approved one-shot `dryRun: false` capture, accepted through the
  documented production agent/MCP equivalent harness.
- [x] 2.3 Preview/broadcast/failure/closure templates and fixture audit.
- [x] 3.1 Architecture and Developer B handoff documentation.
- [x] 3.2 Approved production-agent read/broadcast/receipt/lock evidence,
  accepted through the documented equivalent harness.

## Closure acceptance amendment

The user authorized closure without another transfer. The production
`handleMessage` path exercised the configured real model, guarded agent,
bundled `wdk-mcp`, and the same approved candidate/confirmation boundary, so
it is accepted for tasks 2.2 and 3.2. The named `WDK_LIVE=1` manual harnesses
are preserved as optional reproducibility paths only; they must not be used to
broadcast again.

## Root-supplied live agent/MCP E2E evidence (sanitized)

**Provenance:** supplied to this apply agent by the root coordinator after the
live run. This record is not an independent wallet/network rerun by the apply
agent. One persistent agent session,
`0fee5dbd-b26a-4d73-a935-70bcc34290e5`, used the configured real model,
`handleMessage`, the guarded agent tools, and bundled `wdk-mcp`.

1. Preview returned `confirmation_required` for wallet `agent-dev`, Sepolia,
   alias `usdt-test`, contract
   `0xc4DCC311c028e341fd8602D8eB89c5de94625927`, recipient
   `0xbAf7534493606883085669DB520ED7374dF0c940`, decimal amount `1`, and
   `1000000` base units. The preview fee estimate was `0.00007200 ETH`
   (`72008568883520` base units).
2. The literal `confirm` message in that same session returned `sent` once
   with transaction hash
   `0x6b3160ff814e5876ae5e264893e74a1be66f3eb10fc6f3ddee50b5d8e1f4084b`.
   WDK reported `0.00006909 ETH` for that broadcast.
3. Independent Sepolia receipt inspection reported status `0x1`, block
   `0xb0346a`, matching USD₮ transfer contract/from/to fields, event data
   `0x0f4240`, `gasUsed` `0x86ca`, and `effectiveGasPrice` `0x427729e8`.
   The computed on-chain execution fee was `0.000038477839630608 ETH`.
   These are distinct values: preview estimate, WDK-reported fee, and actual
   receipt-derived gas fee must not be treated as interchangeable.
4. Post-run USD₮ balances were `3998` for the sender and `1002` for the
   recipient. The agent session retained the transaction hash and had neither
   a pending transfer nor uncertain broadcast state. The server was stopped.
5. Closure was confirmed with `wdk wallet lock --name agent-dev --json`:
   exit `0`, `locked: true`. A subsequent protected token-balance operation
   exited `1` with `WALLET_NOT_UNLOCKED`.
6. Pre-live local verification supplied by root: full suite `62` passed and
   `5` skipped; typecheck, build, and `git diff --check` passed.

This proves the production agent route's preview, explicit confirmation,
single reported receipt, independent receipt evidence, and lock boundary. By
the user-authorized task-level acceptance amendment, it completes tasks 2.2
and 3.2 without asserting that the exact `WDK_LIVE=1` Vitest commands ran.

## Agent/MCP safety follow-up

This implementation follow-up performed no live wallet action itself; the
subsequent root-supplied production E2E evidence is recorded separately above.
Together with the user-authorized acceptance amendment, it closes the Developer
1 task set without inventing a direct-harness transcript.

- Replaced the agent's separate AI SDK MCP subprocess path with an adapter over
  the same fixed bundled `WdkMcpClient` boundary used by direct reads. The live
  client is shared across calls, opened/discovered once, and closed/recreated
  only after a call error or during shutdown.
- Raw MCP `content[].text` JSON is decoded before it reaches the agent; an
  `isError: true`, absent text result, or invalid JSON is a staged failure,
  never a successful wallet/API payload.
- A broadcast now requires the literal confirmation turn, matches network,
  token, recipient, amount, **and wallet**, and atomically consumes the pending
  preview before dispatch. Confirmation authorization is revoked if that turn
  does not use it, preventing replay in a later turn.

| Work unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
| --- | --- | --- | --- |
| Agent/MCP safe execution | `npx vitest run tests/unit/wallet-agent-guard.test.ts tests/unit/wallet-agent-deterministic.test.ts tests/unit/wdk-tools.test.ts` (available focused verification; not rerun in this cleanup). Historical evidence used the removed `wdk-tools.live.test.ts`; that file is no longer reproducible. | `WDK_AGENT_E2E=1 WDK_AGENT_PREVIEW_APPROVED=1 npx vitest run tests/e2e/wallet-agent-live-preview.e2e.test.ts` (explicitly gated preview-only harness; not rerun in this cleanup). Historical metadata-only evidence used the removed `wdk-agent-tools.e2e.test.ts`; that file is no longer reproducible. | Revert `src/agent/wdk-tools.ts`, `src/agent/wallet-agent.ts`, `src/sessions/in-memory-store.ts`, and the focused tests. |

### Agent correction batch: real WDK envelopes and session concurrency

- **RED (historical):** `wallet-agent-wdk-results.test.ts` was used to expose missing real-envelope normalization, missing session serialization, and a fixture that still returned the non-WDK `transactionHash` shape. That test file has since been removed and the exact command is no longer reproducible.
- **GREEN:** the agent maps WDK preview `to`, contract `token`, base-unit
  `amount`, `amountFormatted`, `estimatedFee`, and `estimatedFeeFormatted`
  to an HTTP preview while the pending transfer retains the original alias,
  network, wallet, recipient, and decimal amount. It accepts `txHash`,
  `transactionHash`, and `hash` for broadcast receipts.
- **Concurrency:** every `handleMessage` call is serialized per session. A
  confirmation cannot be consumed by a concurrent non-confirming turn, and
  the first matching broadcast consumes the preview before WDK dispatch.
- **Lifecycle:** the shared client is opened and discovered once; call errors
  close it and clear it for a later retry, and shutdown closes the shared client.

| Work unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
| --- | --- | --- | --- |
| Agent response and concurrency correction | `npx vitest run tests/unit/session-store.test.ts tests/unit/wallet-agent-guard.test.ts tests/unit/wallet-agent-deterministic.test.ts tests/unit/wdk-tools.test.ts` (available focused verification; not rerun in this cleanup). Historical session-flow, WDK-result, and live-tool evidence used removed test files and is no longer reproducible by those exact commands. | `WDK_AGENT_E2E=1 WDK_AGENT_PREVIEW_APPROVED=1 npx vitest run tests/e2e/wallet-agent-live-preview.e2e.test.ts` (explicitly gated preview-only harness; not rerun in this cleanup). | Revert `src/agent/wallet-agent.ts`, `src/agent/wdk-tools.ts`, `src/sessions/in-memory-store.ts`, `src/contracts/http.ts`, agent fixtures, and the focused tests. |

### Agent correction batch: runtime policy and uncertain broadcast recovery

- **RED (historical):** `wallet-agent-policy.test.ts` was used to expose the
  original guard's missing live fail-closed policy and uncertain broadcast
  state. The exact historical command is not used as current verification.
- **GREEN:** `send_token` now checks the configured wallet, network, token,
  decimal cap, and comma-separated allowlist before both preview and broadcast.
  In live mode, a missing cap or allowlist is rejected. These checks are outside
  the LLM.
- **Uncertain broadcast:** once a broadcast executor throws after invocation,
  or returns a malformed/missing receipt after `dryRun:false`, the session
  records the candidate with `transactionHash: null`, rejects all new tool use
  as `broadcast_uncertain`, and communicates strict no-retry. The operator
  must reconcile on-chain, then explicitly send `reset-uncertain`.
- **Binding:** the HTTP server defaults to `127.0.0.1`; remote `HOST` exposure
  is explicit and still requires authentication and network controls.

| Work unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
| --- | --- | --- | --- |
| Runtime policy and uncertain state | `npx vitest run tests/unit/wallet-agent-policy.test.ts tests/unit/wallet-agent-deterministic.test.ts tests/unit/server-config.test.ts tests/unit/wallet-agent-guard.test.ts` (available focused verification; not rerun in this cleanup). | `WDK_AGENT_E2E=1 WDK_AGENT_PREVIEW_APPROVED=1 npx vitest run tests/e2e/wallet-agent-live-preview.e2e.test.ts` (explicitly gated preview-only harness; not rerun in this cleanup). | Revert policy/session/server/docs changes and focused tests. |

## Work Unit Evidence

| Work unit | Focused test command and exact result | Runtime harness command/scenario and exact result | Rollback boundary |
| --- | --- | --- | --- |
| 1 — Wave 0, boundary, reads, failures | `npx vitest run tests/integration/wdk-mcp.test.ts` → exit 0; 1 file, 21 tests passed, including a direct WDK core import smoke. `node --version` → `v26.4.0`; `npm ls @tetherto/wdk @tetherto/wdk-cli --depth=0` → exact requested versions. | The named `WDK_LIVE=1` integration command was not rerun. The user-authorized closure amendment accepts the sanitized production agent/MCP evidence above as equivalent; direct harness rerun is optional and must not broadcast again. | Revert `package.json`, `package-lock.json`, `tsconfig.json`, `src/wdk/`, and `tests/integration/wdk-mcp.test.ts`. |
| 2 — USD₮ proof, fixtures, closure, docs | `npx vitest run tests/integration/wdk-transfer.manual.test.ts` → exit 0; 3 passed, 2 operator-gated tests skipped. Fixture audit command returned no matches. | The named `WDK_LIVE=1 WDK_ALLOW_BROADCAST=1` manual harness was not rerun. The user-authorized closure amendment accepts the documented single production-agent broadcast/receipt/lock evidence; it is an optional reproducibility path only and must not duplicate the transfer. | Revert `tests/integration/wdk-transfer.manual.test.ts`, `tests/integration/wdk-fixtures/`, and `docs/architecture.md`. |

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
- The root-supplied production E2E evidences a Sepolia USD₮ preview, broadcast,
  receipt, post-balances, and wallet lock. The user accepted it as the
  equivalent task harness for closure. The direct `WDK_LIVE=1` commands remain
  optional reproducibility paths and carry a duplicate-broadcast risk if used
  without a new, separately approved candidate.
