import {
  DemoIdentityProvider,
  type RequestIdentityProvider,
} from "../../src/auth/identity.js";
import { buildServer } from "../../src/server.js";
import { createLegacyToolSourceWalletReads } from "../../src/runtime/dependencies.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import type { WalletProvider } from "../../src/wallet/provider.js";
import type { PrivyServerClient } from "../../src/wallet/privy-server-client.js";

/**
 * The fixed identity every fixture-based suite resolves to by default.
 *
 * Production identity is always Privy and resolves a real user per request.
 * Most server-based tests do not authenticate at all: they inject against a
 * fixture wallet and need the request to resolve to one fixed user, so they
 * name this constant instead of an environment variable.
 *
 * The value is the shared-database singleton every server-based suite agrees
 * on (see the `demo` privy_did slot in the users migration).
 */
export const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Test server factory: gives a suite a running HTTP server without any Privy
 * credentials.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production identity verification is Privy, so `buildServer()` needs
 * `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` and resolves a real user per
 * request. This helper is the explicit seam that replaces the removed demo
 * default, in which `src/server.ts` fell back to a `DemoIdentityProvider`
 * bound to a configured demo tenant, so the demo branch could be removed
 * without rewriting every server-based test.
 *
 * DEFAULT IDENTITY
 * ----------------
 * A `DemoIdentityProvider` bound to {@link TEST_USER_ID}, so a suite that does
 * not care which user it is observes one stable identity. A suite that needs a
 * different user passes `userId` and gets a provider bound to that user.
 *
 * DEFAULT WALLET
 * --------------
 * The default injects the write/read pair every fixture-based suite expects, so
 * a suite gets a stable provider regardless of the environment:
 *
 *  - `wallet`       → `FixtureWalletProvider` (the write-side double).
 *  - `walletReads`  → `createLegacyToolSourceWalletReads()`, the WDK provider
 *                     over the legacy MCP tool source. This is the provider the
 *                     `/v1/wallet/*` read routes actually serve in fixture mode,
 *                     so it is NOT interchangeable with the write-side fixture
 *                     (a suite that asserts the WDK tool-source calls, e.g.
 *                     api-wallet-official-wdk, depends on it).
 *
 * Both stay overridable per suite through the same options object.
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
    userId?: string;
    wallet?: WalletProvider;
    walletReads?: WalletProvider;
  } = {},
) {
  const { userId, ...serverOptions } = options;
  return buildServer({
    ...serverOptions,
    identity:
      options.identity ?? new DemoIdentityProvider(userId ?? TEST_USER_ID),
    wallet: options.wallet ?? new FixtureWalletProvider(),
    walletReads: options.walletReads ?? createLegacyToolSourceWalletReads(),
  });
}
