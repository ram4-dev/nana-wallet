## Exploration: Developer 1 WDK and blockchain flow

### Current State

The repository is a documentation-only bootstrap. `openspec/config.yaml` records that there is no `package.json`, lockfile, source tree, test configuration, CI workflow, test runner, or executable test command. The canonical scope is `docs/wdk-agent-development-plan.md`; no WDK implementation exists yet and no runtime result can be claimed from this checkout.

The plan assigns Developer A (the requested Developer 1 scope) the following boundaries:

- `src/wdk/` — the application-side WDK integration that will later own MCP startup/client wiring and direct wallet reads.
- `tests/integration/wdk*` — real WDK/MCP smoke coverage, separate from Developer B's API tests.
- `docs/architecture.md` — WDK architecture, setup, lifecycle, and evidence.

The plan explicitly keeps `package.json` and the lockfile with Developer B. Developer A must request dependency/version changes instead of editing those files concurrently. Developer A also supplies real WDK schemas, fixtures, and explorer output to Developer B; Developer B owns the HTTP/API/session/agent contract.

The intended runtime is the bundled `@tetherto/wdk-cli` `wdk-mcp` server over stdio, routing wallet-dependent operations through the local WDK daemon. Human-operated CLI commands create/select/unlock/lock the dedicated testnet wallet; MCP does not expose those administration operations. The intended flow is one dedicated, minimally funded testnet wallet, a finite unlock TTL, reads through MCP, `send_token` with `dryRun: true`, explicit conversational confirmation handled by the application, then a second `send_token` call with `dryRun: false` and one real testnet broadcast. The plan's examples use Sepolia and USDT, but the exact network, token registry entry, RPC, recipient, and explorer still need to be selected and verified in Wave 0.

Current official WDK CLI documentation describes `@tetherto/wdk-cli@1.0.0-beta.2` and Node.js `>=22.18.0`; the installed version must be recorded by Developer A rather than assumed. The official MCP guide confirms that `wdk-mcp` is a standard stdio server, wallet-dependent tools require an unlocked wallet, `get_history` requires indexer configuration, and `send_token` defaults to preview mode. The preview/confirm sequence is client guidance only: an unlocked daemon does not enforce a second confirmation.

The precise result schema for the bundled CLI MCP tools is not present in this repository. Official docs list the input parameters and semantics, but the actual MCP `content`/`structuredContent` returned by the installed version must be captured during the manual proof. Developer A should hand Developer B raw, sanitized tool results plus the version/configuration context, not a guessed normalized schema.

### Affected Areas

- `src/wdk/` — later implementation of the stdio MCP client, process lifecycle, connection errors, and direct read adapters. It must preserve raw WDK facts and must not become an API/session/policy layer.
- `tests/integration/wdk*` — later live smoke tests or manually gated integration checks for MCP startup, address, balance, history, dry-run, broadcast, lock/TTL, and expected WDK failures. They require an explicitly provisioned test wallet and testnet; they cannot run from the current checkout.
- `docs/architecture.md` — later documentation of the API → MCP stdio → WDK daemon → testnet chain, wallet lifecycle, selected network/token/RPC/indexer, tool schemas, version evidence, and security limitations.
- `docs/wdk-agent-development-plan.md` — authoritative ownership and acceptance criteria. Developer A should not edit it as part of this change; any corrections should be coordinated with Developer B, who integrates shared-plan edits.
- `package.json` and lockfile — shared but owned by Developer B in Wave 0. Developer A must report required WDK packages/versions instead of changing them.
- `README.md` — shared claim surface. Developer A later verifies commands and WDK claims, but does not own the draft.
- External WDK CLI state — named wallet store, daemon socket, local configuration, RPC provider, token registry, and optional indexer. These are runtime prerequisites, not repository artifacts; secrets and seed material must never enter source, fixtures, logs, or transcripts.

Expected handoff contract to Developer B:

| Tool | Input schema from the bundled CLI MCP server | Required proof/result handoff |
| --- | --- | --- |
| `get_address` | `network?`, `index?`, `testnet?`, `wallet?` | Raw successful MCP result, selected network/wallet/index, address, CLI/Node versions. `network` may be omitted for an aggregate address query. |
| `get_balance` | `network?`, `token?`, `index?`, `testnet?`, `wallet?` | Raw native and/or registered-token result, unit/decimal interpretation, provider/network, wallet/address context. `token` is a registered ticker; aggregate mode is native-balance oriented. |
| `get_history` | `network`, `token?`, `limit?`, `index?`, `fromDate?`, `toDate?`, `wallet?` | Raw result or a documented `indexer unavailable` error, indexer configuration status without secrets, query parameters, and whether the broadcast appears after indexing. |
| `send_token` | Required `to`, `amount`, `network`; optional `token?`, `baseUnits?`, `index?`, `dryRun?`, `wallet?` | Raw dry-run preview including fee/estimate fields and raw execution result including the real transaction identifier. Preserve decimal-vs-base-unit mode and the exact parameters used in both calls. |

The documented examples indicate that the agent-facing send payload should retain `network`, `to`, `amount`, optional `token` and `wallet`, and explicit `dryRun`; the first call is preview (`true` or omitted), and the second is execution (`false`). Developer B needs the actual result fields, not only the plan's illustrative `estimatedFee`/`transactionHash` names.

Manual proof expected from Developer A, with no secret values recorded:

1. Verify Node.js and the exact installed WDK CLI/WDK dependency versions; report any package request to Developer B.
2. Create or select a dedicated wallet manually, set it as default or pass `wallet` explicitly, and unlock it with a short finite TTL. If backup is required, the human operator follows an approved offline wallet-backup procedure; seed, mnemonic, passphrase, and private key material must never enter the repository, fixtures, logs, transcripts, or SDD evidence. Never use `--ttl 0` for the recorded demo unless the security trade-off is explicitly accepted.
3. Verify the selected testnet, RPC/provider, native asset, and demo token registry entry. Configure the optional indexer only through the approved secret mechanism; do not persist keys in config, fixtures, or logs.
4. Start `wdk-mcp` using stdio, initialize the MCP session, list tools, and confirm the bundled names and input schemas.
5. Invoke `get_address`, `get_balance`, and `get_history`; classify history as working or unavailable with the exact error if the indexer is not configured/supported.
6. Invoke `send_token` with `dryRun: true` to a controlled recipient and small amount. Check recipient, network, token, amount, units, fee estimate, and that no broadcast occurred.
7. At a separate explicit manual gate, invoke the same request with `dryRun: false` using a small testnet amount. Capture the raw result, transaction hash, explorer URL, and eventual history observation.
8. Lock the wallet and verify the wallet is locked; record TTL expiry/lock behavior and any retry requirements.

### Approaches

1. **Bundled `wdk-mcp` over stdio with a human-managed wallet session (recommended)** — Run the official CLI MCP server as the bundled tool surface and keep wallet creation, unlock, lock, and durable configuration as manual CLI actions.
   - Pros: exactly matches the hackathon plan; keeps seed/passphrase outside the agent; uses the supported local daemon; gives Developer B the raw tools expected by `@ai-sdk/mcp`; preserves a clear Developer A/B boundary.
   - Cons: requires local CLI installation and a live unlocked wallet; the daemon trusts same-user processes; indexer/history availability depends on external configuration; result shapes can vary with beta versions.
   - Effort: Medium.

2. **WDK MCP Toolkit embedded in the application** — Register selected WDK tools directly in application code with `@tetherto/wdk-mcp-toolkit`.
   - Pros: application-controlled tool selection and schemas; potentially easier to mock and customize.
   - Cons: changes the chosen Track 1 bundled-CLI architecture; introduces a different package/API and wallet initialization model; absorbs Developer B's application integration concerns; cannot satisfy the requested proof of the bundled `wdk-mcp` lifecycle without also maintaining two paths.
   - Effort: High.

3. **Shelling out to `wdk` CLI commands instead of MCP** — Wrap `wdk get ...` and `wdk send ...` in application subprocesses.
   - Pros: easy manual inspection with `--json`; CLI command output is useful for diagnosing setup.
   - Cons: does not prove the MCP contract that the agent will consume; creates parsing/process-lifecycle coupling; conflicts with the plan's direct raw-MCP-tool decision; increases the chance of stdout/stderr and secret-handling mistakes.
   - Effort: Medium, but wrong for the requested integration gate.

### Recommendation

Proceed with the bundled `wdk-mcp` stdio path and a dedicated, minimally funded testnet wallet. Developer A should first produce a versioned setup/runbook and one sanitized evidence bundle from the real MCP server, then implement only `src/wdk/`, `tests/integration/wdk*`, and `docs/architecture.md` in the subsequent phases. Keep `package.json`, the lockfile, API routes, `ToolLoopAgent`, sessions, confirmation state, and HTTP response normalization with Developer B.

The proposal should require an integration gate before application integration is considered complete: MCP initializes and exposes the expected tools; address and balance succeed; history either succeeds with indexer evidence or is explicitly marked unavailable; dry-run returns a non-broadcast preview; a separately approved small testnet send returns a real transaction hash; the transaction is independently visible in the explorer or history when indexing permits; and the wallet is locked afterward. The handoff should include exact installed versions, selected network/token/RPC/indexer capability, exact input JSON for each call, raw sanitized result JSON, error envelopes for at least locked wallet, invalid recipient, insufficient funds, RPC failure, and unavailable history, plus the corresponding fixture mapping for Developer B.

### Risks

- The checkout has no implementation or test runner, so no live WDK proof can be performed until Developer B creates the Wave 0 project and dependencies. This exploration must not imply that any transaction has already been broadcast.
- WDK CLI documentation is beta and version-sensitive. Tool names, fields, output envelopes, and error codes must be captured from the installed version and pinned by Developer B; do not copy an undocumented output shape into an API contract.
- An unlocked wallet is a local hot-wallet session. Same-user processes can request signing or sending through the daemon without re-entering the passphrase, and client-side confirmation is not a daemon authorization boundary. Use a dedicated wallet with limited testnet funds, a finite TTL, and an explicit lock step.
- `get_history` may fail or return no recent transfer because indexer configuration, token `metadata.indexerSlug`, network support, or indexing delay is missing. The app must distinguish unavailable/stale history from a confirmed empty history.
- Sepolia and USDT are illustrative in the plan, not yet verified as the selected compatible registry entries. A native testnet asset may be the safer fallback if token funding or registration blocks the demo; this decision must be documented before fixtures are frozen.
- RPC availability, faucet/funding limits, token decimals, address-network mismatch, insufficient native gas, and explorer/indexer propagation can make a real broadcast fail or appear delayed. The manual proof must record these as environment evidence rather than changing API scope.
- Recording full MCP results can accidentally disclose addresses, provider URLs, indexer keys, or secret-adjacent runtime details. Redact credentials and seed/passphrase material; preserve public transaction/address values only where needed for reproducibility.
- Running the agent and WDK daemon under the same OS account weakens isolation. The demo scope accepts this trade-off, but `docs/architecture.md` must label it as local hot-wallet behavior and not production security.

### Ready for Proposal

Yes, for a constrained Developer 1 WDK/blockchain proposal. The proposal should state that implementation starts from a documentation-only repository, keeps dependency ownership with Developer B, uses the bundled stdio `wdk-mcp` server, and treats the live wallet/broadcast evidence as a manual-gated integration prerequisite. It should leave the exact testnet/token, installed beta version, RPC, indexer availability, and observed result/error schemas as explicit Wave 0 decisions, not assumptions.

Primary evidence:

- `docs/wdk-agent-development-plan.md` — objective, direct-tool architecture, WDK surface, Developer A ownership, waves, smoke requirements, and out-of-scope boundary.
- `openspec/config.yaml` — documentation-only repository state, unavailable testing, OpenSpec persistence, and testnet/demo constraints.
- [WDK CLI: Use the MCP Server](https://docs.wdk.tether.io/cli/guides/use-mcp-server/) — stdio transport, wallet lifecycle, available tools, preview/confirm semantics, and MCP administration boundary.
- [WDK CLI: API Reference](https://docs.wdk.tether.io/cli/api-reference/) — current beta command/options and JSON/error handling.
- [WDK CLI repository README](https://github.com/tetherto/wdk-cli) — current CLI/MCP architecture and documented tool parameter surface.
- [WDK CLI: Security Model](https://docs.wdk.tether.io/cli/reference/security-model/) — same-user daemon trust boundary, TTL behavior, and hot-wallet limitations.

## Key Learnings

1. The repository is a documentation-only bootstrap, so Developer A cannot honestly claim live WDK or test evidence yet.
2. The bundled `wdk-mcp` stdio server is the intended integration boundary, while wallet administration remains human-operated CLI work.
3. `send_token` preview and confirmation are client workflow guidance rather than daemon-enforced authorization controls.
4. Exact MCP result envelopes must come from the installed beta version because repository documents only define the input surface and semantics.
5. Developer B owns dependency manifests and application contracts, so Developer A should hand off sanitized fixtures without expanding scope.
