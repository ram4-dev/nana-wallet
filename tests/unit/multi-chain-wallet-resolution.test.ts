import { describe, expect, it, vi } from "vitest";
import { createConfiguredWalletForUser } from "../../src/runtime/dependencies.js";
import type { DatabaseClient } from "../../src/db/client.js";
import {
  PrivyServerClient,
  type PrivySdkClient,
} from "../../src/wallet/privy-server-client.js";

/** Minimal SDK double: this contract never reaches the provider. */
function unusedSdkClient(): PrivySdkClient {
  return {
    wallets: () => ({ list: vi.fn(), get: vi.fn(), update: vi.fn() }),
    policies: () => ({ create: vi.fn(), get: vi.fn(), update: vi.fn() }),
  } as unknown as PrivySdkClient;
}

describe("configured multi-chain per-user wallet resolver", () => {
  it("requires an explicit chain family instead of falling through to Ethereum", async () => {
    const privy = new PrivyServerClient({
      appId: "app-test",
      appSecret: "secret-test",
      client: unusedSdkClient(),
    });
    const resolve = createConfiguredWalletForUser(
      {} as DatabaseClient,
      { IDENTITY_PROVIDER: "privy" },
      privy,
    );

    await expect(resolve?.("user-a")).rejects.toMatchObject({
      code: "wallet_config_error",
    });
  });
});
