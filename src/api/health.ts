import type { FastifyInstance } from 'fastify';
import { callWdkTool } from '../agent/wdk-tools.js';
import type { HealthResponse } from '../contracts/http.js';

const NETWORK = process.env.WDK_NETWORK ?? 'sepolia';
const WALLET = process.env.WDK_WALLET_NAME ?? 'agent-demo';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    let mcp: HealthResponse['mcp'] = 'unknown';
    let wallet: HealthResponse['wallet'] = 'unknown';

    try {
      await callWdkTool('get_networks', {});
      mcp = 'connected';
    } catch {
      mcp = 'disconnected';
    }

    if (mcp === 'connected') {
      try {
        await callWdkTool('get_address', { network: NETWORK, wallet: WALLET });
        wallet = 'unlocked';
      } catch {
        wallet = 'locked';
      }
    }

    return { status: 'ok', mcp, wallet, network: NETWORK };
  });
}
