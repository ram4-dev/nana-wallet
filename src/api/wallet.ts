import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WalletProvider } from '../wallet/provider.js';
import {
  walletBalanceQuerySchema,
  walletBalanceResponseSchema,
  walletHistoryQuerySchema,
  walletHistoryResponseSchema,
  type WalletAddressResponse,
  type WalletBalanceResponse,
  type WalletHistoryResponse,
  type WalletTransaction,
} from '../contracts/http.js';

const NETWORK = process.env.WDK_NETWORK ?? 'sepolia';
const WALLET = process.env.WDK_WALLET_NAME ?? 'agent-demo';

export function normalizeWalletBalance(
  rawAddress: unknown,
  rawBalance: unknown,
  requestedToken?: string,
): WalletBalanceResponse {
  const address = asRecord(rawAddress, 'WDK address');
  const balance = asRecord(rawBalance, 'WDK balance');
  const currentBalance = walletBalanceResponseSchema.safeParse(rawBalance);
  const network = requiredString(balance.network ?? address.network, 'WDK balance network');

  if (
    typeof address.network === 'string' &&
    address.network !== network
  ) {
    throw new Error('WDK address and balance networks do not match.');
  }

  return walletBalanceResponseSchema.parse({
    network,
    ...(requestedToken
      ? { token: requestedToken }
      : typeof balance.token === 'string'
        ? { token: balance.token }
        : {}),
    address: requiredString(address.address, 'WDK wallet address'),
    balance: currentBalance.success
      ? currentBalance.data.balance
      : normalizeBaseUnits(
          requiredString(balance.balance, 'WDK wallet balance'),
          balance.decimals,
          'WDK wallet balance',
        ),
  });
}

export function normalizeWalletHistory(
  rawHistory: unknown,
  requestedToken?: string,
): WalletHistoryResponse {
  const current = walletHistoryResponseSchema.safeParse(rawHistory);
  if (current.success) return current.data;

  const history = asRecord(rawHistory, 'WDK history');
  const network = requiredString(history.network, 'WDK history network');
  const address = requiredString(history.address, 'WDK history address');
  if (!Array.isArray(history.transfers)) {
    throw new Error('WDK history transfers are missing.');
  }

  const transactions = history.transfers.map((rawTransfer, index) =>
    normalizeHistoryTransfer(rawTransfer, address, index, requestedToken)
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
  const from = stringField(transfer.from, `WDK history transfer ${index} sender`);
  const to = stringField(transfer.to, `WDK history transfer ${index} recipient`);
  const wallet = walletAddress.toLocaleLowerCase('en-US');
  const sent = from.toLocaleLowerCase('en-US') === wallet;
  const received = to.toLocaleLowerCase('en-US') === wallet;
  if (!sent && !received) {
    throw new Error(`WDK history transfer ${index} does not involve the queried wallet.`);
  }

  return {
    hash: requiredString(transfer.transactionHash, `WDK history transfer ${index} hash`),
    direction: sent ? 'out' : 'in',
    counterparty: sent ? to : from,
    amount: normalizeBaseUnits(
      requiredString(transfer.amount, `WDK history transfer ${index} amount`),
      transfer.decimals,
      `WDK history transfer ${index} amount`,
    ),
    token: requestedToken ?? requiredString(transfer.token, `WDK history transfer ${index} token`),
    timestamp: normalizeTimestamp(transfer.timestamp, index),
  };
}

function normalizeBaseUnits(amount: string, decimals: unknown, label: string): string {
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw new Error(`${label} decimals are missing or invalid; base units cannot be normalized.`);
  }
  if (!/^\d+$/.test(amount)) {
    throw new Error(`${label} is not an unsigned base-unit integer.`);
  }

  const decimalPlaces = decimals as number;
  const digits = amount.replace(/^0+(?=\d)/, '');
  if (decimalPlaces === 0) return digits;

  const padded = digits.padStart(decimalPlaces + 1, '0');
  const whole = padded.slice(0, -decimalPlaces);
  const fraction = padded.slice(-decimalPlaces).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function normalizeTimestamp(value: unknown, index: number): string {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? (Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric)
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

export async function registerWalletRoutes(app: FastifyInstance, dependencies: { wallet: WalletProvider }): Promise<void> {
  app.get('/v1/wallet/address', async (): Promise<WalletAddressResponse> => {
    return dependencies.wallet.getAddress({
      network: NETWORK,
      wallet: WALLET,
    });
  });

  app.get(
    '/v1/wallet/balance',
    async (
      request: FastifyRequest<{ Querystring: { network?: string; token?: string } }>,
      reply,
    ): Promise<WalletBalanceResponse | void> => {
      const parsed = walletBalanceQuerySchema.safeParse({
        network: request.query.network ?? NETWORK,
        token: request.query.token,
      });
      if (!parsed.success) {
        reply.code(400);
        return reply.send({ status: 'error', message: parsed.error.message, code: 'invalid_query' });
      }
      const toolInput = {
        ...parsed.data,
        wallet: WALLET,
      };
      const address = await dependencies.wallet.getAddress({
        network: parsed.data.network,
        wallet: WALLET,
      });
      const balance = await dependencies.wallet.getBalance(toolInput);
      return normalizeWalletBalance(address, balance, parsed.data.token);
    },
  );

  app.get(
    '/v1/wallet/history',
    async (
      request: FastifyRequest<{ Querystring: { network?: string; token?: string } }>,
      reply,
    ): Promise<WalletHistoryResponse | void> => {
      const parsed = walletHistoryQuerySchema.safeParse({
        network: request.query.network ?? NETWORK,
        token: request.query.token,
      });
      if (!parsed.success) {
        reply.code(400);
        return reply.send({ status: 'error', message: parsed.error.message, code: 'invalid_query' });
      }
      const history = await dependencies.wallet.getHistory({
        ...parsed.data,
        wallet: WALLET,
      });
      return normalizeWalletHistory(history, parsed.data.token);
    },
  );
}
