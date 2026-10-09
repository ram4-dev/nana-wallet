import type { Tool } from 'ai';
import { createWdkToolsFixture } from './wdk-tools.fixture.js';

let fixtureTools: Record<string, Tool> | undefined;

/**
 * Returns the WDK tool source.
 *
 * The live WDK MCP read client and the switch that selected it are gone:
 * production serves the per-user Privy Solana path, so the fixture tool source
 * below is the only one and `getWdkTools()` returns it unconditionally.
 */
export async function getWdkTools(): Promise<Record<string, Tool>> {
  fixtureTools ??= createWdkToolsFixture();
  return fixtureTools;
}

/**
 * Drops the memoized tool source so the next `getWdkTools()` rebuilds it.
 * The live client teardown that used to live here went with the live path.
 */
export async function closeWdkClient(): Promise<void> {
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
