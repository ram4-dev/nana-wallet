/**
 * Provider-environment isolation for the root test suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/server.ts` and `src/livekit/worker.ts` begin with `import "dotenv/config"`,
 * so ANY test that imports the server pulls the repository-root `.env` into
 * `process.env`. In a developer checkout that file holds LIVE Privy credentials,
 * which makes `readPrivyServerConfig()` succeed and `buildServer()` construct a
 * real Privy server client instead of using fixtures. Fixture-based cases then
 * reach the real provider and fail:
 *
 *   tests/integration/wallets-sync.test.ts  -> "unavailable" instead of "ready"
 *
 * CI has no `.env`, so the suite is green there and these failures only appear
 * locally — false negatives that cost real debugging time.
 *
 * HOW IT WORKS
 * ------------
 * Order matters, so this module is the one that loads dotenv:
 *
 *  1. Load `dotenv/config` here (eagerly, once per test file's module graph).
 *  2. DELETE the provider/identity/voice credential keys.
 *  3. The later `import "dotenv/config"` inside `src/server.ts` hits the module
 *     cache, so its side effect does NOT run again and the deleted keys stay
 *     deleted.
 *
 * Deleting (rather than pinning to "") returns each variable to its true unset
 * state, which is exactly the CI shape: strict enums such as IDENTITY_PROVIDER
 * fall back to their documented default instead of failing validation on an
 * empty string.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 * --------------------------------
 * `DATABASE_URL` and `DEMO_USER_ID` are left alone: integration suites gate
 * themselves on `DATABASE_URL`, so clearing it would silently skip them and
 * report a false green. Only credentials are isolated.
 *
 * OPTING OUT
 * ----------
 * Set `VI_TEST_AMBIENT_PROVIDER_ENV=1` to keep the ambient `.env` values (for a
 * deliberate run against real credentials).
 */

import "dotenv/config";

/** Credentials that flip the server/worker from fixture to live behavior. */
export const ISOLATED_PROVIDER_ENV_KEYS = [
  // Privy identity + server API
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_VERIFICATION_KEY",
  "PRIVY_AUTHORIZATION_PRIVATE_KEY",
  "PRIVY_AUTHORIZATION_PUBLIC_KEY",
  "PRIVY_AUTHORIZATION_KEY_QUORUM_ID",
  "PRIVY_API_BASE_URL",
  "IDENTITY_PROVIDER",
  // Live voice binding + LiveKit
  "LIVE_VOICE_ENABLED",
  "LIVE_VOICE_BINDING_PRIVATE_KEY",
  "LIVE_VOICE_BINDING_PUBLIC_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_AGENT_NAME",
  "LIVEKIT_AGENT_RUNTIME",
  "LIVEKIT_BROWSER_URL",
  "LIVEKIT_DOCKER_URL",
  // Model + speech providers
  "OPENAI_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENCODE_GO_BASE_URL",
  "OPENCODE_GO_MODEL",
  "NAN_API_KEY",
  "NAN_BASE_URL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_BASE_URL",
  "ELEVEN_LABS",
  "ELEVEN_LABS_API_KEY",
] as const;

/**
 * Deletes every isolated credential so the ambient `.env` cannot reach the
 * suite. Assumes `dotenv/config` was already loaded by this module.
 */
export function isolateProviderEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.VI_TEST_AMBIENT_PROVIDER_ENV === "1") return;
  for (const key of ISOLATED_PROVIDER_ENV_KEYS) {
    delete environment[key];
  }
}

isolateProviderEnvironment();
