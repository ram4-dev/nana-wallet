import { tool, type Tool } from 'ai';
import { z } from 'zod';

const FIXTURE_ADDRESS = '0x1234000000000000000000000000000000abcd';
const FIXTURE_NETWORK = 'sepolia';
const FIXTURE_TOKEN = 'USDT';
const FIXTURE_BALANCE = '42.5';
const FIXTURE_FEE = '0.0003 ETH';

let fixtureTxCounter = 0;

export function createWdkToolsFixture(): Record<string, Tool> {
  return {
    get_networks: tool({
      description: 'List configured networks.',
      inputSchema: z.object({ kind: z.enum(['mainnet', 'testnet']).optional() }),
      execute: async () => [{ network: FIXTURE_NETWORK, kind: 'testnet' }],
    }),

    list_tokens: tool({
      description: 'List registered tokens.',
      inputSchema: z.object({ network: z.string().optional() }),
      execute: async () => [
        { network: FIXTURE_NETWORK, token: FIXTURE_TOKEN, decimals: 6 },
      ],
    }),

    get_token: tool({
      description: 'Resolve token configuration.',
      inputSchema: z.object({ network: z.string(), token: z.string() }),
      execute: async ({ network, token }) => ({ network, token, decimals: 6 }),
    }),

    get_address: tool({
      description: 'Read the wallet address.',
      inputSchema: z.object({ network: z.string(), wallet: z.string().optional() }),
      execute: async ({ network }) => ({ network, address: FIXTURE_ADDRESS }),
    }),

    get_balance: tool({
      description: 'Read native or token balances.',
      inputSchema: z.object({
        network: z.string(),
        token: z.string().optional(),
        wallet: z.string().optional(),
      }),
      execute: async ({ network, token }) => ({
        network,
        token: token ?? FIXTURE_TOKEN,
        address: FIXTURE_ADDRESS,
        balance: FIXTURE_BALANCE,
      }),
    }),

    get_history: tool({
      description: 'Read transfer history when the indexer is configured.',
      inputSchema: z.object({ network: z.string(), token: z.string().optional() }),
      execute: async ({ network }) => ({
        network,
        transactions: [
          {
            hash: '0xfixturehistory0000000000000000000000000000000000000000000001',
            direction: 'in' as const,
            counterparty: '0xsender00000000000000000000000000000000',
            amount: '5',
            token: FIXTURE_TOKEN,
            timestamp: new Date(Date.now() - 86_400_000).toISOString(),
          },
        ],
      }),
    }),

    send_token: tool({
      description: 'Preview or execute a native/token transfer.',
      inputSchema: z.object({
        network: z.string(),
        token: z.string(),
        to: z.string(),
        amount: z.string(),
        wallet: z.string(),
        dryRun: z.boolean(),
      }),
      execute: async ({ network, token, to, amount, dryRun }) => {
        if (dryRun) {
          return {
            network,
            token,
            recipient: to,
            amount,
            estimatedFee: FIXTURE_FEE,
          };
        }
        fixtureTxCounter += 1;
        const transactionHash = `0xfixturetx${String(fixtureTxCounter).padStart(54, '0')}`;
        return {
          network,
          transactionHash,
          explorerUrl: `https://sepolia.etherscan.io/tx/${transactionHash}`,
        };
      },
    }),
  };
}
