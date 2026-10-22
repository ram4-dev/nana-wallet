import { describe, expect, it } from "vitest";
import { createWorkerDependencies } from "../../src/runtime/dependencies.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import type { WalletProvider } from "../../src/wallet/provider.js";

/**
 * The voice e2e fixture seam.
 *
 * Injecting the providers is deliberately NOT enough: the voice path prefers
 * `walletForUser` whenever it is defined (see runJob), so a seam that only
 * swapped `core.wallet` would leave the run on the Privy per-user resolver and
 * the injected fixture would never serve a balance. This asserts both halves.
 */

const environment = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://postgres@127.0.0.1:5433/wdk_agent",
  WDK_NETWORK: "solana-devnet",
  // Present on purpose: these are exactly the inputs that would otherwise make
  // `walletForUser` defined and win the voice path.
  PRIVY_APP_ID: "fixture-app-id",
  PRIVY_VERIFICATION_KEY: "fixture-verification-key",
  PRIVY_APP_SECRET: "fixture-app-secret",
} as NodeJS.ProcessEnv;

function fixturePair(): { wallet: WalletProvider; walletReads: WalletProvider } {
  return {
    wallet: new FixtureWalletProvider(),
    walletReads: new FixtureWalletProvider(),
  };
}

describe("worker fixture wallet seam", () => {
  it("suppresses the Privy per-user resolver and serves the injected fixture pair", () => {
    const dependencies = createWorkerDependencies(environment, undefined, {
      fixtureWallet: fixturePair(),
    });

    expect(dependencies.walletForUser).toBeUndefined();
    expect(dependencies.wallet).toBeInstanceOf(FixtureWalletProvider);
  });

  it("keeps the production behaviour when no seam is passed", () => {
    const dependencies = createWorkerDependencies(environment);

    // The Privy inputs above are present, so the real resolver is built and the
    // run stays on the per-user path — the default is unchanged by the seam.
    expect(dependencies.walletForUser).toBeDefined();
    expect(dependencies.wallet).not.toBeInstanceOf(FixtureWalletProvider);
  });
});
