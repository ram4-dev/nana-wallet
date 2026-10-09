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
 * Production identity verification is Privy, so `buildServer()` in privy mode
 * needs `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` and resolves a real user per
 * request. Most server-based tests do not authenticate at all: they inject
 * against a fixture wallet and need the request to resolve to one fixed user.
 *
 * Today that is what the `IDENTITY_PROVIDER` default supplies implicitly:
 * `src/server.ts` falls back to `new DemoIdentityProvider(config.demoUserId ??
 * "")`, a provider that resolves every request to a single fixed user. This
 * helper is the explicit seam that replaces that default, so the demo branch
 * can be removed without rewriting every server-based test.
 *
 * DEFAULT IDENTITY (behaviour-preserving)
 * ---------------------------------------
 * The default reproduces the demo branch exactly: a `DemoIdentityProvider`
 * bound to `process.env.DEMO_USER_ID`, or `""` when that variable is absent or
 * empty — the same value `config.demoUserId ?? ""` resolves to, because
 * `DEMO_USER_ID` is `optionalNonEmpty` (an empty string parses to `undefined`).
 * `tests/setup/isolate-provider-env.ts` deliberately leaves `DEMO_USER_ID`
 * alone, so the suite observes the value it always did; `.github/workflows/
 * ci.yml` pins it to `00000000-0000-4000-8000-000000000001`.
 *
 * SCOPE
 * -----
 * The injected identity is only consulted on the server's demo branch. Suites
 * that deliberately exercise production identity (`IDENTITY_PROVIDER=privy`)
 * must keep calling the real `buildServer()`, which constructs the Privy
 * provider unconditionally.
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
