import {
  ARC_TESTNET_CHAIN_ID,
  USDC_ARC_TESTNET_CONTRACT,
  type BalancesData,
  type WalletReadinessState,
} from "../contracts/http.js";
import type { CurrentWallet } from "./embedded.js";

/**
 * Personal balance surface (WP-003..WP-009).
 *
 * This module is deliberately SEPARATE from signing: the service never receives
 * sync/permission/sign/broadcast methods, the reader interface is minimal
 * (`readUsdcAtomic`), and a ready-but-inconsistent binding fails closed with a
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

/** The closed Arc testnet USDC catalog. Not configurable from HTTP. */
export const USDC_ARC_TESTNET_CATALOG = {
  chainId: ARC_TESTNET_CHAIN_ID,
  networkName: "Arc testnet",
  testnet: true,
  contract: USDC_ARC_TESTNET_CONTRACT,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  tokenId: `${ARC_TESTNET_CHAIN_ID}:${USDC_ARC_TESTNET_CONTRACT}`,
} as const;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Minimal injected reader: one method, atomic string result, no signing. */
export interface BalanceReader {
  readonly source: "fixture" | "rpc";
  readUsdcAtomic(address: string, signal: AbortSignal): Promise<string>;
}

/**
 * Deterministic per-address fixture balances (WP-009). A missing entry is an
 * explicit error, never a silent zero. The map is provided only when building
 * the dependency graph; there is no HTTP surface to configure it.
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

  async readUsdcAtomic(address: string, _signal: AbortSignal): Promise<string> {
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
const ETH_DECIMALS_SELECTOR = "0x313ce567";
const ETH_BALANCE_OF_SELECTOR = "0x70a08231";
const ABI_WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

/**
 * Read-only ERC-20 USDC balance adapter (WP-006/WP-007). It speaks JSON-RPC
 * against the fixed Arc testnet catalog, validates chain id / decimals /
 * ABI word shapes, shares one 8-second deadline across the whole call
 * sequence, and never retries. It never calls eth_getBalance: Arc exposes
 * an 18-decimal native representation that MUST NOT be read as six-decimal
 * USDC.
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

  private async callWord(
    method: string,
    params: unknown[],
    id: number,
    controller: AbortController,
  ): Promise<bigint> {
    const result = await this.call(method, params, id, controller);
    if (!isHexQuantity(result) && !ABI_WORD_PATTERN.test(String(result))) {
      throw balanceUnavailable(
        "La respuesta del nodo no tiene el formato esperado.",
      );
    }
    return BigInt(String(result));
  }

  async readUsdcAtomic(
    address: string,
    externalSignal: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.deadlineMs);
    const forwardExternal = () => controller.abort();
    externalSignal.addEventListener("abort", forwardExternal, { once: true });
    try {
      const chainId = await this.callWord("eth_chainId", [], 1, controller);
      if (chainId !== BigInt(USDC_ARC_TESTNET_CATALOG.chainId)) {
        throw balanceUnavailable("El nodo no sirve la red Arc testnet.");
      }

      const decimals = await this.callWord(
        "eth_call",
        [
          {
            to: USDC_ARC_TESTNET_CATALOG.contract,
            data: ETH_DECIMALS_SELECTOR,
          },
          "latest",
        ],
        2,
        controller,
      );
      if (decimals !== BigInt(USDC_ARC_TESTNET_CATALOG.decimals)) {
        throw balanceUnavailable("El token no tiene las unidades esperadas.");
      }

      const callData = `${ETH_BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`;
      const balance = await this.callWord(
        "eth_call",
        [{ to: USDC_ARC_TESTNET_CATALOG.contract, data: callData }, "latest"],
        3,
        controller,
      );
      if (balance < 0n || balance > (1n << 256n) - 1n) {
        throw balanceUnavailable(
          "La respuesta del nodo no tiene el formato esperado.",
        );
      }
      return balance.toString(10);
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
 * `fixture`; `rpc` demands BALANCE_RPC_URL. Values are never printed, and
 * nothing here can be chosen from a public HTTP surface: both the source and
 * the RPC URL are read from the process environment only.
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
        "BALANCE_FIXTURE_BALANCES must be a JSON object of address -> atomic balance.",
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        "BALANCE_FIXTURE_BALANCES must be a JSON object of address -> atomic balance.",
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
 * caller's OWN wallet binding, serves exact non-ready states without touching
 * the reader, and hands the validated own address to an injected reader.
 * There is intentionally no way to select address, chain or token from input,
 * and no dependency on signing credentials or permission state.
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
        chainId: USDC_ARC_TESTNET_CATALOG.chainId,
        networkName: USDC_ARC_TESTNET_CATALOG.networkName,
        testnet: USDC_ARC_TESTNET_CATALOG.testnet,
        observedAt: null,
        assets: [],
      };
    }

    // WP-007: a ready binding must be coherent before any read is attempted.
    if (
      wallet.chainFamily !== "arc" ||
      !EVM_ADDRESS_PATTERN.test(wallet.address)
    ) {
      throw dataInvalid(
        "Los datos de tu billetera no son válidos para consultar el saldo.",
      );
    }

    let balanceAtomic: string;
    try {
      balanceAtomic = await this.dependencies.reader.readUsdcAtomic(
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
      chainId: USDC_ARC_TESTNET_CATALOG.chainId,
      networkName: USDC_ARC_TESTNET_CATALOG.networkName,
      testnet: USDC_ARC_TESTNET_CATALOG.testnet,
      source: this.dependencies.reader.source,
      observedAt,
      assets: [
        {
          tokenId: USDC_ARC_TESTNET_CATALOG.tokenId,
          contract: USDC_ARC_TESTNET_CATALOG.contract,
          symbol: USDC_ARC_TESTNET_CATALOG.symbol,
          name: USDC_ARC_TESTNET_CATALOG.name,
          decimals: USDC_ARC_TESTNET_CATALOG.decimals,
          balanceAtomic,
        },
      ],
    };
  }
}
