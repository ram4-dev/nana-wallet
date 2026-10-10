import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOLANA_DEVNET_RPC_URL } from "../../src/wallet/solana-devnet-provider.js";
import { createSnsTransport, readSnsTransportConfig } from "../../src/wallet/sns/transport.js";

/**
 * Task 1.1 (design §1.4): `SNS_RPC_URL` is read exactly like `BALANCE_RPC_URL`,
 * with the same shipped default, and the value is never printed.
 */
function transportSource(): string {
  return readFileSync(
    fileURLToPath(new URL("../../src/wallet/sns/transport.ts", import.meta.url)),
    "utf8",
  );
}

describe("readSnsTransportConfig", () => {
  it("defaults to the shipped devnet endpoint when SNS_RPC_URL is absent", () => {
    const config = readSnsTransportConfig({});
    expect(config.rpcUrl).toBe(SOLANA_DEVNET_RPC_URL);
    expect(config.rpcUrl).toBe("https://api.devnet.solana.com");
  });

  it("honours a set SNS_RPC_URL instead of the default", () => {
    const config = readSnsTransportConfig({ SNS_RPC_URL: "https://example.invalid/keyed" });
    expect(config.rpcUrl).toBe("https://example.invalid/keyed");
    expect(config.rpcUrl).not.toBe(SOLANA_DEVNET_RPC_URL);
  });

  it("reads the variable with the same nullish fallback precedent as the balance surface", () => {
    // Positive control: the module really carries the override chain, so the
    // "never printed" assertions below are not scanning an unrelated file.
    const source = transportSource();
    expect(source).toContain("SNS_RPC_URL");
    expect(source).toContain("SOLANA_DEVNET_RPC_URL");
    expect(readSnsTransportConfig({ SNS_RPC_URL: "" }).rpcUrl).toBe("");
  });

  it("never prints the configured endpoint", () => {
    const source = transportSource();
    for (const forbidden of [
      "console.log",
      "console.error",
      "console.warn",
      "console.info",
      "process.stdout",
      "process.stderr",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("requires a non-empty rpcUrl", () => {
    expect(() => createSnsTransport({ rpcUrl: "" })).toThrowError(/rpcUrl/);
  });

  it("never echoes the endpoint in the misconfiguration error", () => {
    // A blank-but-present value is the only way to reach the throw, and the
    // message must stay free of whatever was configured.
    let message = "";
    try {
      createSnsTransport({ rpcUrl: "   " });
      throw new Error("expected a throw");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/rpcUrl/);
    expect(message).not.toContain("http");
  });

  it("returns the three-port transport surface", () => {
    const transport = createSnsTransport({ rpcUrl: "https://example.invalid" });
    expect(typeof transport.deriveNameAccount).toBe("function");
    expect(typeof transport.readNameRegistry).toBe("function");
    expect(typeof transport.readPrimaryDomain).toBe("function");
    // Derivation is local and synchronous: it must not need the network.
    expect(transport.deriveNameAccount("sophie").pubkey).toBe(
      "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew",
    );
  });
});
