import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";

import { RpcBalanceReader } from "../../src/wallet/balances.js";

/**
 * WP-006/WP-007: the RPC adapter is exercised against a controlled local
 * JSON-RPC server. It must only observe `getBalance` for the requested address,
 * validate the lamport result as an exactly-representable non-negative integer
 * and fail closed on every malformed response — including a full 8s-deadline
 * timeout, tested with a tiny deadline override instead of really waiting.
 */

/** Devnet-shaped base58 address (the reader never re-validates it). */
const ADDRESS = "AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX";
/** Largest lamport count a JSON number represents exactly (2^53 - 1). */
const MAX_EXACT_LAMPORTS = 9_007_199_254_740_991;

type RpcHandler = (
  method: string,
  params: unknown[],
) =>
  | { result?: unknown; error?: { code: number; message: string } }
  | undefined;

/** Solana `getBalance` result envelope: { context, value }. */
function balanceResult(value: unknown) {
  return { context: { slot: 1, apiVersion: "1.18.0" }, value };
}

async function startRpc(
  handler: RpcHandler,
): Promise<{
  server: Server;
  url: string;
  calls: Array<{ method: string; params: unknown[] }>;
}> {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      calls.push({ method: parsed.method, params: parsed.params });
      const outcome = handler(parsed.method, parsed.params);
      response.setHeader("content-type", "application/json");
      if (!outcome) {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id }));
        return;
      }
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          ...(outcome.error
            ? { error: outcome.error }
            : { result: outcome.result }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}`, calls };
}

function readyHandler(lamports: unknown): RpcHandler {
  return (method) =>
    method === "getBalance" ? { result: balanceResult(lamports) } : undefined;
}

describe("RpcBalanceReader (WP-006/WP-007)", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("reads lamports from one getBalance call for the requested address", async () => {
    const { server, url, calls } = await startRpc(readyHandler(1_000_000_000));
    servers.push(server);
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).resolves.toBe("1000000000");
    expect(calls).toEqual([{ method: "getBalance", params: [ADDRESS] }]);
    expect(calls[0]?.params[0]).not.toContain("0x");
  });

  it("serializes the largest exactly-representable lamport value and a real zero", async () => {
    const { server, url } = await startRpc(readyHandler(MAX_EXACT_LAMPORTS));
    servers.push(server);
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).resolves.toBe("9007199254740991");

    const zero = await startRpc(readyHandler(0));
    servers.push(zero.server);
    const zeroReader = new RpcBalanceReader(zero.url);
    await expect(
      zeroReader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).resolves.toBe("0");
  });

  it("rejects a lamport count that a JSON number cannot represent exactly", async () => {
    // 2^53 is already lossy: truncating it would silently report a wrong balance.
    const { server, url } = await startRpc(readyHandler(MAX_EXACT_LAMPORTS + 1));
    servers.push(server);
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/formato/);
  });

  it("rejects a non-integer or negative lamport count", async () => {
    for (const value of [1.5, -1, "1000", null]) {
      const { server, url } = await startRpc(readyHandler(value));
      servers.push(server);
      const reader = new RpcBalanceReader(url);
      await expect(
        reader.readSolAtomic(ADDRESS, new AbortController().signal),
      ).rejects.toThrow(/formato/);
    }
  });

  it("rejects a JSON-RPC error response", async () => {
    const { server, url } = await startRpc(() => ({
      error: { code: -32000, message: "boom" },
    }));
    servers.push(server);
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/rechazó/);
  });

  it("rejects a mismatched correlation id", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 999,
          result: balanceResult(1),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/no es válida/);
  });

  it("rejects a result that is not a getBalance envelope", async () => {
    const { server, url } = await startRpc(() => ({ result: "0xzz" }));
    servers.push(server);
    const reader = new RpcBalanceReader(url);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/formato/);
  });

  it("fails on an unreachable node", async () => {
    const reader = new RpcBalanceReader("http://127.0.0.1:1", fetch, 500);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/No pudimos consultar el saldo/);
  });

  it("aborts the whole operation when the shared deadline expires", async () => {
    const server = createServer((_request, response) => {
      // Never respond; force the deadline to fire.
      const timer = setTimeout(() => response.end("late"), 2_000);
      timer.unref();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const reader = new RpcBalanceReader(url, fetch, 50);
    await expect(
      reader.readSolAtomic(ADDRESS, new AbortController().signal),
    ).rejects.toThrow(/tardó demasiado/);
  });

  it("honors an externally aborted signal", async () => {
    const server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const reader = new RpcBalanceReader(url, fetch, 10_000);
    const controller = new AbortController();
    const pending = reader.readSolAtomic(ADDRESS, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/tardó demasiado/);
  });
});
