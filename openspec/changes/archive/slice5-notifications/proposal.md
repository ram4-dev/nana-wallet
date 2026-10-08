# Proposal: Durable wallet and assistant notifications

## Intent

Users lose wallet activity visibility after leaving voice. LiveKit only invalidates active conversation state; no durable feed or incoming-activity recovery exists. Add a user-scoped inbox that remains correct when webhooks are delayed or missed.

## Scope

### In Scope
- Persist deduplicated assistant-transfer and relevant Solana devnet activity notifications.
- Ingest signed provider webhooks and reconcile with cursor-based polling.
- Expose an authenticated feed/read API and refreshable web inbox.
- Reuse `conversation_state_changed` after durable insertion.

### Out of Scope
- Native/browser push, multi-wallet, swaps, new chains, pricing/oracles, changes to grants or signing, and provider replacement.

## Capabilities

### New Capabilities
- `wallet-notifications`: durable, user-scoped notification feed and safe event projection.
- `wallet-event-ingestion`: signed webhook ingestion, idempotent event normalization, and polling reconciliation.

### Modified Capabilities
- None. Existing conversation state contracts remain unchanged; the existing LiveKit topic is reused as a transient invalidation.

## Approach

Use a PostgreSQL notification ledger as source of truth. One ingestion service normalizes webhook, persisted operation, and reconciliation events. Verify signatures over raw bytes. Reconcile from persisted wallet cursors with overlap-safe paging. Authenticated clients read and mark notifications through HTTP; LiveKit remains a transient refresh signal.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/db/migrations/` | New | Notification and reconciliation cursor tables with RLS |
| `src/api/` and `src/server.ts` | New/Modified | Webhook, feed, reconciler lifecycle |
| `src/wallet/` | Modified | Solana activity normalization and operation lifecycle hooks |
| `apps/nana-wallet/src/` | New/Modified | Activity feed, read state, refresh |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Privy webhook event scope differs for embedded Solana wallets | Medium | Verify exact event contract before enabling; reconciliation remains complete |
| Webhook and polling observe the same chain activity | High | Canonical per-wallet/network/signature/event dedupe plus webhook delivery-ID dedupe |
| Missed cursor pages or concurrent workers | Medium | Persist cursor, bounded overlap, idempotent insert, and DB-backed worker exclusion |

## Rollback Plan

Disable ingress/reconciliation and hide feed route/UI; keep stored rows/cursors. Existing transfer behavior remains. Remove additive tables only through a reviewed migration.

## Dependencies

PostgreSQL/RLS, Solana RPC history, provider signature configuration, and LiveKit revision topic.

## Success Criteria

- Invalid signatures create no records; duplicate deliveries and webhook/poll overlap create one canonical notification.
- Assistant transfer states and confirmed relevant inbound activity appear in an authenticated feed without reload.
- Missed webhooks are recovered from persisted cursors and no user can read another user's feed.
- LiveKit refresh failure does not remove or roll back durable notifications.
