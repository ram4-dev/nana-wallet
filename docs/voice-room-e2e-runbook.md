# Voice-room end-to-end runbook

This runbook runs the one suite that exercises a **real spoken conversation**
through the whole voice path: a caller joins a LiveKit room, the worker binds a
conversation over RPC, Nani greets aloud, the caller publishes a recorded user
turn, and Nani answers aloud. Both turns are detected by silence, captured as
WAV files, and asserted.

Everything else in the repository measures a different layer:

| Artefact | What it actually exercises |
| --- | --- |
| `evals/voice/realtime/*` | the realtime model, straight over its own WebSocket |
| `tests/e2e/livekit-smoke.e2e.test.ts` | room creation and dispatch; it never joins |
| `tests/e2e/voice-room/*` (this) | room → worker → binding RPC → AgentSession → spoken answer |

## Why it is not part of `npm test`

It needs a live isolated stack and paid provider credentials, so the root
`vitest.config.ts` excludes `tests/e2e/voice-room/**` and the suite runs through
its own config. It **fails loudly and never skips**: a voice path that silently
stops running is indistinguishable from one that passes.

## Prerequisites

- Node.js 22.18 or newer and npm.
- Docker. On macOS use Colima (`colima start`); never Docker Desktop.
- A git-ignored `.env` at the repository root holding `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`, `LIVE_VOICE_BINDING_PRIVATE_KEY`,
  `LIVE_VOICE_BINDING_PUBLIC_KEY` and `OPENAI_API_KEY`. Values are never printed.

## 1. Start the isolated stack

```bash
docker compose -p nana-e2e -f compose.yaml -f compose.e2e.override.yaml --profile worker up -d
```

The compose project is `nana-e2e`, separate from every other stack on the
machine. That matters on a busy checkout: the base ports are usually taken.

| Service | Host address | Why this port |
| --- | --- | --- |
| LiveKit signalling | `ws://127.0.0.1:7882` | the base maps 7882 because an ssh tunnel squats 7880 |
| LiveKit media | UDP/TCP `38881-38891` | its own range, so `nana-real` keeps `7881-7891` |
| Postgres | `postgresql://postgres@127.0.0.1:5433/wdk_agent` | the base 5432 is the same ssh tunnel |

**The media range is not a free choice.** LiveKit advertises `rtc.udp_port` from
its own config file, not from the compose port mapping, so a dedicated
`docker/e2e-livekit.yaml` carries the range and the host mapping must equal it.
Remapping the host ports while the server keeps announcing the old range hands
peers unreachable ICE candidates and the call silently produces no audio.

The worker is registered as agent `nani-agent`, and this stack opts into the
fixture wallet (`VOICE_E2E_FIXTURE_WALLET=1`) so balances resolve without any
Privy call. Confirm it came up:

```bash
docker compose -p nana-e2e ps
docker logs --tail 5 nana-e2e-voice-worker-1   # expect: "registered worker"
```

## 2. Run the suite

```bash
npm run test:e2e:voice-room
```

A green run takes roughly 40 seconds, since it runs two real turns through a
speech-to-speech model. The assertions are on outcomes, not on exact durations:
the model is generative, so the greeting and the answer vary in length between
runs.

There is also a script form that runs the same round trip three times and prints
the spread, which is the better tool when investigating drift:

```bash
npm run test:e2e:voice-room-roundtrip
```

## 3. Read the results

Captured audio is written to `tests/e2e/voice-room/.artifacts/` (git-ignored) and
each path is printed. To evaluate the run, **listen to the WAVs**: `<label>-greeting.wav`
should hold Nani introducing herself and reading the fixture balance, and
`<label>-answer.wav` her reply to the recorded turn.

```bash
open tests/e2e/voice-room/.artifacts
```

The report also records room transcripts. Those are evidence, never assertions —
they are what turns "no answer arrived" into "the model never heard the turn".

If you need to regenerate the recorded user-turn fixtures (they are committed):

```bash
npm run e2e:voice-room:fixtures
```

## Troubleshooting

Both failure paths name the fix rather than leaving a bare error.

| Symptom | Cause and fix |
| --- | --- |
| `missing credentials: ...` | the named keys are absent from the root `.env`; the suite injects them explicitly and never inherits ambient ones |
| `the isolated LiveKit stack is not reachable at ...` | run the `docker compose ... up -d` command from step 1 |
| `bind_conversation answered ok:false (conversation_already_live)` | a previous run died holding the lease; re-running reseeds and clears it |
| `the agent did not answer with speech` | the worker received audio it could not act on. Check `docker logs nana-e2e-voice-worker-1`, then confirm the caller published real audio: the report's `microphoneSource` must be true and the turn must not be silent |
| No audio in the WAVs, but frames arrive | almost always the media range mismatch described in step 1 |

## Notes for maintainers

- The `AudioFrame` published per turn must own its buffer. `AudioFrame.protoInfo()`
  passes the FFI `new Uint8Array(frame.data.buffer)` — the whole ArrayBuffer,
  ignoring `byteOffset`. Building a frame from a `subarray` transmits the
  buffer's opening bytes on **every** frame, which reads as near-silence rather
  than as an error. This cost an afternoon once; `publishUserTurn` copies each
  slice on purpose.
- `track.kind` is the numeric `TrackKind` enum (`KIND_AUDIO === 1`), never the
  string `'audio'`. A string comparison drops every track with no error at all.
- A live `AudioStream` keeps the event loop alive and `room.disconnect()` never
  resolves while a reader is attached, so teardown has to be explicit.
- `performRpc` lives on `room.localParticipant` at runtime, not on the remote
  participant object, despite what `participant.d.ts` suggests.
