import {
  DemoIdentityProvider,
  type RequestIdentityProvider,
} from "../../src/auth/identity.js";
import { buildServer } from "../../src/server.js";
import type { PrivyServerClient } from "../../src/wallet/privy-server-client.js";

/**
 * Test server factory: gives a suite a running HTTP server without any Privy
 * credentials.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production identity verification is Privy, so `buildServer()` needs
 * `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` and resolves a real user per
 * request. Most server-based tests do not authenticate at all: they inject
 * against a fixture wallet and need the request to resolve to one fixed user.
 *
 * That fixed user used to come from the removed demo default, in which
 * `src/server.ts` fell back to `new DemoIdentityProvider(config.demoUserId ??
 * "")` — a provider that resolves every request to a single fixed user. This
 * helper is the explicit seam that replaces that default, so the demo branch
 * could be removed without rewriting every server-based test.
 *
 * DEFAULT IDENTITY
 * ----------------
 * The default reproduces the removed demo branch exactly: a
 * `DemoIdentityProvider` bound to `process.env.DEMO_USER_ID`, or `""` when that
 * variable is absent or empty — the same value `config.demoUserId ?? ""`
 * resolved to, because `DEMO_USER_ID` is `optionalNonEmpty` (an empty string
 * parses to `undefined`). `tests/setup/isolate-provider-env.ts` deliberately
 * leaves `DEMO_USER_ID` alone, so the suite observes the value it always did;
 * `.github/workflows/ci.yml` pins it to `00000000-0000-4000-8000-000000000001`.
 *
 * SCOPE
 * -----
 * An injected identity short-circuits the Privy identity construction: when
 * `options.identity` is given, `buildServer()` reads none of the Privy inputs.
 * Suites that deliberately exercise production identity build the real server
 * without an injected identity and supply the Privy identity inputs in the env.
 */
export function buildTestServer(
  options: {
    privyServer?: PrivyServerClient;
    identity?: RequestIdentityProvider;
  } = {},
) {
  return buildServer({
    ...options,
    identity:
      options.identity ??
      new DemoIdentityProvider(process.env.DEMO_USER_ID ?? ""),
  });
}
