# Design: Explicit voice confirmation

## Decisions

1. **Server evidence gates confirmation.** `AgentSession.UserInputTranscribed` final events are the source of voice evidence. After `send_token` persists a preview and reloads its current preview ID, the worker-controlled narrator speaks the exact amount, saved name, token/network, and fee through `AgentSession.say`; it waits for playout to complete without interruption before arming the per-room arbiter for that preview. The arbiter records the narration completion time using the server clock and accepts only a later final exact decision event whose LiveKit `createdAt` is strictly newer. This rejects a delayed event that was created before the read-back even if delivered after it. One matching tool callback consumes the evidence once. A model-selected tool call alone is never sufficient. Missing, interrupted, or out-of-order evidence returns a retryable confirmation-required error and does not claim/broadcast the transfer. Both timestamps come from the same worker process; client clocks are not used.
2. **The pending preview remains canonical.** The tool callback reloads the current pending preview and resolves against its ID; the arbiter cannot authorize a different preview. Replacing/clearing a pending preview disarms evidence. The existing database claim/release and provider idempotency path remain authoritative for duplicate callbacks, races, and uncertain broadcast outcomes.
3. **Contact identity is chain-aware and versioned.** Add nullable `network` to recipient records/contacts and version snapshots. Null/absent remains the existing EVM default for backward compatibility; Solana entries require `solana-devnet`. Resolve only ID + version and validate address against the configured chain both on write and immediately before preview/broadcast. Do not accept an address from voice/model input.
4. **Solana live policy uses native units.** Validate recipient as canonical base58; reject self-transfer; validate positive SOL decimal to exact lamports, max 9 fractional digits, and match `solana-devnet`/`SOL`/configured user wallet. Apply the configured live `WDK_MAX_TRANSFER_AMOUNT` exactly in SOL, with no USD conversion/oracle. Keep the 10,000,000-lamport (0.01 SOL) ceiling confined to delegated grants in Slice 2. Preserve EVM policy semantics.
5. **Narration exposes display-safe facts.** The model-facing preview contains amount, `SOL`, saved contact display name, and provider estimated fee. It never includes the address. The tool prompt requires a read-back of those fields and then asks for an explicit yes/no in the conversation language.

## Flow

```mermaid
sequenceDiagram
  participant U as User
  participant S as LiveKit session
  participant A as Voice decision arbiter
  participant T as Strict realtime tools
  participant C as Conversation service
  participant W as Solana devnet provider
  U->>S: transfer request
  S->>A: final transcript (non-confirmation)
  S->>T: send_token(contactId, version, amount)
  T->>C: previewTransfer
  C->>W: previewTransfer
  W-->>C: amount, fee, recipient
  C-->>T: persisted preview
  T-->>S: amount + name + fee, no address
  S-->>U: spoken preview and explicit confirmation question
  U->>S: exact spoken confirmation
  S->>A: final transcript bound to active preview
  S->>T: confirm_transfer()
  T->>A: consume one-use evidence for current preview
  T->>C: resolveDecision(currentPreviewId, confirm)
  C->>W: broadcast once; await finality
```

If evidence is absent, non-final, stale, consumed, or tied to another preview, the tool returns without calling `resolveDecision`. On cancellation the same binding applies with a cancel decision. Database claim semantics protect cross-path races with typed UI/API decisions. The worker records transcripts only into the voice decision gate; it must not also pass the same user transcript through `RoomConversation.handleFinalTranscript` or generic `handleTurnStream`, which would create an uncoordinated second confirmation route. The current room contract binds one authenticated participant; if the runtime cannot establish that a final transcript belongs to that bound participant, it must not issue voice decision evidence.

## Main files

- Voice session and decision gate: `src/livekit/create-agent-session.ts`, `src/livekit/worker.ts`, `src/livekit/realtime-tools/create-realtime-tools.ts`, new `src/livekit/voice-decision-gate.ts`.
- Chain-aware policy and service recipient resolution: `src/conversations/service.ts`, `src/agent/definition.ts`, `src/agent/wallet-agent.ts`, contact/memory contracts and repositories.
- Contact contract/UI: relevant contacts schema, authenticated routes, and `apps/nana-wallet` recipient editor/list.
- Tests: voice decision gate, strict realtime tools, contacts API/repository/UI, Solana voice preview→confirm/cancel/stale/finality fake-worker E2E, existing EVM and race regressions.

## Risks and controls

- Realtime transcript and tool events may be reordered. The gate fails closed and requires another explicit confirmation; deterministic tests cover transcript-before-preview, delayed pre-readback events, narration interruption, transcript-before-narration, and the supported sequence. A missing provider preview ID must fail closed rather than synthesize a timestamp-based Solana idempotency key.
- LiveKit's transcript event currently leaves `speakerId` null by default. The worker must rely on the one authenticated bound participant per room and fail closed if multi-participant input is enabled without an identity signal.
- Contact network defaults could silently retarget old records. Missing network remains EVM only; Solana is always explicit and version changes invalidate a pending preview.
- Estimated fee may change after preview. Persist the provider preview and use current service stale/claim rules; surface provider uncertainty without automatic resend.
- Solana terminal projections currently default to an Etherscan URL. Use the existing network-aware explorer helper for terminal state so voice confirmation surfaces the actual Solana explorer link.
- Concurrent confirmation from voice and UI can race. Only the existing canonical claim may dispatch; the decision gate is one-use and per current preview.
