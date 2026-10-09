import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Transaction } from "@solana/web3.js";
import {
  APIConnectionTimeoutError,
  APIError,
  formatRequestForAuthorizationSignature,
  generateP256KeyPair,
  PermissionDeniedError,
} from "@privy-io/node";
import {
  SolanaDevnetConfigError,
  SolanaDevnetProvider,
  buildDevnetSolTransfer,
  createPrivySignAndSendClient,
  privySignAndSendFromEnvironment,
  serializeUnsignedTransaction,
  SOLANA_DEVNET_NETWORK,
  SOLANA_DEVNET_CAIP2,
  type PrivySolanaRpcInput,
  type PrivySolanaSdkClient,
  type SolanaRpc,
  type SolanaSignAndSendClient,
} from "../../src/wallet/solana-devnet-provider.js";
import { explorerUrlFor } from "../../src/wallet/provider.js";
import { signerAuthorizationContext } from "../../src/wallet/signer/authorization-context.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";

const WALLET_ID = "wallet-1";
const CONTEXT = { wallet: WALLET_ID, network: SOLANA_DEVNET_NETWORK };
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SENDER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const SIGNATURE =
  "5ZzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWMAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REQUEST = {
  ...CONTEXT,
  token: "SOL",
  to: RECIPIENT,
  amount: "0.5",
  previewId: "preview-1",
};

function rpcDouble(overrides: Partial<SolanaRpc> = {}): SolanaRpc {
  return {
    getBalance: vi.fn().mockResolvedValue(2_000_000_000n),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getRecentBlockhash: vi
      .fn()
      .mockResolvedValue("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"),
    getFeeForTransferMessage: vi.fn().mockResolvedValue(5_000n),
    ...overrides,
  };
}

function signerDouble(
  overrides: Partial<SolanaSignAndSendClient> = {},
): SolanaSignAndSendClient {
  return {
    signAndSend: vi
      .fn()
      .mockResolvedValue({ hash: SIGNATURE, id: "privy-tx-1" }),
    ...overrides,
  } as SolanaSignAndSendClient;
}

function provider(
  rpc: SolanaRpc = rpcDouble(),
  signAndSend: SolanaSignAndSendClient = signerDouble(),
): SolanaDevnetProvider {
  return new SolanaDevnetProvider(
    { walletId: WALLET_ID, senderAddress: SENDER },
    {
      rpc,
      signAndSend,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
    },
  );
}

describe("SolanaDevnetProvider", () => {
  it.each([undefined, "", "   "])(
    "fails closed without a persisted preview ID before RPC or signing (%s)",
    async (previewId) => {
      const rpc = rpcDouble();
      const signer = signerDouble();
      const p = provider(rpc, signer);

      await expect(
        p.broadcastTransfer({ ...REQUEST, previewId }),
      ).resolves.toMatchObject({
        kind: "not_dispatched",
        // A missing previewId is our malformed request, not the wallet's fault.
        cause: "invalid_request",
      });
      expect(rpc.getRecentBlockhash).not.toHaveBeenCalled();
      expect(signer.signAndSend).not.toHaveBeenCalled();
    },
  );

  it("satisfies the normalized provider contract on devnet", async () => {
    const p = provider();
    await expect(p.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(p.listNetworks()).resolves.toEqual([
      { network: SOLANA_DEVNET_NETWORK, kind: "testnet" },
    ]);
    await expect(p.listTokens(SOLANA_DEVNET_NETWORK)).resolves.toEqual([
      { network: SOLANA_DEVNET_NETWORK, token: "SOL", decimals: 9 },
    ]);
    await expect(p.getAddress(CONTEXT)).resolves.toEqual({
      network: SOLANA_DEVNET_NETWORK,
      address: SENDER,
    });
    await expect(
      p.getBalance({ ...CONTEXT, token: "SOL" }),
    ).resolves.toMatchObject({
      network: SOLANA_DEVNET_NETWORK,
      token: "SOL",
      address: SENDER,
      balance: "2",
    });
    await expect(p.getHistory(CONTEXT)).resolves.toEqual({
      network: SOLANA_DEVNET_NETWORK,
      transactions: [],
    });
    const preview = await p.previewTransfer(REQUEST);
    expect(preview).toMatchObject({
      network: SOLANA_DEVNET_NETWORK,
      token: "SOL",
      recipient: RECIPIENT,
      amount: "0.5",
    });
    const broadcast = await p.broadcastTransfer(REQUEST);
    expect(broadcast.kind).toBe("submitted");
    if (broadcast.kind === "submitted") {
      await expect(
        p.waitForFinality(broadcast.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
        transactionHash: SIGNATURE,
      });
    }
    await p.close();
  });

  it("refuses every non-devnet network before any RPC or signer call", async () => {
    const rpc = rpcDouble();
    const signAndSend = signerDouble();
    const p = provider(rpc, signAndSend);
    for (const network of [
      "solana-mainnet",
      "solana",
      "sepolia",
      "arc-testnet",
    ]) {
      const context = { wallet: WALLET_ID, network };
      await expect(
        p.health(context as never).then(
          () => null,
          (e: unknown) => (e as Error).message,
        ),
      ).resolves.toContain("solana-devnet");
      await expect(p.listTokens(network)).rejects.toThrow(/solana-devnet/);
      await expect(p.getAddress(context)).rejects.toThrow(/solana-devnet/);
      await expect(p.getBalance({ ...context, token: "SOL" })).rejects.toThrow(
        /solana-devnet/,
      );
      await expect(p.getHistory(context)).rejects.toThrow(/solana-devnet/);
      await expect(p.previewTransfer({ ...REQUEST, network })).rejects.toThrow(
        /solana-devnet/,
      );
      await expect(
        p.broadcastTransfer({ ...REQUEST, network }),
      ).rejects.toThrow(/solana-devnet/);
    }
    expect(rpc.getBalance).not.toHaveBeenCalled();
    expect(signAndSend.signAndSend).not.toHaveBeenCalled();
  });

  it("refuses invalid recipients on preview and broadcast", async () => {
    const p = provider();
    await expect(
      p.previewTransfer({ ...REQUEST, to: "not-base58!!" }),
    ).rejects.toThrow();
    await expect(
      p.previewTransfer({ ...REQUEST, to: "11111111111111111111111111111111" }),
    ).rejects.toThrow();
    await expect(
      p.previewTransfer({ ...REQUEST, to: SENDER }),
    ).rejects.toThrow();
    await expect(
      p.broadcastTransfer({ ...REQUEST, to: "not-base58!!" }),
    ).rejects.toThrow();
  });

  it("fails closed without the persisted preview ID before RPC or signing", async () => {
    const rpc = rpcDouble();
    const signer = signerDouble();
    const p = provider(rpc, signer);

    await expect(p.broadcastTransfer({ ...REQUEST, previewId: undefined })).resolves.toMatchObject({
      kind: "not_dispatched",
      cause: "invalid_request",
    });
    expect(rpc.getRecentBlockhash).not.toHaveBeenCalled();
    expect(signer.signAndSend).not.toHaveBeenCalled();
  });

  it("maps broadcast outcomes honestly", async () => {
    const notDispatched = provider(
      rpcDouble(),
      signerDouble({
        signAndSend: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("policy denied"), { definitive: true }),
          ),
      }),
    );
    await expect(
      notDispatched.broadcastTransfer(REQUEST),
    ).resolves.toMatchObject({
      kind: "not_dispatched",
      // `definitive` is only set for a policy denial.
      cause: "policy_rejected",
    });

    const uncertain = provider(
      rpcDouble(),
      signerDouble({
        signAndSend: vi
          .fn()
          .mockRejectedValue(new Error("timeout after leaving our process")),
      }),
    );
    const outcome = await uncertain.broadcastTransfer(REQUEST);
    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind === "uncertain")
      expect(outcome.reason).toMatch(/reference/i);
  });

  it("reconciliation never re-dispatches: single dispatch, stable reference, stays uncertain", async () => {
    const signAndSend = signerDouble({
      signAndSend: vi
        .fn()
        .mockRejectedValue(new Error("timeout after leaving our process")),
    });
    const p = provider(rpcDouble(), signAndSend);
    const first = await p.broadcastTransfer(REQUEST);
    expect(first.kind).toBe("uncertain");
    const dispatchMock = signAndSend.signAndSend as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const calls = dispatchMock.mock.calls as Array<
      [string, string, string, string]
    >;
    expect(calls[0][3]).toBe("preview-1");
    expect(calls[0][3].length).toBeLessThanOrEqual(64);
    // Reconcile by reference only — no second dispatch; without an
    // authoritative reference lookup the outcome stays uncertain.
    const reconciled = await p.reconcileBroadcast(REQUEST);
    expect(reconciled.kind).toBe("uncertain");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("AD-11: missing, empty, or whitespace previewId fails closed before RPC or signer calls", async () => {
    for (const previewId of [undefined, "", "   "] as const) {
      const rpc = rpcDouble();
      const signAndSend = signerDouble();
      const p = provider(rpc, signAndSend);
      const outcome = await p.broadcastTransfer({
        ...REQUEST,
        previewId,
      });
      expect(outcome.kind).toBe("not_dispatched");
      if (outcome.kind === "not_dispatched") {
        expect(outcome.reason).toMatch(/preview/i);
        expect(outcome.cause).toBe("invalid_request");
      }
      // Fail closed BEFORE any dispatch seam: no recent blockhash read,
      // no signing/broadcast, and no synthesized fallback reference.
      expect(rpc.getRecentBlockhash).not.toHaveBeenCalled();
      expect(signAndSend.signAndSend).not.toHaveBeenCalled();
    }
  });

  it("AD-11: a valid previewId is used verbatim as the dispatch reference", async () => {
    const rpc = rpcDouble();
    const signAndSend = signerDouble();
    const p = provider(rpc, signAndSend);
    await p.broadcastTransfer(REQUEST); // REQUEST.previewId = "preview-1"
    const dispatchMock = signAndSend.signAndSend as unknown as ReturnType<
      typeof vi.fn
    >;
    const calls = dispatchMock.mock.calls as Array<
      [string, string, string, string]
    >;
    expect(calls).toHaveLength(1);
    // Verbatim identity: no timestamp/random fallback reference.
    expect(calls[0]?.[3]).toBe("preview-1");
  });

  it("dispatches only via Privy signAndSendTransaction with auth signature and devnet caip2", async () => {
    const signAndSend = signerDouble();
    const p = provider(rpcDouble(), signAndSend);
    await p.broadcastTransfer(REQUEST);
    const dispatchMock = signAndSend.signAndSend as unknown as ReturnType<
      typeof vi.fn
    >;
    const [walletId, caip2, transaction, referenceId] = dispatchMock.mock
      .calls[0] as [string, string, string, string];
    expect(walletId).toBe(WALLET_ID);
    expect(caip2).toBe(SOLANA_DEVNET_CAIP2);
    expect(typeof transaction).toBe("string");
    expect(transaction.length).toBeGreaterThan(0);
    expect(referenceId).toBe("preview-1");
    const rpc = rpcDouble();
    expect(Object.keys(rpc)).not.toContain("sendTransaction");
  });

  it("polls finality: confirmed, reverted, cache-miss recovery, receipt_invalid, deadline, abort", async () => {
    const confirmed = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
      }),
    );
    const broadcast = await confirmed.broadcastTransfer(REQUEST);
    expect(broadcast.kind).toBe("submitted");
    if (broadcast.kind === "submitted") {
      await expect(
        confirmed.waitForFinality(broadcast.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
      });
    }

    const reverted = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([
            { confirmationStatus: "finalized", err: "AccountInUse" },
          ]),
      }),
    );
    const b2 = await reverted.broadcastTransfer(REQUEST);
    if (b2.kind === "submitted") {
      await expect(
        reverted.waitForFinality(b2.transaction),
      ).resolves.toMatchObject({
        status: "reverted",
      });
    }

    // Cache-miss (null status) + history present + meta err null -> confirmed.
    const historyHit = provider(
      rpcDouble({
        getSignatureStatuses: vi.fn().mockResolvedValue(null),
        getSignaturesForAddress: vi
          .fn()
          .mockResolvedValue([{ signature: SIGNATURE }]),
        getTransaction: vi
          .fn()
          .mockResolvedValue({ slot: 1, meta: { err: null } }),
      }),
    );
    const b3 = await historyHit.broadcastTransfer(REQUEST);
    if (b3.kind === "submitted") {
      await expect(
        historyHit.waitForFinality(b3.transaction),
      ).resolves.toMatchObject({
        status: "confirmed",
      });
    }

    // Exhausted history without the signature: proven absent -> receipt_invalid.
    const absent = provider(
      rpcDouble({
        getSignatureStatuses: vi.fn().mockResolvedValue(null),
        getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      }),
    );
    const b3a = await absent.broadcastTransfer(REQUEST);
    if (b3a.kind === "submitted") {
      await expect(
        absent.waitForFinality(b3a.transaction),
      ).resolves.toMatchObject({
        status: "receipt_invalid",
      });
    }

    let now = 0;
    const deadline = new SolanaDevnetProvider(
      { walletId: WALLET_ID, senderAddress: SENDER },
      {
        rpc: rpcDouble({
          // RPC success with no status entry: resolver returns null each poll,
          // forcing pure deadline timeout (exhausted=false).
          getSignatureStatuses: vi.fn().mockResolvedValue([]),
          getTransaction: vi.fn().mockResolvedValue(null),
        }),
        signAndSend: signerDouble(),
        sleep: vi.fn().mockImplementation(() => {
          now += 3_000;
        }),
        now: () => now,
      },
    );
    const b4 = await deadline.broadcastTransfer(REQUEST);
    if (b4.kind === "submitted") {
      await expect(deadline.waitForFinality(b4.transaction)).rejects.toThrow(
        /deadline/i,
      );
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = provider(
      rpcDouble({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
      }),
    );
    const b5 = await aborted.broadcastTransfer(REQUEST);
    if (b5.kind === "submitted") {
      await expect(
        aborted.waitForFinality(b5.transaction, controller.signal),
      ).rejects.toThrow(/abort/i);
    }
  });

  it("registers the devnet explorer URL", async () => {
    expect(explorerUrlFor(SOLANA_DEVNET_NETWORK, SIGNATURE)).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    );
    const p = provider();
    const broadcast = await p.broadcastTransfer(REQUEST);
    if (broadcast.kind === "submitted") {
      expect(broadcast.transaction.explorerUrl).toBe(
        explorerUrlFor(SOLANA_DEVNET_NETWORK, SIGNATURE),
      );
    }
  });

  it("builds a legacy Transaction with exactly one SystemProgram.transfer and no ALT path", () => {
    const transaction = buildDevnetSolTransfer(
      SENDER,
      RECIPIENT,
      500_000_000n,
      "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
    );
    // Legacy class, not v0: the legacy Transaction type carries no
    // addressLookupTableAccounts, so no ALT path can even be expressed.
    expect(transaction).toBeInstanceOf(Transaction);
    // Exactly one instruction: the SystemProgram.transfer to the exact
    // recipient with the exact lamports.
    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0]!;
    expect(instruction.programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(instruction.keys.map((k) => k.pubkey.toBase58())).toEqual([
      SENDER,
      RECIPIENT,
    ]);
    // The transfer data is the 12-byte SystemProgram.transfer layout:
    // u32 LE discriminator [2,0,0,0] + u64 little-endian lamports.
    const expectedData = Buffer.alloc(12);
    expectedData.set([2, 0, 0, 0], 0);
    expectedData.writeBigUInt64LE(500_000_000n, 4);
    expect(instruction.data.equals(expectedData)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S4: the official `@privy-io/node` SDK owns the Privy transport. The client
// no longer assembles the request body, the privy-* headers, the expiry, the
// idempotency key, the basic auth pair or the authorization signature, and it
// no longer fetches: it calls `privy.wallets().solana().signAndSendTransaction`
// and the SDK does all of that.
// ---------------------------------------------------------------------------

const SDK_DISPATCH_INPUT_KEYS = [
  "authorization_context",
  "caip2",
  "idempotency_key",
  "reference_id",
  "transaction",
] as const;

type SolanaSdkOutcome =
  | {
      kind: "data";
      data: {
        hash: string;
        signed_transaction?: string;
        transaction_id?: string;
      };
    }
  | { kind: "error"; error: unknown };

type RecordedDispatch = { walletId: string; input: PrivySolanaRpcInput };

/**
 * Fake of the narrow SDK surface the dispatch client is allowed to use: the
 * method NAME is the port, so a call recorded here can only have come from
 * `wallets().solana().signAndSendTransaction`.
 */
function fakeSolanaSdk(
  initial: SolanaSdkOutcome = {
    kind: "data",
    data: { hash: SIGNATURE, transaction_id: "privy-tx-1" },
  },
) {
  const calls: RecordedDispatch[] = [];
  let outcome = initial;
  const sdk: PrivySolanaSdkClient = {
    wallets: () => ({
      solana: () => ({
        async signAndSendTransaction(walletId, input) {
          calls.push({ walletId, input });
          if (outcome.kind === "error") throw outcome.error;
          return outcome.data;
        },
      }),
    }),
  };
  return {
    sdk,
    calls,
    respond(next: SolanaSdkOutcome) {
      outcome = next;
    },
  };
}

function sdkClient(
  sdk: PrivySolanaSdkClient,
  signer: (payload: Uint8Array) => Promise<string> = async () => "sig",
): SolanaSignAndSendClient {
  return createPrivySignAndSendClient({
    appId: "app-test",
    appSecret: "secret-test",
    authorizationContext: signerAuthorizationContext(signer),
    client: sdk,
  });
}

function unsignedBase64(lamports: bigint = 500_000_000n): string {
  return serializeUnsignedTransaction(
    buildDevnetSolTransfer(
      SENDER,
      RECIPIENT,
      lamports,
      "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
    ),
  );
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "") ===
      value.replace(/=+$/u, "")
  );
}

describe("Privy Solana dispatch through the official SDK (S4)", () => {
  it("calls the SDK's signAndSendTransaction with the devnet caip2 and the base64 transaction", async () => {
    const { sdk, calls } = fakeSolanaSdk();
    const client = sdkClient(sdk);
    const base64 = unsignedBase64();

    const result = await client.signAndSend(
      WALLET_ID,
      SOLANA_DEVNET_CAIP2,
      base64,
      "preview-1",
    );

    expect(result).toEqual({ hash: SIGNATURE, id: "privy-tx-1" });
    expect(calls).toHaveLength(1);
    const dispatch = calls[0]!;
    expect(dispatch.walletId).toBe(WALLET_ID);
    expect(dispatch.input.caip2).toBe(SOLANA_DEVNET_CAIP2);
    // The transaction crosses the seam as BASE64 text (the SDK treats a string
    // as base64 and encodes the RPC params itself).
    expect(typeof dispatch.input.transaction).toBe("string");
    const transaction = dispatch.input.transaction as string;
    expect(isBase64(transaction)).toBe(true);
    expect(Buffer.from(transaction, "base64").equals(Buffer.from(base64, "base64"))).toBe(
      true,
    );
    // Nothing but the SDK call contract crosses the seam: no body, url,
    // headers, expiry or signature are assembled by our client.
    expect(Object.keys(dispatch.input).sort()).toEqual([
      ...SDK_DISPATCH_INPUT_KEYS,
    ]);
  });

  it("authorizes the SDK call from the injected signer port, never an in-process key", async () => {
    const signer = vi.fn(async () => "sig");
    const { sdk, calls } = fakeSolanaSdk();
    const client = sdkClient(sdk, signer);

    await client.signAndSend(
      WALLET_ID,
      SOLANA_DEVNET_CAIP2,
      unsignedBase64(),
      "preview-1",
    );

    expect(calls[0]!.input.authorization_context).toEqual({ sign_fns: [signer] });
    expect(calls[0]!.input.authorization_context?.sign_fns?.[0]).toBe(signer);
  });

  it("carries one unique reference and idempotency key per dispatch", async () => {
    const { sdk, calls } = fakeSolanaSdk();
    const client = sdkClient(sdk);
    const base64 = unsignedBase64();

    await client.signAndSend(WALLET_ID, SOLANA_DEVNET_CAIP2, base64, "preview-1");
    await client.signAndSend(WALLET_ID, SOLANA_DEVNET_CAIP2, base64, "preview-2");
    await client.signAndSend(WALLET_ID, SOLANA_DEVNET_CAIP2, base64, "preview-1");

    // The reference ID is both the Privy reference_id and the idempotency key,
    // so a replayed request is never a new dispatch and two dispatches never
    // share one key.
    expect(calls.map((call) => call.input.reference_id)).toEqual([
      "preview-1",
      "preview-2",
      "preview-1",
    ]);
    expect(calls.map((call) => call.input.idempotency_key)).toEqual([
      "preview-1",
      "preview-2",
      "preview-1",
    ]);
    expect(new Set(calls.map((call) => call.input.idempotency_key)).size).toBe(
      2,
    );
  });

  it("maps the SDK response data onto hash, signed transaction and id", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    const client = sdkClient(sdk);
    respond({
      kind: "data",
      data: {
        hash: SIGNATURE,
        signed_transaction: "c2lnbmVk",
        transaction_id: "privy-tx-9",
      },
    });

    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).resolves.toEqual({
      hash: SIGNATURE,
      signedTransaction: "c2lnbmVk",
      id: "privy-tx-9",
    });
  });

  it("maps a response without a hash to an empty hash (never a fabricated signature)", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    const client = sdkClient(sdk);
    respond({ kind: "data", data: { hash: "" } });

    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).resolves.toMatchObject({ hash: "" });
  });

  it("keeps a policy denial definitive and every transport failure ambiguous", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    const client = sdkClient(sdk);

    respond({
      kind: "error",
      error: new PermissionDeniedError(
        403,
        { error: "policy_violation" },
        undefined,
        new Headers(),
      ),
    });
    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).rejects.toMatchObject({ definitive: true });

    respond({
      kind: "error",
      error: new APIConnectionTimeoutError({ message: "timed out" }),
    });
    const ambiguous = await client
      .signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      )
      .catch((error: unknown) => error);
    expect((ambiguous as { definitive?: boolean }).definitive).not.toBe(true);
  });

  it("reports a definitive policy denial as not_dispatched through the provider", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    respond({
      kind: "error",
      error: new PermissionDeniedError(
        403,
        { error: "policy_violation" },
        undefined,
        new Headers(),
      ),
    });
    const p = provider(rpcDouble(), sdkClient(sdk));

    await expect(p.broadcastTransfer(REQUEST)).resolves.toMatchObject({
      kind: "not_dispatched",
      cause: "policy_rejected",
    });
  });

  // The live endpoint answers a policy denial with HTTP 400 and the body code
  // `policy_violation` — NOT the SDK's 403 `PermissionDeniedError`. Captured
  // verbatim from a real call against the Solana wallet on 2026-10-09:
  //   400 {"error":"RPC request denied due to policy violation","code":"policy_violation"}
  // Recognising only 403 therefore classified every real denial as an unknown
  // dispatch outcome, which tells the user we do not know whether their money
  // moved when Privy had already refused before signing anything.
  const realPolicyDenial = () =>
    new APIError(
      400,
      {
        error: "RPC request denied due to policy violation",
        code: "policy_violation",
      },
      undefined,
      new Headers(),
    );

  it("treats Privy's real 400 policy_violation body as a definitive denial", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    const client = sdkClient(sdk);
    respond({ kind: "error", error: realPolicyDenial() });

    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).rejects.toMatchObject({ definitive: true });
  });

  it("reports Privy's real 400 policy denial as not_dispatched, never uncertain", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    respond({ kind: "error", error: realPolicyDenial() });
    const p = provider(rpcDouble(), sdkClient(sdk));

    await expect(p.broadcastTransfer(REQUEST)).resolves.toMatchObject({
      kind: "not_dispatched",
      cause: "policy_rejected",
    });
  });

  it("does not widen definitive to a 400 that is not a policy denial", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    respond({
      kind: "error",
      error: new APIError(
        400,
        { error: "unexpected upstream failure", code: "upstream_error" },
        undefined,
        new Headers(),
      ),
    });
    const p = provider(rpcDouble(), sdkClient(sdk));

    // An unrecognised 400 stays ambiguous: reconciliation, never a silent
    // retry, governs the next step.
    const outcome = await p.broadcastTransfer(REQUEST);
    expect(outcome.kind).toBe("uncertain");
  });

  it("keeps an ambiguous SDK failure uncertain and asks for reconciliation by reference", async () => {
    const { sdk, respond } = fakeSolanaSdk();
    respond({ kind: "error", error: new Error("socket hang up") });
    const p = provider(rpcDouble(), sdkClient(sdk));

    const outcome = await p.broadcastTransfer(REQUEST);
    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind === "uncertain") {
      expect(outcome.reason).toMatch(/reference/i);
      expect(outcome.reason).toContain("preview-1");
    }
  });

  it("dispatches the exact unsigned legacy transfer the provider built", async () => {
    const { sdk, calls } = fakeSolanaSdk();
    const p = provider(rpcDouble(), sdkClient(sdk));

    const outcome = await p.broadcastTransfer(REQUEST);
    expect(outcome.kind).toBe("submitted");

    const transaction = Transaction.from(
      Buffer.from(calls[0]!.input.transaction as string, "base64"),
    );
    expect(transaction.feePayer?.toBase58()).toBe(SENDER);
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.instructions[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([
      SENDER,
      RECIPIENT,
    ]);
    expect(calls[0]!.input.reference_id).toBe("preview-1");
  });

  it("fails closed before any SDK call when the app credentials are absent", async () => {
    const client = privySignAndSendFromEnvironment({});
    expect(() => privySignAndSendFromEnvironment({})).not.toThrow();
    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).rejects.toThrow(SolanaDevnetConfigError);
  });

  it("fails closed when the local signing sidecar is not configured", async () => {
    const client = privySignAndSendFromEnvironment({
      PRIVY_APP_ID: "app-test",
      PRIVY_APP_SECRET: "secret-test",
    });

    const error = await client
      .signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SolanaDevnetConfigError);
    // The failure names the sidecar surface, never an in-process key.
    expect((error as Error).message).toContain("PRIVY_SIGNER_URL");
    expect((error as Error).message).not.toContain(
      "PRIVY_AUTHORIZATION_PRIVATE_KEY",
    );
  });

  it("never reads the authorization private key from the worker modules", () => {
    for (const relativePath of [
      "src/wallet/solana-devnet-provider.ts",
      "src/wallet/solana-user-wallet.ts",
      "src/runtime/dependencies.ts",
    ]) {
      const source = readFileSync(
        new URL(`../../${relativePath}`, import.meta.url),
        "utf8",
      );
      expect(source, relativePath).not.toContain(
        "PRIVY_AUTHORIZATION_PRIVATE_KEY",
      );
    }
    // The key is owned exclusively by the sidecar entrypoint.
    expect(
      readFileSync(
        new URL("../../src/wallet/signer/server.ts", import.meta.url),
        "utf8",
      ),
    ).toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");
  });

  it("reconciles without dispatching: the SDK client offers no lookup-by-reference", async () => {
    const { sdk, calls } = fakeSolanaSdk();
    const p = provider(rpcDouble(), sdkClient(sdk));

    // `reconcileBroadcast` only ever reads through `findByReference`; the SDK
    // exposes no lookup by reference id (its Actions resource is
    // `get(actionId)`, the wallet transaction list carries no reference_id),
    // so an unresolved reference stays uncertain and is NEVER re-broadcast.
    const reconciled = await p.reconcileBroadcast(REQUEST);
    expect(reconciled.kind).toBe("uncertain");
    if (reconciled.kind === "uncertain") {
      expect(reconciled.reason).toContain("preview-1");
    }
    expect(calls).toHaveLength(0);
  });

  it("reconciles from an authoritative reference lookup without any dispatch", async () => {
    const { sdk, calls } = fakeSolanaSdk();
    const dispatch = sdkClient(sdk);
    const findByReference = vi.fn(async () => ({ hash: SIGNATURE, id: "tx-1" }));
    const p = provider(rpcDouble(), { ...dispatch, findByReference });

    await expect(p.reconcileBroadcast(REQUEST)).resolves.toMatchObject({
      kind: "submitted",
      transaction: { transactionHash: SIGNATURE },
    });
    expect(findByReference).toHaveBeenCalledWith("preview-1");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The strongest available proof that the SDK — not our code — owns the
// transport: drive the REAL `PrivyClient` against a local HTTP server and
// inspect the request it produced, including the authorization signature the
// SDK computed from our signer port (verified with the P-256 public key).
// ---------------------------------------------------------------------------

type RecordedPrivyRequest = {
  method: string;
  path: string;
  host: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

async function startFakePrivyApi(responseBody: unknown): Promise<{
  url: string;
  requests: RecordedPrivyRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedPrivyRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        host: request.headers.host ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : String(value ?? ""),
          ]),
        ),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as Record<
          string,
          unknown
        >,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("the official SDK owns the Privy wallet-RPC transport", () => {
  let api: Awaited<ReturnType<typeof startFakePrivyApi>> | undefined;

  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it("sends the documented RPC request, authorized by the signer port, and maps the response", async () => {
    api = await startFakePrivyApi({
      method: "signAndSendTransaction",
      data: { caip2: SOLANA_DEVNET_CAIP2, hash: SIGNATURE, transaction_id: "privy-tx-7" },
    });
    const keyPair = await generateP256KeyPair();
    const sidecarSigner = createKeyPayloadSigner(keyPair.privateKey);
    const signedPayloads: Uint8Array[] = [];
    const signer = async (payload: Uint8Array): Promise<string> => {
      signedPayloads.push(payload);
      return sidecarSigner(payload);
    };

    const client = createPrivySignAndSendClient({
      appId: "app-test",
      appSecret: "secret-test",
      authorizationContext: signerAuthorizationContext(signer),
      baseUrl: api.url,
    });
    const base64 = unsignedBase64();

    await expect(
      client.signAndSend(WALLET_ID, SOLANA_DEVNET_CAIP2, base64, "preview-1"),
    ).resolves.toEqual({ hash: SIGNATURE, id: "privy-tx-7" });

    expect(api.requests).toHaveLength(1);
    const request = api.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(`/v1/wallets/${WALLET_ID}/rpc`);
    // The SDK owns the headers: app id, the idempotency key we named, a fresh
    // request expiry and the basic auth pair.
    expect(request.headers["privy-app-id"]).toBe("app-test");
    expect(request.headers["privy-idempotency-key"]).toBe("preview-1");
    expect(Number(request.headers["privy-request-expiry"])).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("app-test:secret-test").toString("base64")}`,
    );
    // ... and the body the SDK builds from the `transaction` we passed.
    expect(request.body).toEqual({
      method: "signAndSendTransaction",
      chain_type: "solana",
      caip2: SOLANA_DEVNET_CAIP2,
      reference_id: "preview-1",
      params: { transaction: base64, encoding: "base64" },
    });

    // The authorization signature is the one OUR signer produced over the
    // SDK's own formatting of that request: the key never entered this process.
    expect(signedPayloads).toHaveLength(1);
    const expectedPayload = formatRequestForAuthorizationSignature({
      version: 1,
      method: "POST",
      url: `http://${request.host}${request.path}`,
      body: request.body,
      headers: {
        "privy-app-id": "app-test",
        "privy-idempotency-key": "preview-1",
        "privy-request-expiry": request.headers["privy-request-expiry"]!,
      },
    });
    expect(Buffer.from(signedPayloads[0]!)).toEqual(
      Buffer.from(expectedPayload),
    );
    const publicKey = createPublicKey({
      key: Buffer.from(keyPair.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        "sha256",
        expectedPayload,
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(request.headers["privy-authorization-signature"]!, "base64"),
      ),
    ).toBe(true);
  });

  it("builds the SDK client from the environment without the authorization key", async () => {
    api = await startFakePrivyApi({
      method: "signAndSendTransaction",
      data: { caip2: SOLANA_DEVNET_CAIP2, hash: SIGNATURE },
    });
    const keyPair = await generateP256KeyPair();
    const client = privySignAndSendFromEnvironment(
      {
        PRIVY_APP_ID: "app-test",
        PRIVY_APP_SECRET: "secret-test",
        PRIVY_API_BASE_URL: `${api.url}/v1`,
        // A decoy: nothing in this process may consume it.
        PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-this-process-must-not-use",
      },
      createKeyPayloadSigner(keyPair.privateKey),
    );

    await expect(
      client.signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedBase64(),
        "preview-1",
      ),
    ).resolves.toMatchObject({ hash: SIGNATURE });
    expect(api.requests).toHaveLength(1);
    const publicKey = createPublicKey({
      key: Buffer.from(keyPair.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    // The sidecar-held key authorized the request; the decoy did not.
    expect(
      verify(
        "sha256",
        formatRequestForAuthorizationSignature({
          version: 1,
          method: "POST",
          url: `http://${api.requests[0]!.host}${api.requests[0]!.path}`,
          body: api.requests[0]!.body,
          headers: {
            "privy-app-id": "app-test",
            "privy-idempotency-key": "preview-1",
            "privy-request-expiry":
              api.requests[0]!.headers["privy-request-expiry"]!,
          },
        }),
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(
          api.requests[0]!.headers["privy-authorization-signature"]!,
          "base64",
        ),
      ),
    ).toBe(true);
  });

});
