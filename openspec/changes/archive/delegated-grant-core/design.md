# Design: Delegated Grant Core (Slice 1)

## ADR-1 (G3): Grant mechanism — Hybrid: Privy Solana policies + PostgreSQL grants ledger

**Status:** Decided (evidence-based). **Date:** 2026-10-03.
**Input:** `.agent-workflow/tasks/financial-assistant-development/06-research-d4-privy-solana.md`
(16 dated primary sources, verified 2026-10-03).

### Context

Slice 1 must implement bounded delegated authorization. D-4 required choosing
between (a) a provider primitive, (b) an own server-side engine, or (c) on-chain
session keys. Decision D-4 approved by the user (G0): **hybrid** — Privy custody
and per-transaction enforcement via Solana signer policies, plus an own
PostgreSQL grants ledger for what Privy does not cover. On-chain session keys
are discarded with evidence.

### Evidence summary (all verified 2026-10-03; full citations in the research doc)

1. **Privy supports Solana mainnet/devnet/testnet** for embedded wallets with
   server-side signing (docs.privy.io/basics/react/advanced/configuring-solana-networks;
   docs.privy.io/wallets/overview/chains).
2. **Privy policy engine covers Solana per-instruction in enclave**:
   `chain_type: 'solana'`, rules over RPC methods (`signAndSendTransaction`),
   per-transfer max (`solana_system_program_instruction` → `Transfer.lamports lte`),
   recipient allowlist (`Transfer.to in [...]`), program allowlist, temporal window
   (`system.current_unix_timestamp gte/lt`)
   (docs.privy.io/controls/policies/example-policies/solana). Transfer policies
   live since May 2026 per the dated changelog
   (docs.privy.io/changelogs/product-updates).
3. **Documented limitation:** Solana policy evaluation does not resolve Address
   Lookup Tables — conditions on addresses inside an ALT make the policy fail
   closed. Irrelevant for simple SOL/SPL transfers, which do not use ALTs.
4. **Privy does NOT provide cumulative rolling-window caps** (per-tx max +
   static time windows only) — the own ledger covers this gap.
5. **One policy override per signer** — the ledger decides creation/rotation/
   revocation of that policy.
6. **On-chain session keys discarded:** MagicBlock session-keys require the
   destination program to validate the session token — unusable for
   `SystemProgram::Transfer` against arbitrary programs; no ERC-4337-like
   standard exists on Solana for this use case (github.com/magicblock-labs/session-keys,
   pushed 2026-05-26; no approved SIP).
7. **Alternatives evaluated and discarded:** Crossmint covers the 4 gate
   requirements natively (spending limit with interval reset, recipients,
   `expiresAt`, pre-broadcast enforcement) but is more custodial (user recovery
   method) and its per-signer email-OTP approval flow is incompatible with the
   voice UX; transfer-only scope. Turnkey/Para: cumulative cap also falls to the
   backend (or unverified Solana aggregate facts). SendAI kit has no delegation
   primitives (plain keypair in env — rejected security model).

### Decision

Two enforcement planes, one decision authority:

- **Privy plane (custody + per-tx enforcement):** embedded Solana wallet
  (user owner) + delegated signer (backend/agente) with one policy
  (`policyIds`): per-transfer max, recipient allowlist, temporal window.
  Evaluated in Privy enclave — not bypassable by our app server.
- **Postgres plane (ledger + what Privy lacks):** `delegated_grants` +
  `grant_audit_log`. The ledger is the **single decision authority**: it decides
  when to create/rotate/revoke the Privy policy; it enforces cumulative
  rolling-window cap, TTL/expiration, revocation, and audit at execution time.
- A grant-covered execution requires BOTH: the Postgres grant validation passes
  AND the Privy policy permits the transaction. Fail on either side degrades
  closed to preview + confirmation.

### Consequences

- Per-tx ceiling and destinations are enforced outside our process (enclave) —
  a compromised app server cannot sign beyond policy.
- Cumulative cap/audit live in Postgres, reconciled at execution time with the
  DB-level idempotency pattern (unique constraint), never in-memory counters.
- Policy rotation (one override per signer) is serialized through the ledger.
- Network of record for verification: **Solana devnet**; residual `testnet`
  conclusions carry no mainnet evidentiary value.

## Data Model

New migration `008_delegated_grants.sql` (mirror under `supabase/migrations/`):

```sql
-- Target schema (illustrative; final DDL lives in the migration)
delegated_grants
  id uuid pk
  user_id uuid fk -> users (internal UUID, app.user_id RLS like existing tables)
  wallet_id uuid fk -> user_wallets            -- D-6: one wallet per user today
  action text check in ('transfer')            -- extensible: swap in Slice 7
  chain text not null default 'solana'         -- validator plug-in key
  max_per_transfer numeric(20,0) not null      -- smallest unit (lamports)
  max_cumulative numeric(20,0) not null        -- rolling-window cap
  window_seconds int not null                  -- rolling window length
  recipients text[] not null default '{}'      -- base58 allowlist; empty = none allowed
  state text check in ('active','revoked','expired') not null default 'active'
  created_at, expires_at, revoked_at
  check (max_per_transfer <= max_cumulative)

grant_audit_log (append-only)
  id uuid pk
  grant_id uuid fk
  user_id uuid
  event text check in ('created','used','rejected','revoked','expired','policy_synced',
                       'policy_sync_failed')
  reason text            -- rejection/expiry reason code
  amount numeric(20,0)   -- consumed amount on 'used'
  detail jsonb           -- execution id, policy id, degradation info
  created_at
```

- RLS policies with `app.user_id` exactly like `user_wallets`/`signer_grants`.
- Append-only: no UPDATE/DELETE grants on `grant_audit_log`.
- Idempotency: execution claims reuse the `wallet_operations` unique-constraint
  pattern (`user_id` + `idempotency_key`); the grants ledger does not duplicate it.

## Components

1. **`src/wallet/grants/engine.ts`** — pure validation core:
   `evaluateGrant({grant, action, amount, recipient, now})` →
   `{decision: 'covered' | 'degrade', reason?}`. No I/O; clock injected.
2. **`src/wallet/grants/consumption.ts`** — rolling-window accounting: SQL
   aggregation over `grant_audit_log` used-events in the window; atomic
   consumption append within the execution transaction.
3. **`src/wallet/grants/validators.ts`** — chain validator plug-in interface;
   `solana` implementation validates base58 recipient format. Other chains fail
   closed (no validator registered).
4. **`src/wallet/grants/privy-policy-sync.ts`** — creates/rotates/revokes the
   signer's Privy Solana policy from ledger state. Idempotent; failure leaves the
   grant non-active (fail-closed) and appends `policy_sync_failed`.
5. **`src/api/grants.ts`** — `POST /v1/grants`, `GET /v1/grants`,
   `POST /v1/grants/:id/revoke`; identity via the configured
   `RequestIdentityProvider` (Privy bearer; demo mode caveat documented), pattern
   of `src/api/wallets.ts`. Registered in `src/server.ts`. The request carries
   authorization constraints but never a wallet ID; the server resolves the
   sole ready user wallet under D-2, verifies its chain matches the request, and
   fails closed on zero, multiple, or mismatched rows.
6. **Contract** — `src/contracts/http.ts` zod schemas + hand-mirrored types in
   `apps/nana-wallet/src/lib/api-types.ts` (same PR, hard repo rule).
7. **Frontend** — grants list + create/revoke UI (authenticated HTTP only; no
   voice path), following existing `features/wallet/` conventions.

## Sequence (grant-covered execution — target state; wired into the transfer flow in Slice 3)

```text
-- Grant-covered execution — target state; wired into the transfer flow in Slice 3
User voice turn → tool (existing preview/confirm flow)
  → WalletConversationService executes:
      1. evaluateGrant (engine, server-side, now)
         ├─ not covered → degrade: preview + explicit confirmation (existing flow)
         └─ covered →
      2. consumption check (rolling window, SQL, same tx as claim)
      3. append audit 'used' → 4. broadcast via provider (Privy policy enforces
         per-tx max/allowlist in enclave) → 5. finality → event
  Failure at any step after 2 → audit row + closed degradation, never silent.
```

Voice tools are NOT modified in this slice (no grant mutation by voice; Slice 4
handles voice-side classification).

## Design Rules

- Engine decisions are pure functions of (grant, request, clock) — fully unit
  testable without DB.
- No cached grant state: revocation/expiration checked per execution.
- Every reject/allow appends audit BEFORE any on-chain side effect.
- `claimConsumption` accepts only positive decimal integers in smallest units.
  Invalid or zero amounts return an `invalid_amount` rejection, append an audit
  row with a null amount, and never reach `BigInt`; the claim ledger enforces
  `amount > 0` as a database invariant.
- Legacy-row preservation policy (R4 remediation): fresh installs carry the
  fully validated named constraint `grant_claim_ledger_amount_positive_ck`;
  upgraded databases add the same named constraint `NOT VALID`, which preserves
  any historical append-only rows while still rejecting future INSERT/UPDATE
  violations. `parsePositiveAmount` is module-private (no external caller).
- Demo boundary: fixture `WDK_TOOLS_SOURCE=fixture` unchanged; Privy policy sync
  is exercised on devnet only; unit/integration tests use a fake policy client.
- Slice 1 has no denomination-safe Solana policy adapter. The production
  provisioner therefore fails closed; a ledger row may remain lifecycle-active
  but is non-executable until `provider_policy_id` is bound (`policyReady=false`).

## Open Questions (carried to apply/verify)

- D-7 remains ratifiable: the schema supports single- or multi-execution grants;
  multi-execution (cap/window) is the approved baseline. If the user changes it
  before Slice 3, only `consumption.ts` and the seed/UI copy change.
