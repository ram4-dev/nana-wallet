import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from 'ai';
import { createWdkToolsFixture } from './wdk-tools.fixture.js';

type WdkMcpClient = Awaited<ReturnType<typeof createMCPClient>>;

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

  client ??= await createMCPClient({
    transport: new StdioClientTransport({ command: 'wdk-mcp', args: [] }),
  });
  return client.tools();
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
