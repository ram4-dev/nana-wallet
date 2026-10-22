# Proposal: Voice Room End-to-End Harness

## Problem

Nothing in the repository exercised a real conversation through the real voice
path. The three artefacts that looked like they did measured something else:

- `tests/e2e/livekit-smoke.e2e.test.ts` creates a room, dispatches the agent and
  deletes the room, and never joins it. Because the worker awaits
  `ctx.waitForParticipant()` and then blocks on a `bind_conversation` RPC, a
  dispatched but empty room produces the same result whether the agent works or
  not.
- `tests/simulation/livekit-voice.simulation.test.ts` imports no LiveKit and
  tests a state machine defined inside itself.
- `evals/voice/realtime/*` drives the realtime model over its own WebSocket,
  bypassing the worker, the room and the binding entirely.

Nani is speech-to-speech, so injecting text would not close the gap either: it
skips the audio path, which is precisely what fails in production.

The consequence is that a break in binding, media, turn-taking, tool execution or
backend state could reach a demo without any test noticing.

## Intent and Outcome

Add a harness that runs a real spoken conversation end to end against an isolated
self-hosted stack, and judges the outcome by what the conversation did to the
backend rather than by the agent having spoken.

Delivered capabilities:

- A caller that joins a LiveKit room, binds a conversation over the worker's own
  RPC, hears the greeting, publishes pre-recorded user turns, and captures the
  spoken answers as WAV artefacts.
- Turn boundaries detected by silence, never by a fixed sleep.
- Backend-state assertions: a confirmed transfer MUST reach `confirmed` with a
  transaction hash, and a cancelled transfer MUST leave no active row. The
  negative assertion is the point of the pair.
- Barge-in through the same RPC the application uses, asserting both that the
  agent stopped and that the session survived.

## Scope

- A harness inside this repository, beside the existing tests.
- Caller audio from committed, pre-recorded WAV fixtures. Runtime TTS remains an
  option, never the default path.
- `vitest` as the runner, with its own config, excluded from `npm test`.
- An isolated compose stack so the harness never shares ports, database or rooms
  with any other local stack.

## Non-goals

- Wiring the harness into CI. It needs the isolated stack and paid provider
  credentials; the current workflow starts Postgres only. Deferred as a decision.
- Replacing `evals/voice/realtime/`. That measures the model; this measures the
  system. They are complements.
- Any relaxation of the wallet, confirmation or policy guards. The harness
  measures these; it never weakens them.
- Running against a live wallet. `WDK_TOOLS_SOURCE=live` remains forbidden, and
  the fixture opts out of the Privy path explicitly.

## Rollback

The harness is additive and touches no production behaviour. Two changes outside
`tests/` each carry their own rollback:

- The worker's fixture-wallet seam is off unless `VOICE_E2E_FIXTURE_WALLET=1`, so
  removing the flag restores the previous behaviour exactly. The change throws
  when combined with `WDK_TOOLS_SOURCE=live` rather than degrading silently.
- The `vitest.config.ts` change is a single exclusion glob for the new directory.

Deleting `tests/e2e/voice-room/`, the two compose files and the fixture WAVs
removes the harness completely.

## Open items carried forward

1. **A real product race**, found by this harness: the decision gate accepts only
   a final transcript that arrived after the preview, and the realtime provider
   transcribes asynchronously, so a model tool call can beat its own transcript.
   A user who says "sí, confirmo" can be told there is no valid confirmation. The
   harness was made more realistic; the product cause is unresolved and needs an
   owner decision.
2. **CI wiring**, deliberately not done here.
