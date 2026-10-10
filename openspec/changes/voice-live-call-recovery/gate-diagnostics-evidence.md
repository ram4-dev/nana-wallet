# Gate diagnostics evidence

Task 2.1: metadata-only observation added at prepare, transcript and consume. Authorization semantics unchanged. Fields exclude spoken text, identifiers, secrets and signatures.

Test-first evidence: `npx vitest run tests/unit/livekit/voice-decision-gate.test.ts` initially failed only the new observation scenario (1 failed / 19 passed). After implementation, `npx vitest run tests/unit/livekit/voice-decision-gate.test.ts tests/unit/livekit/voice-decision-transcripts.test.ts`: 22 passed, exit 0.

`npm run lint`: exit 0. `npm run typecheck`: exit 0. `npm run eval`: exit 0, 25 evals, score 100%; real STT/TTS/realtime/tools-matrix skipped because real mode is off. These checks precede the separate terminal-result change and will be repeated where needed.

Runtime: worker restarted and recompiled at 04:42:25 UTC. Container grep found voice_confirmation_gate in dist/livekit/worker.js and financialResult fallback in dist/conversations/service.js (count 1 each). Worker registered in LiveKit. Sidecar must also restart after the worker because it shares the worker network namespace; the first connectivity probe failed, and after sidecar restart/build the signing connectivity probe passed. Backend restarted, health 200. Another live call is pending. No timing fix is authorized by this evidence yet. Confirmed chain evidence remains 5 SOL and only the funding signature.

After the terminal-result change: lint, typecheck and build all exited 0. Rollback: diagnostics in voice-decision-gate.ts and worker.ts plus the new unit observation scenario.
