import type { FastifyInstance, FastifyRequest } from 'fastify';
import { callWdkTool } from '../agent/wdk-tools.js';
import {
  walletBalanceQuerySchema,
  walletHistoryQuerySchema,
  type WalletAddressResponse,
  type WalletBalanceResponse,
  type WalletHistoryResponse,
} from '../contracts/http.js';

const NETWORK = process.env.WDK_NETWORK ?? 'sepolia';
const WALLET = process.env.WDK_WALLET_NAME ?? 'agent-demo';

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/wallet/address', async (): Promise<WalletAddressResponse> => {
    return callWdkTool('get_address', {
      network: NETWORK,
      wallet: WALLET,
    }) as Promise<WalletAddressResponse>;
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
      return callWdkTool('get_balance', {
        ...parsed.data,
        wallet: WALLET,
      }) as Promise<WalletBalanceResponse>;
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
      return callWdkTool('get_history', {
        ...parsed.data,
        wallet: WALLET,
      }) as Promise<WalletHistoryResponse>;
    },
  );
}
