// Task 2.5 (solana-devnet-provider): selector, boot guard, and walletReads
// route. Spec: "Additive wiring with fail-closed boot guard" — selection only
// via WDK_TOOLS_SOURCE=solana-devnet, wallet and walletReads resolve to the
// same SolanaDevnetProvider instance, other branches stay byte-for-byte
// identical, and contradicting WDK_NETWORK/WDK_TOKEN fail before server work.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createCoreDependencies,
  createWalletProvider,
} from "../../src/runtime/dependencies.js";
import {
  SOLANA_DEVNET_NETWORK,
  SolanaDevnetConfigError,
  SolanaDevnetProvider,
} from "../../src/wallet/solana-devnet-provider.js";
import { CircleArcProvider } from "../../src/wallet/circle-arc-provider.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { WdkWalletProvider } from "../../src/wallet/wdk-provider.js";

const ARC_BASE = {
  WDK_TOOLS_SOURCE: "circle-arc",
  CIRCLE_API_KEY: "k",
  CIRCLE_ENTITY_SECRET: "a".repeat(64),
  CIRCLE_SENDER_WALLET_ID: "w",
} as const;

describe("createWalletProvider solana-devnet selection", () => {
  it("returns a live SolanaDevnetProvider when WDK_TOOLS_SOURCE=solana-devnet", () => {
    const wallet = createWalletProvider({
      WDK_TOOLS_SOURCE: "solana-devnet",
    });
    expect(wallet).toBeInstanceOf(SolanaDevnetProvider);
    expect(wallet.id).toBe("solana-devnet");
    expect(wallet.mode).toBe("live");
  });

  it("throws at boot when WDK_NETWORK contradicts the devnet contract", () => {
    expect(() =>
      createWalletProvider({
        WDK_TOOLS_SOURCE: "solana-devnet",
        WDK_NETWORK: "arc-testnet",
      }),
    ).toThrow(SolanaDevnetConfigError);
    expect(() =>
      createWalletProvider({
        WDK_TOOLS_SOURCE: "solana-devnet",
        WDK_NETWORK: "arc-testnet",
      }),
    ).toThrow(new RegExp(`WDK_NETWORK=${SOLANA_DEVNET_NETWORK}`));
  });

  it("throws at boot when WDK_TOKEN contradicts the devnet contract", () => {
    expect(() =>
      createWalletProvider({
        WDK_TOOLS_SOURCE: "solana-devnet",
        WDK_TOKEN: "USDC",
      }),
    ).toThrow(SolanaDevnetConfigError);
    expect(() =>
      createWalletProvider({
        WDK_TOOLS_SOURCE: "solana-devnet",
        WDK_TOKEN: "USDC",
      }),
    ).toThrow(/WDK_TOKEN=SOL/);
  });

  it("accepts the exact devnet network and token contract values", () => {
    const wallet = createWalletProvider({
      WDK_TOOLS_SOURCE: "solana-devnet",
      WDK_NETWORK: SOLANA_DEVNET_NETWORK,
      WDK_TOKEN: "SOL",
    });
    expect(wallet).toBeInstanceOf(SolanaDevnetProvider);
  });
});

describe("createCoreDependencies solana-devnet routing", () => {
  it("resolves wallet and walletReads to the same SolanaDevnetProvider instance", () => {
    const core = createCoreDependencies({
      WDK_TOOLS_SOURCE: "solana-devnet",
      CONVERSATION_MAX_INPUT_TOKENS: "4096",
    });
    expect(core.wallet).toBeInstanceOf(SolanaDevnetProvider);
    expect(core.walletReads).toBe(core.wallet);
  });
});

describe("existing selections unchanged", () => {
  it("circle-arc still builds CircleArcProvider and shares the reads instance", () => {
    const wallet = createWalletProvider({
      ...ARC_BASE,
      WDK_NETWORK: "arc-testnet",
      WDK_TOKEN: "USDC",
    });
    expect(wallet).toBeInstanceOf(CircleArcProvider);
    expect(wallet.id).toBe("circle-arc");

    const core = createCoreDependencies({
      ...ARC_BASE,
      WDK_NETWORK: "arc-testnet",
      WDK_TOKEN: "USDC",
      CONVERSATION_MAX_INPUT_TOKENS: "4096",
    });
    expect(core.walletReads).toBe(core.wallet);
  });

  it("live still builds WdkWalletProvider and shares the reads instance", () => {
    const wallet = createWalletProvider({ WDK_TOOLS_SOURCE: "live" });
    expect(wallet).toBeInstanceOf(WdkWalletProvider);

    const core = createCoreDependencies({
      WDK_TOOLS_SOURCE: "live",
      CONVERSATION_MAX_INPUT_TOKENS: "4096",
    });
    expect(core.walletReads).toBe(core.wallet);
  });

  it("unset still builds FixtureWalletProvider with the legacy reads provider", () => {
    const wallet = createWalletProvider({});
    expect(wallet).toBeInstanceOf(FixtureWalletProvider);

    const core = createCoreDependencies({
      CONVERSATION_MAX_INPUT_TOKENS: "4096",
    });
    expect(core.wallet).toBeInstanceOf(FixtureWalletProvider);
    expect(core.walletReads).not.toBe(core.wallet);
    expect(core.walletReads).toBeInstanceOf(WdkWalletProvider);
  });
});

// S4: the worker's Solana dispatch is authorized by the local signing sidecar
// (`createWorkerPayloadSigner`), not by an in-process authorization key. The
// hand-off is a one-line composition inside `createConfiguredWalletForUser`
// with no runtime observable short of a live Privy dispatch, so it is pinned
// at the source — the same idiom `signer-worker-path.test.ts` uses for the
// worker entry.
describe("worker wiring for the Solana dispatch signer (S4)", () => {
  it("hands the sidecar signer to the Solana per-user resolver, never the key", () => {
    const dependencies = readFileSync(
      new URL("../../src/runtime/dependencies.ts", import.meta.url),
      "utf8",
    );
    const resolverCall = dependencies.indexOf("createSolanaWalletForUser({");
    expect(
      resolverCall,
      "dependencies.ts must build the Solana per-user resolver",
    ).toBeGreaterThan(-1);
    const call = dependencies.slice(resolverCall, resolverCall + 300);
    expect(call).toContain("authorizationSigner");
    expect(dependencies).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");
  });
});
