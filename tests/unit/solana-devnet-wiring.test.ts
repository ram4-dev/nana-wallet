// S4: the worker's Solana dispatch is authorized by the local signing sidecar
// (`createWorkerPayloadSigner`), not by an in-process authorization key. The
// hand-off is a one-line composition inside `createConfiguredWalletForUser`
// with no runtime observable short of a live Privy dispatch, so it is pinned
// at the source — the same idiom `signer-worker-path.test.ts` uses for the
// worker entry.
//
// The provider-selection cases that used to live here were deleted with the
// wallet-source switch: there is no provider selector left to test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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
