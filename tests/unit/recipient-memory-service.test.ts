import { describe, expect, it, vi } from 'vitest';
import {
  RecipientMemoryService,
  classifyRecipientCandidates,
  classifyUserMemoryFacts,
  type RecipientMemoryRepositoryPort,
} from '../../src/memory/service.js';
import type { Embedding, RecipientCandidate } from '../../src/memory/types.js';
import { EmbeddingService, recipientEmbeddingText } from '../../src/memory/embedding.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const VECTOR: Embedding = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);

function candidate(overrides: Partial<RecipientCandidate> = {}): RecipientCandidate {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Lucas',
    normalizedName: 'lucas',
    description: 'my grandson',
    version: 1,
    status: 'active',
    embeddingModelRevision: 'test',
    evidence: 'Lucas',
    score: 0.91,
    ...overrides,
  };
}

function repository(overrides: Partial<RecipientMemoryRepositoryPort> = {}): RecipientMemoryRepositoryPort {
  return {
    searchRecipients: vi.fn().mockResolvedValue([candidate()]),
    searchFacts: vi.fn().mockResolvedValue([]),
    getRecipientForVersion: vi.fn().mockResolvedValue(undefined),
    insertRecipient: vi.fn(),
    insertFact: vi.fn(),
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fact: 'Lucas es mi nieto',
    kind: 'relationship',
    version: 1,
    evidence: 'Lucas es mi nieto',
    score: 0.92,
    ...overrides,
  };
}

describe('recipient-memory ranking', () => {
  it('RED: resolves one exact normalized name deterministically, but asks when two exact names exist', () => {
    expect(classifyRecipientCandidates('Lucas', [candidate(), candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Luciano', normalizedName: 'luciano', score: 0.9 })], {
      scoreThreshold: 0.95,
      scoreMargin: 0.5,
    }).status).toBe('resolved');

    expect(classifyRecipientCandidates('Lucas', [candidate(), candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', description: 'the electrician', score: 0.99 })], {
      scoreThreshold: 0.1,
      scoreMargin: 0.01,
    })).toMatchObject({ status: 'clarification_required' });
  });

  it('RED: requires a score threshold and safe margin for semantic-only results', () => {
    expect(classifyRecipientCandidates('my grandson', [candidate({ normalizedName: 'lucas', score: 0.77 })], {
      scoreThreshold: 0.78,
      scoreMargin: 0.08,
    })).toMatchObject({ status: 'no_match' });

    expect(classifyRecipientCandidates('my grandson', [candidate({ normalizedName: 'lucas', score: 0.88 }), candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mateo', normalizedName: 'mateo', score: 0.84 })], {
      scoreThreshold: 0.78,
      scoreMargin: 0.08,
    })).toMatchObject({ status: 'clarification_required' });
  });

  it('orders semantic candidates deterministically before applying the margin', () => {
    const result = classifyRecipientCandidates('my contact', [
      candidate({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Lucas', normalizedName: 'lucas', score: 0.82 }),
      candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mateo', normalizedName: 'mateo', score: 0.93 }),
    ], { scoreThreshold: 0.78, scoreMargin: 0.08 });

    expect(result).toMatchObject({ status: 'resolved', recipient: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
  });

  it('RED: passes the authenticated tenant and produces no candidate on model or database failure', async () => {
    const memoryRepository = repository();
    const service = new RecipientMemoryService(memoryRepository, { embed: vi.fn().mockResolvedValue(VECTOR) }, {
      scoreThreshold: 0.78,
      scoreMargin: 0.08,
    });

    await expect(service.searchRecipients(USER_A, 'Lucas')).resolves.toMatchObject({ status: 'resolved' });
    expect(memoryRepository.searchRecipients).toHaveBeenCalledWith(USER_A, 'lucas', VECTOR);
    expect(memoryRepository.searchRecipients).not.toHaveBeenCalledWith(USER_B, expect.anything(), expect.anything());

    const unavailable = new RecipientMemoryService(repository(), { embed: vi.fn().mockRejectedValue(new Error('model unavailable')) }, {
      scoreThreshold: 0.78,
      scoreMargin: 0.08,
    });
    await expect(unavailable.searchRecipients(USER_A, 'Lucas')).resolves.toEqual({ status: 'unavailable', candidates: [] });

    const databaseUnavailable = new RecipientMemoryService(
      repository({ searchRecipients: vi.fn().mockRejectedValue(new Error('database unavailable')) }),
      { embed: vi.fn().mockResolvedValue(VECTOR) },
      { scoreThreshold: 0.78, scoreMargin: 0.08 },
    );
    await expect(databaseUnavailable.searchRecipients(USER_A, 'Lucas')).resolves.toEqual({ status: 'unavailable', candidates: [] });
  });

  it('RED: keeps irrelevant facts out and turns close conflicting relationships into clarification', async () => {
    const ranking = { scoreThreshold: 0.78, scoreMargin: 0.08 };
    expect(classifyUserMemoryFacts('mi nieto', [fact({ fact: 'Alicia es mi doctora', score: 0.99 })], ranking)).toEqual({ status: 'ok', facts: [] });
    expect(classifyUserMemoryFacts('mi nieto', [
      fact(),
      fact({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fact: 'Mateo es mi nieto', score: 0.88 }),
    ], ranking)).toEqual({ status: 'clarification_required', facts: [] });
  });

  it('RED: requires clarification for distinct matching relationship identities even with a large score gap', () => {
    const ranking = { scoreThreshold: 0.78, scoreMargin: 0.08 };
    expect(classifyUserMemoryFacts('mi nieto', [
      fact({ fact: 'Lucas es mi nieto', score: 0.99 }),
      fact({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fact: 'Mateo es mi nieto', score: 0.40 }),
    ], ranking)).toEqual({ status: 'clarification_required', facts: [] });
  });

  it('RED: resolves one lexically name-and-description-qualified recipient without lowering the semantic threshold', () => {
    const ranking = { scoreThreshold: 0.78, scoreMargin: 0.08 };
    const electrician = candidate({ description: 'el electricista', score: 0.648 });
    expect(classifyRecipientCandidates('Lucas el electricista', [electrician], ranking)).toMatchObject({
      status: 'resolved', recipient: { id: electrician.id },
    });
    expect(classifyRecipientCandidates('Lucas el electricista', [
      electrician,
      candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', description: 'mi nieto', score: 0.20 }),
    ], ranking)).toMatchObject({ status: 'clarification_required' });
  });

  it.runIf(process.env.RECIPIENT_MEMORY_REAL_EMBEDDING === '1')(
    'integrates a real embedding for Lucas el electricista while preserving the global threshold',
    async () => {
      const embeddings = new EmbeddingService(process.env.RECIPIENT_MEMORY_MODEL_CACHE ?? '.cache/recipient-memory-model');
      const [query, document] = await Promise.all([
        embeddings.embed('Lucas el electricista'),
        embeddings.embed(recipientEmbeddingText('Lucas', 'el electricista')),
      ]);
      const score = query.reduce((total, value, index) => total + value * document[index]!, 0);
      const electrician = candidate({ description: 'el electricista', score });
      expect(classifyRecipientCandidates('Lucas el electricista', [electrician], {
        scoreThreshold: 0.78,
        scoreMargin: 0.08,
      })).toMatchObject({ status: 'resolved', recipient: { id: electrician.id } });
    },
  );

  it('RED: rejects an invalid address before it reaches the repository and again when resolving a legacy record', async () => {
    const memoryRepository = repository({
      getRecipientForVersion: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, address: 'not-an-evm-address' }),
    });
    const memory = new RecipientMemoryService(memoryRepository, { embed: vi.fn().mockResolvedValue(VECTOR) }, {
      scoreThreshold: 0.78,
      scoreMargin: 0.08,
    });

    await expect(memory.writeConfirmed(USER_A, { kind: 'recipient', name: 'Lucas', description: 'mi nieto', address: 'not-an-evm-address' }))
      .rejects.toThrow('valid EVM address');
    expect(memoryRepository.insertRecipient).not.toHaveBeenCalled();
    await expect(memory.getRecipientForVersion(USER_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1)).resolves.toBeUndefined();
  });
});
