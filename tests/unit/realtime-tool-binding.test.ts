import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRealtimeFixtureStack,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_USER_ID,
  MAMA_ADDRESS,
  MAMA_RECIPIENT_ID,
  MAMA_RECIPIENT_VERSION,
} from '../../evals/voice/realtime/eval-fixtures.js';
import { createRealtimeToolBinding } from '../../evals/voice/realtime/tool-binding.js';
import type { WalletProvider } from '../../src/wallet/provider.js';
import { createVoiceDecisionGate } from '../../src/livekit/voice-decision-gate.js';
import { isCancellation, isConfirmation } from '../../src/livekit/resolution-phrases.js';

const envBackup = new Map<string, string | undefined>();
// These fixture cases are not about transfer policy. `undefined` means "delete",
// so a stale ambient WDK_TOOLS_SOURCE cannot leak into the suite.
//
// The stack below is the demo-legacy EVM fixture world: its contact book holds
// EVM addresses and it targets the sepolia/USDT fixture provider explicitly, so
// it names the identity it runs in instead of inheriting whatever the agent
// config resolves by default (now the Solana triple, which cannot validate an
// EVM contact and would fail the confirm seam closed). Moving this stack to the
// Solana world is the demo-removal unit's job, not this pin's.
const EVAL_ENV: Record<string, string | undefined> = {
  IDENTITY_PROVIDER: 'demo',
  WDK_TOOLS_SOURCE: undefined,
  WDK_WALLET_NAME: 'agent-demo',
  WDK_NETWORK: 'sepolia',
  WDK_TOKEN: 'USDT',
};

beforeEach(() => {
  for (const [key, value] of Object.entries(EVAL_ENV)) {
    envBackup.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function call(name: string, args: Record<string, unknown>, callId = `call_${name}`) {
  return { name, callId, arguments: JSON.stringify(args) };
}

describe('realtime tool binding — declaration', () => {
  it('declares exactly the 5 production tools with JSON Schema parameters', () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const names = binding.tools.map((t) => t.name).sort();
    // Unified surface: voice exposes the shared definition tools (parity)
    // plus the voice-only spoken-decision gate tools.
    expect(names).toEqual([
      'cancel_transfer',
      'confirm_transfer',
      'create_grant',
      'get_address',
      'get_balance',
      'get_history',
      'get_networks',
      'get_selected_recipient_address',
      'list_tokens',
      'search_recipients',
      'search_user_memory',
      'send_token',
      'stage_user_memory',
      'write_user_memory',
    ]);
    for (const tool of binding.tools) {
      expect(tool.type).toBe('function');
      expect(tool.parameters).toBeTypeOf('object');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe('realtime tool binding — strict schema is a real boundary', () => {
  it('rejects a send_token with an invented dryRun flag (schema strict, never executed)', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(
      call('send_token', {
        amount: '50',
        recipientId: MAMA_RECIPIENT_ID,
        recipientVersion: MAMA_RECIPIENT_VERSION,
        to: '0xsecret-not-allowed',
      }),
    );
    const parsed = JSON.parse(output.output) as { error?: string };
    expect(parsed.error).toBe('invalid_arguments');
    // The tool must never have executed.
    expect(binding.calls).toHaveLength(0);
  });

  it('rejects a send_token with a free-form to address instead of recipientId', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(
      call('send_token', {
        amount: '50',
        to: MAMA_ADDRESS,
      }),
    );
    const parsed = JSON.parse(output.output) as { error?: string };
    expect(parsed.error).toBe('invalid_arguments');
    expect(binding.calls).toHaveLength(0);
  });

  it('rejects unknown tools and invalid JSON args', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const unknownTool = await binding.executeFunctionCall(call('nuke_wallet', {}));
    expect(JSON.parse(unknownTool.output)).toMatchObject({ error: 'unknown_tool' });
    const badJson = await binding.executeFunctionCall({
      name: 'get_balance',
      callId: 'call_bad',
      arguments: '{not json',
    });
    expect(JSON.parse(badJson.output)).toMatchObject({ error: 'invalid_json' });
  });
});

describe('realtime tool binding — production execution against the fixture stack', () => {
  it('get_balance returns the fixture balance rounded to two decimals with a spoken form', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(call('get_balance', {}));
    const parsed = JSON.parse(output.output) as {
      balances?: Array<{ balance?: string; balanceSpoken?: string }>;
    };
    // Multi-network read: one JSON with every supported network's balance.
    const entry = parsed.balances?.[0];
    expect(entry?.balance).toBe('42.50');
    // The fixture conversation snapshot is persisted in Spanish.
    expect(entry?.balanceSpoken).toBe('cuarenta y dos USDT con cincuenta centavos');
    expect(binding.calls).toHaveLength(1);
  });

  it('search_recipients resolves mamá from the memory stub', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(call('search_recipients', { query: 'mamá' }));
    const parsed = JSON.parse(output.output) as {
      contacts?: Array<{ id: string; address?: string }>;
      ambiguous?: boolean;
    };
    expect(parsed.ambiguous).toBe(false);
    expect(parsed.contacts?.[0]?.id).toBe(MAMA_RECIPIENT_ID);
    // No address ever leaks to the model.
    expect(JSON.stringify(parsed)).not.toContain(MAMA_ADDRESS);
  });

  it('send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy', async () => {
    const stack = createRealtimeFixtureStack();
    const voiceDecisionGate = createVoiceDecisionGate({ isConfirmation, isCancellation });
    stack.deps.voiceDecisionGate = voiceDecisionGate;
    stack.deps.speakPreview = async () => ({ interrupted: false });
    const binding = createRealtimeToolBinding(stack.deps);

    const preview = await binding.executeFunctionCall(
      call('send_token', {
        amount: '50',
        recipientId: MAMA_RECIPIENT_ID,
        recipientVersion: MAMA_RECIPIENT_VERSION,
      }),
    );
    expect(JSON.parse(preview.output)).toMatchObject({ status: 'confirmation_required' });
    expect(stack.broadcastCalls).toHaveLength(0);
    voiceDecisionGate.recordTranscript({
      previewId: 'current-preview',
      text: 'sí confirmo',
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: Date.now() + 1,
    });

    const confirm = await binding.executeFunctionCall(call('confirm_transfer', {}));
    expect(confirm.output).toBeTruthy();
    // Broadcast went through the spied fixture provider exactly once.
    expect(stack.broadcastCalls).toHaveLength(1);
    expect(stack.broadcastCalls[0]?.amount).toBe('50');
    // Confirm executed only the two production tools, in order.
    expect(binding.calls.map((c) => c.name)).toEqual(['send_token', 'confirm_transfer']);
  });

  it('confirm_transfer without a pending preview fails closed to stale_preview', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(call('confirm_transfer', {}));
    const parsed = JSON.parse(output.output) as { error?: string; code?: string };
    expect(parsed.error ?? parsed.code).toBe('stale_preview');
    expect(stack.broadcastCalls).toHaveLength(0);
  });

  it('nonexistent recipients fail closed to recipient_revalidation_required', async () => {
    const stack = createRealtimeFixtureStack();
    const binding = createRealtimeToolBinding(stack.deps);
    const output = await binding.executeFunctionCall(
      call('send_token', {
        amount: '50',
        recipientId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        recipientVersion: 1,
      }),
    );
    const parsed = JSON.parse(output.output) as { error?: string; code?: string; message?: string };
    const errorText = parsed.error ?? parsed.code ?? parsed.message ?? '';
    expect(errorText).toContain('recipient_revalidation_required');
    expect(stack.broadcastCalls).toHaveLength(0);
  });
});

describe('realtime tool binding — fixture safety guard', () => {
  it('refuses to build the stack with a non-fixture wallet', () => {
    const impostor = {
      mode: 'live',
      getBalance: async () => {
        throw new Error('never called');
      },
    } as unknown as WalletProvider;
    expect(() => createRealtimeFixtureStack({ wallet: impostor })).toThrowError(
      /FixtureWalletProvider/,
    );
  });
});
