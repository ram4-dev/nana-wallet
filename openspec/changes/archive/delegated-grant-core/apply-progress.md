# Apply Progress: Delegated Grant Core — Phase 8 Remediation

## Batch: Task 8.7 (R4-claim-amount-not-validated-before-bigint) — 2026-10-04

### Status: code complete — validation NOT executed (Hermes owns PR testing)

### What changed

1. **`src/wallet/grants/consumption.ts`**
   - New module-private `parsePositiveAmount(raw: unknown): string | null` (not
     exported; no external caller):
     - Runtime type guard: non-string input returns `null` (never throws).
     - Accepts plain digits or correctly underscore-grouped thousands
       (`1_000_000`); rejects `_1`, `1__0`, trailing `_`, empty, fractional,
       negative, and zero.
     - Returns the canonical decimal string, or `null` when malformed or
       non-positive. BigInt is only invoked after regex validation, so it
       cannot throw.
   - `claimConsumption` now validates the amount BEFORE any BigInt/integer
     math. On `null`: returns `{ consumed: false, reason: "invalid_amount" }`,
     appends a `rejected` audit row with SQL `amount` NULL (the malformed
     value is never persisted), creates no `grant_claim_ledger` row, and never
     throws.
   - `appendRejection` signature widened to `amount: string | null`.
   - Added block normalized to surrounding indentation.

2. **`src/db/migrations/008_delegated_grants.sql`**
   - `grant_claim_ledger.amount` now carries
     `CHECK (amount > 0)` (DB-level positive constraint).

3. **`supabase/migrations/20260901000700_delegated_grants.sql`**
   - Identical `CHECK (amount > 0)` on the mirrored `grant_claim_ledger`
     (migration parity preserved).

3b. **Upgrade path (paired new migrations)**

- `src/db/migrations/009_delegated_grant_positive_claim_amount.sql` and
     `supabase/migrations/20260901000800_delegated_grant_positive_claim_amount.sql`:
     idempotent DO blocks that add the named constraint
     `grant_claim_ledger_amount_positive_ck CHECK (amount > 0) NOT VALID` only
     when absent, bound to `grant_claim_ledger` /
     `public.grant_claim_ledger` respectively.
     Required because `CREATE TABLE IF NOT EXISTS` in 008/20260901000700 does not
     alter databases where the migration was already recorded.
     **Legacy-row preservation policy:** the upgrade constraint is `NOT VALID` so
     any historical append-only rows remain intact on upgraded databases, while
     future INSERT/UPDATE statements that violate `amount > 0` are rejected.
     Fresh installs keep the fully validated inline CHECK in 008/20260901000700
     (same name, so the guard is a true no-op there — no duplicate constraint).

1. **`tests/integration/delegated-grants-consumption.test.ts`**
   - Added two focused runtime regression cases:
     - Zero amount (`"0"`) → `invalid_amount`, rejected audit row with
       `reason = 'invalid_amount'` and SQL amount NULL, zero rows in
       `grant_claim_ledger`.
     - Malformed amount (`"1__0"`) → same assertions.
   - Fixed a newline between import blocks (imports were otherwise valid).

### Validation evidence — INTENDED, NOT RUN

Per explicit user instruction, Hermes alone owns testing of every PR. The
following commands are recorded as intended validation and have NOT been
executed in this session; no pass is claimed:

```sh
# Focused evidence (with DATABASE_URL and docker compose up -d db):
npx vitest run tests/integration/delegated-grants-consumption.test.ts tests/integration/delegated-grants-schema.test.ts

# Full PR suite (Hermes):
npm run lint && npm run typecheck && npm test && npm run eval
```

State: **pending Hermes retest**. No independent verification performed.

### Work Unit Evidence

| Evidencia | Comando | Resultado |
| --- | --- | --- |
| Focused test | `npx vitest run tests/integration/delegated-grants-consumption.test.ts tests/integration/delegated-grants-schema.test.ts` (con `DATABASE_URL` + `docker compose up -d db`) | **NOT RUN — Hermes pending** |
| Runtime harness (suite PR) | `npm run lint && npm run typecheck && npm test && npm run eval` | **NOT RUN — Hermes pending** |

### Rollback boundary

Revert del diff 8.7 restaura exactamente el comportamiento previo. Archivos/alcance exactos:

- `src/wallet/grants/consumption.ts` — se eliminan `parsePositiveAmount` y la validación
  `invalid_amount` en `claimConsumption`; `appendRejection` vuelve a `amount: string`.
- `src/db/migrations/008_delegated_grants.sql` y
  `supabase/migrations/20260901000700_delegated_grants.sql` — se quita
  `CHECK (amount > 0)` de `grant_claim_ledger.amount` (ambos espejos en paridad).
- `src/db/migrations/009_delegated_grant_positive_claim_amount.sql` y
  `supabase/migrations/20260901000800_delegated_grant_positive_claim_amount.sql` —
  se eliminan (upgrade path NOT VALID del constraint nombrado).
- `tests/integration/delegated-grants-consumption.test.ts` — se remueven los dos
  casos de regresión (`"0"` y `"1__0"` → `invalid_amount`).
- Comportamiento que se revierte: rechazo previo a BigInt de montos malformados/cero,
  audit `rejected` con amount NULL, ausencia de fila en `grant_claim_ledger`, y la
  constraint positiva a nivel DB.

### Risks / notes

- `parsePositiveAmount` is module-private (not exported; no external caller); its
  behavior is exercised through the focused service regression cases.
- The unused `suite` binding at L19 of the test file predates this change and
  remains untouched (no unrelated refactors per scope).
- No live wallet, secrets, or provider operations touched; demo boundary
  (`WDK_TOOLS_SOURCE=fixture`) unchanged.
