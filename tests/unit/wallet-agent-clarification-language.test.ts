import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/conversations/test-fixtures.js';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import type { RecipientMemoryRuntime } from '../../src/memory/runtime.js';
import type { RecipientMemoryService } from '../../src/memory/service.js';

/**
 * Regression test: the recipient clarification message must follow the
 * conversation language (eval finding #3 — it was hardcoded in English).
 */
function candidate(name: string, description: string) {
  return {
    id: 'r-1', name, description, version: 1,
    normalizedName: name.toLowerCase(), status: 'active' as const,
    embeddingModelRevision: 'test', score: 1, evidence: 'test',
  };
}

function runtimeWith(
  searchRecipients: RecipientMemoryService['searchRecipients'],
  searchUserMemory?: RecipientMemoryService['searchUserMemory'],
): RecipientMemoryRuntime {
  const service: Partial<RecipientMemoryService> = {
    searchRecipients,
    searchUserMemory: searchUserMemory ?? (async () => ({ status: 'ok', facts: [] })),
  };
  return { userId: 'u-test', service: service as RecipientMemoryService };
}

function ambiguousMemory(): RecipientMemoryRuntime {
  const candidates = [candidate('Lucas', 'mi nieto'), candidate('Lucas', 'el electricista')];
  return runtimeWith(async () => ({ status: 'clarification_required', candidates }));
}

describe('handleMessage clarification language', () => {
  it('asks for clarification in Spanish when language is es', async () => {
    const session = createSession();
    const result = await handleMessage(session, 'Mandale plata a Lucas', {
      recipientMemory: ambiguousMemory(),
      language: 'es',
    });
    expect(result.status).toBe('clarification_required');
    expect(result.message).toMatch(/¿A qué destinatario/i);
    expect(result.message).not.toMatch(/Which recipient/i);
  });

  it('keeps English when language is en', async () => {
    const session = createSession();
    const result = await handleMessage(session, 'Send money to Lucas', {
      recipientMemory: ambiguousMemory(),
      language: 'en',
    });
    expect(result.status).toBe('clarification_required');
    expect(result.message).toMatch(/Which recipient/i);
  });

  it('asks for a missing recipient in Spanish (empty candidates)', async () => {
    const memory = runtimeWith(async () => ({ status: 'clarification_required', candidates: [] }));
    const session = createSession();
    const result = await handleMessage(session, 'Mandale plata a Lucas', {
      recipientMemory: memory,
      language: 'es',
    });
    expect(result.status).toBe('clarification_required');
    expect(result.message).toMatch(/antes de preparar la transferencia/i);
  });
});
