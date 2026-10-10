import { isValidSolanaAddress } from "../memory/address.js";
import type {
  BalancesData,
  WalletReadinessState,
} from "../contracts/http.js";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_NETWORK,
} from "./solana-devnet-provider.js";
import type { CurrentWallet } from "./embedded.js";

/**
 * Personal balance surface (WP-003..WP-009).
 *
 * This module is deliberately SEPARATE from signing: the service never receives
 * sync/permission/sign/broadcast methods, the reader interface is minimal
 * (`readSolAtomic`), and a ready-but-inconsistent binding fails closed with a
 * stable business error instead of falling back to a global wallet.
 */

/** 409: the ready binding itself is inconsistent (bad address/chain family). */
export const BALANCE_DATA_INVALID_CODE = "WALLET_DATOS_INVALIDOS";
/** 503: the balance could not be read (fixture miss, RPC error, timeout). */
export const BALANCE_UNAVAILABLE_CODE = "BALANCE_NO_DISPONIBLE";

export class WalletBalancesError extends Error {
  constructor(
    readonly status: 409 | 503,
    readonly code:
      | typeof BALANCE_DATA_INVALID_CODE
      | typeof BALANCE_UNAVAILABLE_CODE,
    message: string,
  ) {
    super(message);
    this.name = "WalletBalancesError";
  }
}

function dataInvalid(message: string): WalletBalancesError {
  return new WalletBalancesError(409, BALANCE_DATA_INVALID_CODE, message);
}

function balanceUnavailable(message: string): WalletBalancesError {
  return new WalletBalancesError(503, BALANCE_UNAVAILABLE_CODE, message);
}

/**
 * The closed Solana devnet native-SOL catalog. Not configurable from HTTP.
 *
 * A native asset has no token contract, so `contract` is the explicit `native`
 * sentinel (never an address) and `tokenId` is the CAIP-2 identifier of the
 * single chain this closed surface serves. The balance unit is the lamport
 * (nine decimals), not a six-decimal token amount.
 */
export const SOLANA_DEVNET_CATALOG = {
  network: SOLANA_DEVNET_NETWORK,
  caip2: SOLANA_DEVNET_CAIP2,
  networkName: "Solana devnet",
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  testnet: true,
  tokenId: SOLANA_DEVNET_CAIP2,
  contract: "native",
} as const;

/**
 * Minimal injected reader: one method, a lamport decimal string result, and no
 * signing.
 */
export interface BalanceReader {
  readonly source: "fixture" | "rpc";
  readSolAtomic(address: string, signal: AbortSignal): Promise<string>;
}

/**
 * Deterministic per-address fixture balances in lamports (WP-009). A missing
 * entry is an explicit error, never a silent zero. The map is provided only
 * when building the dependency graph; there is no HTTP surface to configure it.
 */
export class FixtureBalanceReader implements BalanceReader {
  readonly source = "fixture" as const;
  private readonly balances: ReadonlyMap<string, string>;

  constructor(balances: Record<string, string> = {}) {
    this.balances = new Map(
      Object.entries(balances).map(([address, atomic]) => [
        address.toLowerCase(),
        atomic,
      ]),
    );
  }

  async readSolAtomic(address: string, _signal: AbortSignal): Promise<string> {
    const value = this.balances.get(address.toLowerCase());
    if (value === undefined) {
      throw balanceUnavailable(
        "Todavía no tenemos un saldo de demostración para tu billetera.",
      );
    }
    return value;
  }
}

const RPC_DEADLINE_MS = 8_000;

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

/**
 * Read-only native-SOL balance adapter (WP-006/WP-007). It speaks Solana
 * JSON-RPC against the fixed devnet catalog — one `getBalance` call for the
 * validated own address, never a token or a selector — shares one 8-second
 * deadline across the call, and never retries.
 *
 * `getBalance` returns lamports as a JSON number. Only an exactly representable
 * non-negative integer is accepted: an unsafe integer (above 2^53 - 1) would be
 * silently truncated into a wrong balance, so it fails closed instead.
 */
export class RpcBalanceReader implements BalanceReader {
  readonly source = "rpc" as const;

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly deadlineMs = RPC_DEADLINE_MS,
  ) {
    if (!rpcUrl) {
      throw new Error(
        "BALANCE_RPC_URL is required for BALANCE_READ_SOURCE=rpc.",
      );
    }
  }

  private async call(
    method: string,
    params: unknown[],
    id: number,
    controller: AbortController,
  ): Promise<unknown> {
    let payload: unknown;
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw balanceUnavailable("La consulta del saldo tardó demasiado.");
      }
      throw balanceUnavailable(
        "No pudimos consultar el saldo en este momento.",
      );
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as JsonRpcResponse).jsonrpc !== "2.0" ||
      (payload as JsonRpcResponse).id !== id
    ) {
      throw balanceUnavailable("La respuesta del nodo no es válida.");
    }
    const rpcError = (payload as JsonRpcResponse).error;
    if (rpcError) {
      throw balanceUnavailable("El nodo rechazó la consulta del saldo.");
    }
    return (payload as JsonRpcResponse).result;
  }

  async readSolAtomic(
    address: string,
    externalSignal: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.deadlineMs);
    const forwardExternal = () => controller.abort();
    externalSignal.addEventListener("abort", forwardExternal, { once: true });
    try {
      const result = await this.call("getBalance", [address], 1, controller);
      // Solana answers getBalance with { context, value }; only the lamport
      // count is read, and only when it is an exact non-negative integer.
      const value =
        typeof result === "object" && result !== null
          ? (result as { value?: unknown }).value
          : undefined;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw balanceUnavailable(
          "La respuesta del nodo no tiene el formato esperado.",
        );
      }
      return BigInt(value).toString(10);
    } finally {
      clearTimeout(deadline);
      externalSignal.removeEventListener("abort", forwardExternal);
    }
  }
}

const NOT_READY_STATES: readonly Exclude<WalletReadinessState, "ready">[] = [
  "unprovisioned",
  "provisioning",
  "recovery_required",
  "conflict",
  "unavailable",
];

function isNotReadyState(
  state: WalletReadinessState,
): state is Exclude<WalletReadinessState, "ready"> {
  return (NOT_READY_STATES as readonly string[]).includes(state);
}

export type BalanceReadConfig = {
  source: "fixture" | "rpc";
  rpcUrl?: string;
  fixtureBalances?: Record<string, string>;
};

/**
 * Server-side configuration (WP-009). BALANCE_READ_SOURCE defaults to
 * `fixture`; `rpc` demands BALANCE_RPC_URL (it has no safe default: silently
 * pointing the balance read at an unconfigured node would hide a
 * misconfiguration). Values are never printed, and nothing here can be chosen
 * from a public HTTP surface: both the source and the RPC URL are read from the
 * process environment only.
 */
export function readBalanceReadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BalanceReadConfig {
  const source = environment.BALANCE_READ_SOURCE ?? "fixture";
  if (source !== "fixture" && source !== "rpc") {
    throw new Error("BALANCE_READ_SOURCE must be 'fixture' or 'rpc'.");
  }
  if (source === "rpc") {
    const rpcUrl = environment.BALANCE_RPC_URL;
    if (!rpcUrl) {
      throw new Error(
        "BALANCE_RPC_URL is required for BALANCE_READ_SOURCE=rpc.",
      );
    }
    return { source, rpcUrl };
  }
  let fixtureBalances: Record<string, string> | undefined;
  const raw = environment.BALANCE_FIXTURE_BALANCES;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        "BALANCE_FIXTURE_BALANCES must be a JSON object of address -> lamport balance.",
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        "BALANCE_FIXTURE_BALANCES must be a JSON object of address -> lamport balance.",
      );
    }
    fixtureBalances = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
  }
  return { source: "fixture", fixtureBalances };
}

export function createBalanceReader(config: BalanceReadConfig): BalanceReader {
  if (config.source === "rpc") {
    return new RpcBalanceReader(config.rpcUrl ?? "");
  }
  return new FixtureBalanceReader(config.fixtureBalances ?? {});
}

export type WalletBalancesServiceDependencies = {
  /** Own-binding resolution under RLS; the same service used by /v1/wallets. */
  resolveWallet: (userId: string) => Promise<CurrentWallet>;
  reader: BalanceReader;
  /** Injectable clock; observedAt is fixed only after a successful read. */
  clock?: () => Date;
};

/**
 * Read-only personal balances service (WP-003..WP-009). It resolves the
 * caller's OWN Solana wallet binding, serves exact non-ready states without
 * touching the reader, and hands the validated own address to an injected
 * reader. There is intentionally no way to select address, chain or token from
 * input, and no dependency on signing credentials or permission state.
 */
export class WalletBalancesService {
  constructor(
    private readonly dependencies: WalletBalancesServiceDependencies,
  ) {}

  async getBalances(
    userId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<BalancesData> {
    const wallet = await this.dependencies.resolveWallet(userId);

    if (isNotReadyState(wallet.state)) {
      // WP-005: exact state, no RPC call, no amount, no wallet creation.
      return {
        walletState: wallet.state,
        chainId: SOLANA_DEVNET_CATALOG.caip2,
        networkName: SOLANA_DEVNET_CATALOG.networkName,
        testnet: SOLANA_DEVNET_CATALOG.testnet,
        observedAt: null,
        assets: [],
      };
    }

    // WP-007: a ready binding must be coherent before any read is attempted.
    // The reader is Solana-only, so anything that is not a Solana address on
    // the solana chain family (an EVM/Arc binding, for instance) fails closed.
    if (
      wallet.chainFamily !== "solana" ||
      !isValidSolanaAddress(wallet.address)
    ) {
      throw dataInvalid(
        "Los datos de tu billetera no son válidos para consultar el saldo.",
      );
    }

    let balanceAtomic: string;
    try {
      balanceAtomic = await this.dependencies.reader.readSolAtomic(
        wallet.address,
        signal,
      );
    } catch (error) {
      if (error instanceof WalletBalancesError) throw error;
      // Sanitized: never forward raw provider payloads or URLs.
      throw balanceUnavailable(
        "No pudimos consultar el saldo en este momento.",
      );
    }

    // observedAt is fixed only when the read completed successfully.
    const observedAt = (
      this.dependencies.clock ?? (() => new Date())
    )().toISOString();
    return {
      walletState: "ready",
      address: wallet.address,
      chainId: SOLANA_DEVNET_CATALOG.caip2,
      networkName: SOLANA_DEVNET_CATALOG.networkName,
      testnet: SOLANA_DEVNET_CATALOG.testnet,
      source: this.dependencies.reader.source,
      observedAt,
      assets: [
        {
          tokenId: SOLANA_DEVNET_CATALOG.tokenId,
          contract: SOLANA_DEVNET_CATALOG.contract,
          symbol: SOLANA_DEVNET_CATALOG.symbol,
          name: SOLANA_DEVNET_CATALOG.name,
          decimals: SOLANA_DEVNET_CATALOG.decimals,
          balanceAtomic,
        },
      ],
    };
  }
}
