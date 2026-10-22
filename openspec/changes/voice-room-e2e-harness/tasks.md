# Tasks

Status as delivered. Each phase was verified before the next began.

## 1. Feasibility

- [x] 1.1 Prove a host-side client can exchange media with the containerised
      LiveKit (the one unknown that could invalidate the whole approach).
- [x] 1.2 Isolated stack: own compose project, own RTC range, own config file.
- [x] 1.3 Two API traps found and documented (numeric track kind; a live stream
      keeps the process alive).

## 2. Binding and greeting

- [x] 2.1 Fixture: user, conversation, no live lease.
- [x] 2.2 Mint and verify the binding token with the repository's own signer.
- [x] 2.3 Dispatch, join as the binding subject, call `bind_conversation`.
- [x] 2.4 Capture the greeting as a WAV and report frames, duration, latency.
- [x] 2.5 Negative run: a token signed by another key is rejected, proving PASS
      is not hardcoded.

## 3. Round trip

- [x] 3.1 Committed user-turn WAV fixtures.
- [x] 3.2 Silence-based end-of-turn detector as a pure function, with unit tests.
- [x] 3.3 Publish a recorded turn and capture the spoken answer, both to WAV.
- [x] 3.4 Fix the audio publication defect (`AudioFrame.protoInfo()` ignores
      byteOffset, so a subarray frame transmitted the buffer's opening bytes on
      every frame — which read as silence rather than as an error).
- [x] 3.5 Three consecutive green round trips.

## 4. Backend state

- [x] 4.1 Multi-turn scenarios: a sequence of recorded turns on one session.
- [x] 4.2 Transfer state reader in one module, shared by both scenarios.
- [x] 4.3 Confirmed scenario asserts `confirmed` plus a transaction hash.
- [x] 4.4 Cancelled scenario asserts no active row, and non-vacuously requires
      that a transfer was previewed first.
- [x] 4.5 Align the fixture database with what CI builds (extensions schema,
      extension placement, grant, search path).
- [x] 4.6 Wait for settlement with the room open instead of racing teardown.

## 5. Runner integration

- [x] 5.1 Own vitest config; excluded from `npm test`.
- [x] 5.2 Credentials injected explicitly.
- [x] 5.3 Loud failure on missing credentials and on an unreachable stack, with
      the command that starts it.
- [x] 5.4 Runbook covering the stack, the ports, and the traps.

## 6. Barge-in

- [x] 6.1 Establish how barge-in actually fires in this product.
- [x] 6.2 Interrupt mid-speech through the application's RPC.
- [x] 6.3 Assert the agent stopped; assert a later turn is still answered.
- [x] 6.4 Require real speech before interrupting, so the scenario is not vacuous.

## 7. Reliability and honesty

- [x] 7.1 Fix the intermittent transfer failures (harness unrealism: fixtures
      ended on the last phoneme, leaving transcription racing the tool call).
- [x] 7.2 Six consecutive green runs after the fix.
- [x] 7.3 Correct two suites whose names claimed coverage they do not provide.

## 8. Deferred, with owners

- [ ] 8.1 **Product decision.** The decision gate accepts only a final transcript
      that arrived after the preview, and the provider transcribes asynchronously,
      so a tool call can beat its own transcript and a clear "sí, confirmo" is
      refused. Touching this means touching a payment guard.
- [ ] 8.2 **Product decision.** Wire the voice suite into CI. It needs the
      isolated stack and paid credentials; the workflow starts Postgres only.
- [ ] 8.3 **Upstream.** `AudioFrame.protoInfo()` in `@livekit/rtc-node` ignores
      `byteOffset`, so any frame built from a subarray transmits the wrong bytes.
      Worth reporting with a minimal reproduction.
