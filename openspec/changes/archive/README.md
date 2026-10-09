# Archived changes — Nana Wallet

Every SDD change delivered up to 2026-10-08 is archived here with an
`archive-report.md` recording its summary, delivered scope, evidence and any
deferred items. Nothing was silently checked: open boxes are either
intentionally human/manual gates or provider-blocked features, and each one is
named in its report.

- Repository state at archive: `main` = `4cd8092` (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` with green CI
  (backend lint/typecheck/tests/evals; frontend lint/typecheck/tests)
- Suite at archive time: backend 1015/1015, evals 27/27 at 100%, frontend 98/98

## Index

| Change | Summary | Has deferrals |
|---|---|---|
| `agent-multi-network-balance` | `get_balance` sin argumentos devuelve un JSON con los balances de todas las redes soportadas, y Nani responde … | No |
| `arc-mini-demo` | Escritorio de comandos guiados que ejecuta un micropago real de 0.000001 USDC en Arc Testnet con preview y con… | No |
| `circle-arc-runtime-integration` | Provider runtime de Circle Arc como fuente de wallets live, con guardas fail-closed, idempotencia de transfere… | Yes |
| `delegated-grant-core` | Núcleo de delegación de transferencias: grants con ledger append-only, RLS por usuario y sincronización de pol… | No |
| `developer-1-wdk-blockchain-flow` | Flujo blockchain WDK del developer 1: integración del toolkit WDK con el agente financiero. | No |
| `docker-real-wallet-start` | Arranque reproducible del stack con wallet real (WDK o Circle Arc) mediante `scripts/docker-real-wallet.mjs`, … | No |
| `local-livekit-selfhost` | LiveKit self-hosted local (loopback only) con binding Ed25519, sin egress ni recording. | Yes |
| `local-work-consolidation` | Consolidación del trabajo local disperso en un estado coherente y entregable. | No |
| `luckgnome-ui-structure` | Todas las vistas adoptan la estructura del prototipo LuckGnome manteniendo la paleta violeta/crema y la mascot… | Yes |
| `nani-grant-creation` | Nani crea transferencias delegadas de Solana por conversación (voz y texto); la UI dejó de ofrecerlas. | Yes |
| `privy-embedded-wallets` | Wallets embebidas por usuario con Privy: sync owner-verified, enrollment de signer con política inmutable y pi… | Yes |
| `privy-multi-user-foundation` | Fundación multi-usuario: identidad Privy verificada (ES256), provisioning idempotente, RLS por usuario y conta… | Yes |
| `privy-policy-api-alignment` | La política de enrollment se alineó con la API vigente de Privy, habilitando la activación del permiso de pago… | Yes |
| `recipient-address-memory` | Memoria de destinatarios con embeddings: búsqueda semántica, versionado y confirmación explícita antes de pers… | No |
| `slice3-grant-execution` | Ejecución de transferencias cubiertas por un grant activo sin segunda confirmación, degradando fail-closed a p… | No |
| `slice4-voice-confirmation` | Confirmación por voz con evidencia hablada: el broadcast exige una decisión hablada tras el read-back, nunca u… | No |
| `slice5-notifications` | Bandeja durable de actividad de wallet y notificaciones del asistente. | No |
| `solana-devnet-provider` | Provider Solana devnet como fuente de wallet live, con límites en lamports y dispatch firmado. | Yes |
| `solana-wallet-onboarding` | La wallet embebida de Solana se crea en el login y puede crearse manualmente desde Nana. | No |
| `tee-signer-enrollment` | Consentimiento de firmante compatible con wallets TEE de Privy. | No |
| `unify-agent-tools` | Una sola definición de herramientas para el agente de texto y el de voz, con paridad estructural, lecturas mul… | Yes |
| `wallet-profile` | Perfil de wallet: identidad más saldo personal USDC con lectura explícita y sin métricas simuladas. | No |

## Follow-ups after the archive commit

- `c7fa2fe` completed the move by recording the delete half for the 16
  pre-existing change directories (the archive commit had staged only the added
  copies). Losslessness was verified first: every archived file is
  byte-identical to its original except the ten `state.yaml` files, whose only
  difference is the archive stamp.
- `5c84465` fixed a latent CI flake surfaced while reconciling the ledger: the
  policy-sync case recomputed its expected expiry at assertion time, so
  crossing a second boundary failed the whole backend job (CI run 37636561838
  on `2958412`).
- **Environment leak — FIXED**. An untracked root `.env` with live Privy
  credentials leaked into the suite through the side-effect
  `import "dotenv/config"` in `src/server.ts` / `src/livekit/worker.ts`, so
  fixture-based cases called the real provider (two `wallets-sync` cases
  reported `unavailable` instead of `ready`). Bisect proved it was the ambient
  file, not the code: the same commit was fully green in a clean environment.
  `tests/setup/isolate-provider-env.ts` (wired through `vitest.config.ts`)
  now loads dotenv first and deletes the provider/identity/voice credentials,
  so the cached module cannot reintroduce them; `DATABASE_URL`/`DEMO_USER_ID`
  are untouched to avoid silently skipping the integration suites.
  Verified: with the leaking `.env` present the suite reports the clean-env
  baseline (158 files / 1069 passed / 10 skipped, evals 27/27), and
  `VI_TEST_AMBIENT_PROVIDER_ENV=1` reproduces the leak on demand.

## Notable cross-cutting deferrals

- **Rolling 50 USDC / 3600 s aggregate** (`privy-embedded-wallets`): blocked on
  provider wallet-identity grouping. The per-transfer cap (10 USDC), the
  recipient allowlist and chain/contract pinning ARE enforced by the provider
  policy.
- **Real-time voice matrix and real judge** (`unify-agent-tools`): opt-in
  `EVAL_REAL=1` release gate, documented in `docs/evals.md`.
- **Manual E2E runbooks** (`circle-arc-runtime-integration`,
  `local-livekit-selfhost`, `solana-devnet-provider`): require human
  credentials, funded testnet money or an external harness, so the boxes stay
  open for the operator by design.
- **Live transfer acceptance** (`privy-embedded-wallets`): requires a funded Arc
  wallet plus human-consented enrollment and explicit authorization to move
  money.
