import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../contracts/http.js';
import type { WalletProvider } from '../wallet/provider.js';

const NETWORK = process.env.WDK_NETWORK ?? 'sepolia';
const WALLET = process.env.WDK_WALLET_NAME ?? 'agent-demo';
const MODE = process.env.WDK_TOOLS_SOURCE === 'live' ? 'live' : 'fixture';

export async function registerHealthRoutes(app: FastifyInstance, dependencies: { wallet: WalletProvider }): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    let mcp: HealthResponse['mcp'] = 'unknown';
    let wallet: HealthResponse['wallet'] = 'unknown';

    try {
      await dependencies.wallet.listNetworks();
      mcp = 'connected';
    } catch {
      mcp = 'disconnected';
    }

    if (mcp === 'connected') {
      try {
        await dependencies.wallet.getAddress({ network: NETWORK, wallet: WALLET });
        wallet = 'unlocked';
      } catch {
        wallet = 'locked';
      }
    }

    return { status: 'ok', mode: MODE, mcp, wallet, network: NETWORK };
  });
}
