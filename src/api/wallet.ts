import type { FastifyInstance, FastifyRequest } from "fastify";
import { getWalletAgentConfig } from "../agent/instructions.js";
import type { WalletProvider } from "../wallet/provider.js";
import {
  PrivyWalletRuntimeError,
  walletChainFamilyForNetwork,
  type WalletForUser,
} from "../wallet/privy-user-provider.js";
import {
  walletBalanceQuerySchema,
  walletBalanceResponseSchema,
  walletHistoryQuerySchema,
  walletHistoryResponseSchema,
  type WalletAddressResponse,
  type WalletBalanceResponse,
  type WalletHistoryResponse,
  type WalletTransaction,
} from "../contracts/http.js";

// Solana devnet and privy-user are the only network and wallet name the product
// serves. Read lazily for the same reason the health route does: module-level
// constants froze the ambient .env at import time.
const NETWORK = () => process.env.WDK_NETWORK ?? "solana-devnet";
const WALLET = () => process.env.WDK_WALLET_NAME ?? "privy-user";

export function normalizeWalletBalance(
  rawAddress: unknown,
  rawBalance: unknown,
  requestedToken?: string,
): WalletBalanceResponse {
  const address = asRecord(rawAddress, "WDK address");
  const balance = asRecord(rawBalance, "WDK balance");
  const currentBalance = walletBalanceResponseSchema.safeParse(rawBalance);
  const network = requiredString(
    balance.network ?? address.network,
    "WDK balance network",
  );

  if (typeof address.network === "string" && address.network !== network) {
    throw new Error("WDK address and balance networks do not match.");
  }

  return walletBalanceResponseSchema.parse({
    network,
    ...(requestedToken
      ? { token: requestedToken }
      : typeof balance.token === "string"
        ? { token: balance.token }
        : {}),
    address: requiredString(address.address, "WDK wallet address"),
    balance: currentBalance.success
      ? currentBalance.data.balance
      : normalizeBaseUnits(
          requiredString(balance.balance, "WDK wallet balance"),
          balance.decimals,
          "WDK wallet balance",
        ),
  });
}

export function normalizeWalletHistory(
  rawHistory: unknown,
  requestedToken?: string,
): WalletHistoryResponse {
  const current = walletHistoryResponseSchema.safeParse(rawHistory);
  if (current.success) return current.data;

  const history = asRecord(rawHistory, "WDK history");
  const network = requiredString(history.network, "WDK history network");
  const address = requiredString(history.address, "WDK history address");
  if (!Array.isArray(history.transfers)) {
    throw new Error("WDK history transfers are missing.");
  }

  const transactions = history.transfers.map((rawTransfer, index) =>
    normalizeHistoryTransfer(rawTransfer, address, index, requestedToken),
  );

  return walletHistoryResponseSchema.parse({ network, transactions });
}

function normalizeHistoryTransfer(
  rawTransfer: unknown,
  walletAddress: string,
  index: number,
  requestedToken?: string,
): WalletTransaction {
  const transfer = asRecord(rawTransfer, `WDK history transfer ${index}`);
  const from = stringField(
    transfer.from,
    `WDK history transfer ${index} sender`,
  );
  const to = stringField(
    transfer.to,
    `WDK history transfer ${index} recipient`,
  );
  const wallet = walletAddress.toLocaleLowerCase("en-US");
  const sent = from.toLocaleLowerCase("en-US") === wallet;
  const received = to.toLocaleLowerCase("en-US") === wallet;
  if (!sent && !received) {
    throw new Error(
      `WDK history transfer ${index} does not involve the queried wallet.`,
    );
  }

  return {
    hash: requiredString(
      transfer.transactionHash,
      `WDK history transfer ${index} hash`,
    ),
    direction: sent ? "out" : "in",
    counterparty: sent ? to : from,
    amount: normalizeBaseUnits(
      requiredString(transfer.amount, `WDK history transfer ${index} amount`),
      transfer.decimals,
      `WDK history transfer ${index} amount`,
    ),
    token:
      requestedToken ??
      requiredString(transfer.token, `WDK history transfer ${index} token`),
    timestamp: normalizeTimestamp(transfer.timestamp, index),
  };
}

function normalizeBaseUnits(
  amount: string,
  decimals: unknown,
  label: string,
): string {
  if (
    !Number.isInteger(decimals) ||
    (decimals as number) < 0 ||
    (decimals as number) > 255
  ) {
    throw new Error(
      `${label} decimals are missing or invalid; base units cannot be normalized.`,
    );
  }
  if (!/^\d+$/.test(amount)) {
    throw new Error(`${label} is not an unsigned base-unit integer.`);
  }

  const decimalPlaces = decimals as number;
  const digits = amount.replace(/^0+(?=\d)/, "");
  if (decimalPlaces === 0) return digits;

  const padded = digits.padStart(decimalPlaces + 1, "0");
  const whole = padded.slice(0, -decimalPlaces);
  const fraction = padded.slice(-decimalPlaces).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function normalizeTimestamp(value: unknown, index: number): string {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? Math.abs(numeric) < 1_000_000_000_000
        ? numeric * 1_000
        : numeric
      : Date.parse(value);
  } else {
    milliseconds = Number.NaN;
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`WDK history transfer ${index} timestamp is invalid.`);
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`WDK history transfer ${index} timestamp is invalid.`);
  }
  return date.toISOString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

export async function registerWalletRoutes(
  app: FastifyInstance,
  dependencies: {
    wallet: WalletProvider;
    walletForUser?: WalletForUser;
    resolveUserId?: (request: FastifyRequest) => Promise<string>;
  },
): Promise<void> {
  const resolveWallet = async (
    request: FastifyRequest,
    network: string,
  ): Promise<{ provider: WalletProvider; wallet: string }> => {
    if (!dependencies.resolveUserId) {
      return { provider: dependencies.wallet, wallet: WALLET() };
    }
    const userId = await dependencies.resolveUserId(request);
    return {
      provider: dependencies.walletForUser
        ? await dependencies.walletForUser(
            userId,
            walletChainFamilyForNetwork(network),
          )
        : dependencies.wallet,
      wallet: dependencies.walletForUser ? userId : WALLET(),
    };
  };
  const defaultNetwork = dependencies.walletForUser
    ? getWalletAgentConfig().network
    : NETWORK();
  app.get(
    "/v1/wallet/address",
    async (
      request: FastifyRequest<{ Querystring: { network?: string } }>,
      reply,
    ): Promise<WalletAddressResponse | void> => {
      try {
        const network = request.query.network ?? defaultNetwork;
        const resolved = await resolveWallet(request, network);
        return resolved.provider.getAddress({
          network,
          wallet: resolved.wallet,
        });
      } catch (error) {
        return sendWalletRuntimeError(reply, error);
      }
    },
  );

  app.get(
    "/v1/wallet/balance",
    async (
      request: FastifyRequest<{
        Querystring: { network?: string; token?: string };
      }>,
      reply,
    ): Promise<WalletBalanceResponse | void> => {
      const parsed = walletBalanceQuerySchema.safeParse({
        network: request.query.network ?? defaultNetwork,
        token: request.query.token,
      });
      if (!parsed.success) {
        reply.code(400);
        return reply.send({
          status: "error",
          message: parsed.error.message,
          code: "invalid_query",
        });
      }
      try {
        const resolved = await resolveWallet(request, parsed.data.network);
        const toolInput = { ...parsed.data, wallet: resolved.wallet };
        const address = await resolved.provider.getAddress({
          network: parsed.data.network,
          wallet: resolved.wallet,
        });
        const balance = await resolved.provider.getBalance(toolInput);
        return normalizeWalletBalance(address, balance, parsed.data.token);
      } catch (error) {
        return sendWalletRuntimeError(reply, error);
      }
    },
  );

  app.get(
    "/v1/wallet/history",
    async (
      request: FastifyRequest<{
        Querystring: { network?: string; token?: string };
      }>,
      reply,
    ): Promise<WalletHistoryResponse | void> => {
      const parsed = walletHistoryQuerySchema.safeParse({
        network: request.query.network ?? defaultNetwork,
        token: request.query.token,
      });
      if (!parsed.success) {
        reply.code(400);
        return reply.send({
          status: "error",
          message: parsed.error.message,
          code: "invalid_query",
        });
      }
      try {
        const resolved = await resolveWallet(request, parsed.data.network);
        const history = await resolved.provider.getHistory({
          ...parsed.data,
          wallet: resolved.wallet,
        });
        return normalizeWalletHistory(history, parsed.data.token);
      } catch (error) {
        return sendWalletRuntimeError(reply, error);
      }
    },
  );
}

function sendWalletRuntimeError(
  reply: { code(statusCode: number): unknown; send(payload: unknown): unknown },
  error: unknown,
): void {
  if (!(error instanceof PrivyWalletRuntimeError)) throw error;
  const statusCode =
    error.code === "wallet_not_ready"
      ? 409
      : error.code === "wallet_feature_unavailable"
        ? 501
        : 503;
  reply.code(statusCode);
  reply.send({
    status: "error",
    code: error.code,
    message: error.message,
  });
}
