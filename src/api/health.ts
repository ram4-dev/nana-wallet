import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "../contracts/http.js";
import type { WalletProvider } from "../wallet/provider.js";

const NETWORK = () =>
  process.env.WDK_NETWORK ??
  (process.env.IDENTITY_PROVIDER === "privy" ? "solana-devnet" : "sepolia");
const WALLET = () =>
  process.env.WDK_WALLET_NAME ??
  (process.env.IDENTITY_PROVIDER === "privy" ? "privy-user" : "agent-demo");
// Read lazily: module-level constants froze the ambient .env at import time and
// made the health contract depend on dotenv evaluation order (hermetic tests pin
// the env before building the server).
const MODE = () =>
  process.env.IDENTITY_PROVIDER === "privy"
    ? "live"
    : process.env.WDK_TOOLS_SOURCE === "live"
      ? "live"
      : "fixture";

export async function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: { wallet: WalletProvider },
): Promise<void> {
  app.get("/health", async (): Promise<HealthResponse> => {
    let mcp: HealthResponse["mcp"] = "unknown";
    let wallet: HealthResponse["wallet"] = "unknown";

    try {
      await dependencies.wallet.listNetworks();
      mcp = "connected";
    } catch {
      mcp = "disconnected";
    }

    if (mcp === "connected") {
      try {
        await dependencies.wallet.getAddress({
          network: NETWORK(),
          wallet: WALLET(),
        });
        wallet = "unlocked";
      } catch {
        wallet = "locked";
      }
    }

    return {
      status: "ok",
      mode: MODE(),
      mcp,
      wallet,
      network: NETWORK(),
      provider: await providerHealth(dependencies.wallet),
    };
  });
}

// D5: the provider health result is additive and provider-agnostic. A health()
// implementation that throws must still yield an honest 'unavailable' envelope,
// and its reason is intentionally NOT the raw error message: SDK errors can
// interpolate configuration values, which CAR-017 forbids on the health route.
async function providerHealth(
  wallet: WalletProvider,
): Promise<HealthResponse["provider"]> {
  try {
    return await wallet.health({ wallet: WALLET(), network: NETWORK() });
  } catch {
    return {
      status: "unavailable",
      reason: "The wallet provider health check failed.",
    };
  }
}
