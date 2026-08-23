import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { createWdkToolsFixture } from './wdk-tools.fixture.js';
import { decodeMcpText, WdkMcpClient } from '../wdk/mcp-client.js';

let client: WdkMcpClient | undefined;
let fixtureTools: Record<string, Tool> | undefined;

function isFixtureMode(): boolean {
  return process.env.WDK_TOOLS_SOURCE !== 'live';
}

export async function getWdkTools(): Promise<Record<string, Tool>> {
  if (isFixtureMode()) {
    fixtureTools ??= createWdkToolsFixture();
    return fixtureTools;
  }

  await ensureLiveClient();
  return createLiveTools();
}

async function ensureLiveClient(): Promise<WdkMcpClient> {
  if (!client) {
    client = new WdkMcpClient();
    try {
      await client.open();
      await client.discover();
    } catch (error) {
      await client.close();
      client = undefined;
      throw error;
    }
  }
  return client;
}

async function callLive(name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    return decodeMcpText(await (await ensureLiveClient()).call(name, input));
  } catch (error) {
    await client?.close();
    client = undefined;
    throw error;
  }
}

const walletSchema = z.object({ network: z.string(), wallet: z.string().optional(), index: z.number().int().nonnegative().optional() });
const tokenSchema = walletSchema.extend({ token: z.string().optional() });
const sendSchema = z.object({
  network: z.literal('sepolia'),
  token: z.string(),
  to: z.string().min(1),
  amount: z.string().min(1),
  wallet: z.string(),
  dryRun: z.boolean(),
});

function createLiveTools(): Record<string, Tool> {
  return {
    get_networks: tool({ description: 'List configured networks.', inputSchema: z.object({ testnet: z.boolean().optional() }), execute: (input) => callLive('get_networks', input) }),
    list_tokens: tool({ description: 'List registered tokens.', inputSchema: z.object({ network: z.string().optional() }), execute: (input) => callLive('list_tokens', input) }),
    get_token: tool({ description: 'Resolve token configuration.', inputSchema: z.object({ network: z.string(), token: z.string() }), execute: (input) => callLive('get_token', input) }),
    get_address: tool({ description: 'Read the wallet address.', inputSchema: walletSchema, execute: (input) => callLive('get_address', input) }),
    get_balance: tool({ description: 'Read native or token balances.', inputSchema: tokenSchema, execute: (input) => callLive('get_balance', input) }),
    get_history: tool({ description: 'Read transfer history.', inputSchema: tokenSchema, execute: (input) => callLive('get_history', input) }),
    send_token: tool({
      description: 'Preview or execute a Sepolia USD₮ transfer.',
      inputSchema: sendSchema,
      execute: async (input) => {
        try {
          const evidence = await (await ensureLiveClient()).sendToken({
            network: input.network,
            token: input.token.toLowerCase(),
            to: input.to,
            amount: input.amount,
            wallet: input.wallet,
            dryRun: input.dryRun,
          } as Parameters<WdkMcpClient['sendToken']>[0]);
          if (evidence.failure) throw new Error(evidence.failure.error);
          return decodeMcpText(evidence.raw);
        } catch (error) {
          await client?.close();
          client = undefined;
          throw error;
        }
      },
    }),
  };
}

export async function closeWdkClient(): Promise<void> {
  await client?.close();
  client = undefined;
  fixtureTools = undefined;
}

/**
 * Calls a WDK tool directly, bypassing the LLM — used by the wallet read
 * endpoints (GET /v1/wallet/*) which don't need a conversational agent.
 */
export async function callWdkTool(name: string, input: unknown): Promise<unknown> {
  const tools = await getWdkTools();
  const target = tools[name];
  if (!target?.execute) {
    throw new Error(`WDK tool "${name}" is not available.`);
  }
  return target.execute(input as never, {
    toolCallId: `direct-${name}`,
    messages: [],
    abortSignal: new AbortController().signal,
  } as never);
}
