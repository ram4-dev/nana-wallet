# Verify report — voice-room-e2e-harness

## Result

**PASS**, with two items deferred to an owner decision and one upstream report
pending.

## Commands and outcomes

| Command | Result |
|---|---|
| `npm run test:e2e:voice-room` | 3 files, 4 tests passed. Six consecutive green full runs after the fixture fix. |
| `npm run test:e2e:voice-room-roundtrip` | 3/3 round trips, spoken answers of 2.9-5.9 s. |
| `npm test` | 860 passed, 174 skipped, 16 failed — the branch baseline, unchanged. |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |

The 16 failures are pre-existing and unrelated: 14 in two database-backed
integration suites that need a `DATABASE_URL` this checkout does not carry, and 2
in realtime unit suites. Verified by running the same suite on the base branch
`feat/solana-operational`, which contains none of this work and fails identically.

## Requirements coverage

| Requirement | Evidence |
|---|---|
| Real conversation coverage | Bind `{"ok":true}`; ~2000 frames and ~17.8 s of speech captured for the greeting; a published turn transcribed (`"Che nani, ¿me..."`) and answered. |
| Turn boundaries by signal | `turn-detector.ts` as a pure function, 17 unit tests. |
| Credentials injected | Runs with `VI_TEST_AMBIENT_PROVIDER_ENV` unset; removing `.env` produces `missing credentials: <five keys named>`. |
| Fails loudly | Stack down produces `the isolated LiveKit stack is not reachable at <url>` plus the compose command. |
| Backend state, confirmed | `e2e00000-…-0003 \| status=confirmed \| has_tx=t` on a database rebuilt from scratch. |
| Backend state, cancelled | `e2e00000-…-0004 \| status=cancelled \| has_tx=f`, with a preview required for the assertion to be non-vacuous. |
| Settlement waits | `afterTurns` polls with the room open; the previous race left rows at `previewed`. |
| Barge-in through the app contract | `interrupt_agent` accepted; silence in 367/15/118 ms; 3070/3230/2830 ms of speech in the following answer, across three runs. |
| Fixture fidelity | The three sequential failures this fixed (`schema "extensions" does not exist`, `permission denied`, `function extensions.gen_random_uuid() does not exist`) no longer occur. |
| Wallet stays in fixture mode | `WDK_TOOLS_SOURCE` never set; the seam refuses to combine with `live`. |

## Defects this change found

1. **A real product race.** The decision gate requires a final transcript that
   arrived after the preview; the provider transcribes asynchronously, so a model
   tool call can beat its own transcript and a clear affirmative is refused with
   `confirmation_required`. Proven by the agent's own words while the correct
   transcript was present in the room stream. The harness was made realistic (the
   fixtures now end on a pause like a real caller); **the product cause is
   unresolved.**
2. **The fixture database diverged from the one CI builds.** Three layered
   failures, all only at the confirm step.
3. **The two migration chains are not equivalent.** `src/db/migrations/001`
   installs the extensions without `WITH SCHEMA` (into `public`) while the
   supabase chain CI applies uses `WITH SCHEMA extensions`, and the application
   schema-qualifies the call.
4. **`AudioFrame.protoInfo()` ignores `byteOffset`**, transmitting the whole
   underlying buffer. A frame built from a subarray sends the buffer's opening
   bytes on every frame, which presents as silence.
5. **Two suites claimed coverage they do not provide**; both now state their real
   scope.

## Known limitations

- The suite is **local-only**: it needs the isolated stack and paid credentials.
  Not wired into CI.
- The product race is mitigated in the harness, not fixed. A real user who stops
  speaking abruptly can still land in the window.
- The barge-in scenario asserts only silence and session survival. It does not
  measure whether the interrupted sentence resumed correctly.
- Acoustic interruption is recorded as evidence and never asserted, because its
  thresholds belong to the provider.
- The turn detector thresholds are calibrated on this stack's audio.
