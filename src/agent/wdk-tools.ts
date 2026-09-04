import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { createWdkToolsFixture } from './wdk-tools.fixture.js';
import { decodeMcpText, WdkMcpClient } from '../wdk/mcp-client.js';

let client: WdkMcpClient | undefined;
let clientOpening: Promise<WdkMcpClient> | undefined;
let fixtureTools: Record<string, Tool> | undefined;
type LiveWdkClient = Pick<WdkMcpClient, 'sendToken'>;

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
  if (client) return client;
  if (!clientOpening) {
    const opening = openLiveClient();
    clientOpening = opening;
    void opening.then(
      () => { if (clientOpening === opening) clientOpening = undefined; },
      () => { if (clientOpening === opening) clientOpening = undefined; },
    );
  }
  return clientOpening;
}

async function openLiveClient(): Promise<WdkMcpClient> {
  const candidate = createLiveWdkClient();
  try {
    await candidate.open();
    await candidate.discover();
    client = candidate;
    return candidate;
  } catch (error) {
    await candidate.close();
    throw error;
  }
}

export function createLiveWdkClient(
  environment: NodeJS.ProcessEnv = process.env,
): WdkMcpClient {
  const indexerApiKey = environment.WDK_INDEXER_API_KEY;
  return new WdkMcpClient({
    environment,
    explicitWdkEnvironment: indexerApiKey
      ? { WDK_INDEXER_API_KEY: indexerApiKey }
      : {},
  });
}

async function callLive(name: string, input: Record<string, unknown>): Promise<unknown> {
  const activeClient = await ensureLiveClient();
  try {
    return decodeMcpText(await activeClient.call(name, input));
  } catch (error) {
    if (client === activeClient) {
      await activeClient.close();
      client = undefined;
    }
    throw error;
  }
}

const walletSchema = z.object({ network: z.string(), wallet: z.string().optional(), index: z.number().int().nonnegative().optional() });
const tokenSchema = walletSchema.extend({ token: z.string().optional() });
const sendSchema = z.object({
  network: z.literal('sepolia'),
  token: z.string().trim().min(1),
  to: z.string().min(1),
  amount: z.string().min(1),
  wallet: z.string(),
  dryRun: z.boolean(),
});

export function createLiveTools(
  clientProvider: () => Promise<LiveWdkClient> = ensureLiveClient,
): Record<string, Tool> {
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
          const evidence = await (await clientProvider()).sendToken({
            network: input.network,
            token: input.token,
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
  await clientOpening?.catch(() => undefined);
  await client?.close();
  client = undefined;
  clientOpening = undefined;
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
