import { classifyHistory, sanitizeForEvidence, type WdkMcpClient } from './mcp-client.js';

export type WalletReadContext = {
  network: 'sepolia';
  token: string;
  index?: number;
  wallet?: string;
};

export type WalletReadEvidence = {
  schemaVersion: 'wdk-evidence/v1';
  context: WalletReadContext;
  address: unknown;
  balance: unknown;
  history: unknown;
  historyState: 'unavailable' | 'stale' | 'empty' | 'non-empty';
};

export async function readWalletFacts(
  client: WdkMcpClient,
  context: WalletReadContext
): Promise<WalletReadEvidence> {
  const common = { network: context.network, index: context.index ?? 0, wallet: context.wallet };
  const address = await client.call('get_address', common);
  const balance = await client.call('get_balance', { ...common, token: context.token });
  let history: unknown;
  try {
    history = await client.call('get_history', { ...common, token: context.token });
  } catch (error) {
    history = { unavailable: true, error: error instanceof Error ? error.message : String(error) };
  }
  const sanitizedHistory = sanitizeForEvidence(history);

  return {
    schemaVersion: 'wdk-evidence/v1',
    context: sanitizeForEvidence(context) as WalletReadContext,
    address: sanitizeForEvidence(address),
    balance: sanitizeForEvidence(balance),
    history: sanitizedHistory,
    historyState: classifyHistory(sanitizedHistory)
  };
}
