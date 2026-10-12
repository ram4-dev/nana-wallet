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
      scoreFloor: 0.55,
      scoreMargin: 0.5,
    }).status).toBe('resolved');

    expect(classifyRecipientCandidates('Lucas', [candidate(), candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', description: 'the electrician', score: 0.99 })], {
      scoreThreshold: 0.1,
      scoreFloor: 0.05,
      scoreMargin: 0.01,
    })).toMatchObject({ status: 'clarification_required' });
  });

  it('RED: asks instead of denying when the only candidate is plausible but below the threshold', () => {
    // A single candidate at 0.77 against a 0.78 threshold used to answer
    // `no_match`, so the agent denied a contact it had just been handed. That band
    // is now a question: the caller must ask whether it is the right contact.
    expect(classifyRecipientCandidates('my grandson', [candidate({ normalizedName: 'lucas', score: 0.77 })], {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    })).toMatchObject({ status: 'clarification_required', candidates: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] });

    // Below the floor the candidate is NOT selectable, so the status is
    // `no_match` — but the row itself is still shipped, because `no_match` is a
    // statement about SELECTION, never a claim that the user has no contacts.
    // Destroying the row here is what let a misheard query be reported to the
    // user as "that contact does not exist".
    const belowFloor = classifyRecipientCandidates('my grandson', [candidate({ normalizedName: 'lucas', score: 0.42 })], {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    });
    expect(belowFloor).toMatchObject({ status: 'no_match' });
    expect(belowFloor.candidates.map((entry) => entry.name)).toEqual(['Lucas']);
    // The floor still gates selection on BOTH sides: a below-floor result carries
    // evidence but never a `recipient`, so nothing below the floor can be acted on.
    expect(belowFloor).not.toHaveProperty('recipient');

    expect(classifyRecipientCandidates('my grandson', [candidate({ normalizedName: 'lucas', score: 0.88 }), candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mateo', normalizedName: 'mateo', score: 0.84 })], {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    })).toMatchObject({ status: 'clarification_required' });
  });

  it('orders semantic candidates deterministically before applying the margin', () => {
    const result = classifyRecipientCandidates('my contact', [
      candidate({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Lucas', normalizedName: 'lucas', score: 0.82 }),
      candidate({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mateo', normalizedName: 'mateo', score: 0.93 }),
    ], { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 });

    expect(result).toMatchObject({ status: 'resolved', recipient: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
  });

  it('RED: passes the authenticated tenant and produces no candidate on model or database failure', async () => {
    const memoryRepository = repository();
    const service = new RecipientMemoryService(memoryRepository, { embed: vi.fn().mockResolvedValue(VECTOR) }, {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    });

    await expect(service.searchRecipients(USER_A, 'Lucas')).resolves.toMatchObject({ status: 'resolved' });
    expect(memoryRepository.searchRecipients).toHaveBeenCalledWith(USER_A, 'lucas', VECTOR);
    expect(memoryRepository.searchRecipients).not.toHaveBeenCalledWith(USER_B, expect.anything(), expect.anything());

    const unavailable = new RecipientMemoryService(repository(), { embed: vi.fn().mockRejectedValue(new Error('model unavailable')) }, {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    });
    await expect(unavailable.searchRecipients(USER_A, 'Lucas')).resolves.toEqual({ status: 'unavailable', candidates: [] });

    const databaseUnavailable = new RecipientMemoryService(
      repository({ searchRecipients: vi.fn().mockRejectedValue(new Error('database unavailable')) }),
      { embed: vi.fn().mockResolvedValue(VECTOR) },
      { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 },
    );
    await expect(databaseUnavailable.searchRecipients(USER_A, 'Lucas')).resolves.toEqual({ status: 'unavailable', candidates: [] });
  });

  it('RED: keeps irrelevant facts out and turns close conflicting relationships into clarification', async () => {
    const ranking = { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 };
    expect(classifyUserMemoryFacts('mi nieto', [fact({ fact: 'Alicia es mi doctora', score: 0.99 })], ranking)).toEqual({ status: 'ok', facts: [] });
    expect(classifyUserMemoryFacts('mi nieto', [
      fact(),
      fact({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fact: 'Mateo es mi nieto', score: 0.88 }),
    ], ranking)).toEqual({ status: 'clarification_required', facts: [] });
  });

  it('RED: requires clarification for distinct matching relationship identities even with a large score gap', () => {
    const ranking = { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 };
    expect(classifyUserMemoryFacts('mi nieto', [
      fact({ fact: 'Lucas es mi nieto', score: 0.99 }),
      fact({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fact: 'Mateo es mi nieto', score: 0.40 }),
    ], ranking)).toEqual({ status: 'clarification_required', facts: [] });
  });

  it('RED: resolves one lexically name-and-description-qualified recipient without lowering the semantic threshold', () => {
    const ranking = { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 };
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
        scoreFloor: 0.55,
        scoreMargin: 0.08,
      })).toMatchObject({ status: 'resolved', recipient: { id: electrician.id } });
    },
  );

  it('rejects an invalid address before it reaches the repository and again when resolving a legacy record', async () => {
    const memoryRepository = repository({
      getRecipientForVersion: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, address: 'not-an-evm-address' }),
    });
    const memory = new RecipientMemoryService(memoryRepository, { embed: vi.fn().mockResolvedValue(VECTOR) }, {
      scoreThreshold: 0.78,
      scoreFloor: 0.55,
      scoreMargin: 0.08,
    });

    await expect(memory.writeConfirmed(USER_A, { kind: 'recipient', name: 'Lucas', description: 'mi nieto', address: 'not-an-evm-address' }))
      .rejects.toThrow('Recipient address must be a canonical Solana address.');
    expect(memoryRepository.insertRecipient).not.toHaveBeenCalled();
    await expect(memory.getRecipientForVersion(USER_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1)).resolves.toBeUndefined();
  });
});

/**
 * A ranking that makes the retrieval score path unable to resolve anything:
 * every candidate is below the floor. A result that is not `no_match` can
 * therefore only have come from a NAME rule, which is what these cases assert.
 */
const NAME_ONLY_RANKING = { scoreThreshold: 1, scoreFloor: 1, scoreMargin: 1 };

describe('contact-name matching is diacritic-insensitive and bounded', () => {
  const sofia = candidate({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Sofía',
    normalizedName: 'sofía',
    description: 'mi vecina',
    score: 0.9,
  });
  const test1 = candidate({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Test1',
    normalizedName: 'test1',
    description: 'un contacto de prueba',
    score: 0.9,
  });

  it('RED: resolves the accented contact for the accent-less spelling and never carries the unrelated one', () => {
    // The live defect: `Sofía` is stored with normalized_name 'sofía', so the
    // accent-less query found no exact match at all, fell to the retrieval score
    // path, and the resulting near-tie put an unrelated contact in the answer.
    const result = classifyRecipientCandidates('Sofia', [sofia, test1], NAME_ONLY_RANKING);

    expect(result).toMatchObject({ status: 'resolved', recipient: { id: sofia.id, name: 'Sofía' } });
    expect(result.candidates.map((entry) => entry.id)).toEqual([sofia.id]);
  });

  it('RED: resolves a spoken short form through a bounded name prefix', () => {
    expect(classifyRecipientCandidates('sofi', [sofia], NAME_ONLY_RANKING)).toMatchObject({
      status: 'resolved',
      recipient: { id: sofia.id },
    });
  });

  it('asks when a bounded prefix identifies more than one candidate', () => {
    const sofina = candidate({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Sofina',
      normalizedName: 'sofina',
      description: 'otro contacto',
      score: 0.9,
    });

    // Both names start with what was said, so the short form does NOT identify a
    // recipient: the ambiguity guard is unchanged by the prefix rule.
    expect(classifyRecipientCandidates('sofi', [sofia, sofina], NAME_ONLY_RANKING).status).toBe('clarification_required');
    // ...and its control: one candidate, same rule, resolves.
    expect(classifyRecipientCandidates('sofi', [sofina], NAME_ONLY_RANKING)).toMatchObject({
      status: 'resolved', recipient: { id: sofina.id },
    });
  });

  it('treats two rows that differ only by a diacritic as the SAME name, so the query is ambiguous', () => {
    const unaccented = candidate({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Sofia',
      normalizedName: 'sofia',
      description: 'otra persona',
      score: 0.9,
    });

    // Never one of the two: an accent-only difference is the same name, and two
    // rows with the same name are exactly the case that must ask.
    expect(classifyRecipientCandidates('Sofia', [sofia, unaccented], NAME_ONLY_RANKING).status).toBe('clarification_required');
    expect(classifyRecipientCandidates('Sofía', [sofia, unaccented], NAME_ONLY_RANKING).status).toBe('clarification_required');
  });

  it('keeps the prefix rule bounded: too short, or a non-meaningful function word, resolves nothing', () => {
    expect(classifyRecipientCandidates('sof', [sofia], NAME_ONLY_RANKING)).toMatchObject({
      status: 'no_match', candidates: [{ id: sofia.id }],
    });
    const parana = candidate({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Paraná',
      normalizedName: 'paraná',
      description: 'otro contacto',
      score: 0.9,
    });
    expect(classifyRecipientCandidates('para', [parana], NAME_ONLY_RANKING)).toMatchObject({
      status: 'no_match', candidates: [{ id: parana.id }],
    });
  });

  it('folds the name-and-qualifier path too, so a qualified request is not defeated by an accent', () => {
    const electrician = candidate({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Sofía',
      normalizedName: 'sofía',
      description: 'el electricista',
      score: 0.2,
    });

    expect(classifyRecipientCandidates('Sofia el electricista', [electrician], NAME_ONLY_RANKING)).toMatchObject({
      status: 'resolved', recipient: { id: electrician.id },
    });
  });

  it('leaves an unrelated name on the retrieval path, which is still the honest answer for it', () => {
    // No name rule matches `Sofia` against `Lucas`, and the score cannot either:
    // nothing is selectable, reported as such — with the row still attached.
    expect(classifyRecipientCandidates('Sofia', [candidate()], NAME_ONLY_RANKING)).toMatchObject({
      status: 'no_match', candidates: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    });
    // With a usable score the SAME unrelated query still resolves through the
    // embedding fallback, so the fallback is intact rather than bypassed.
    expect(classifyRecipientCandidates('Sofia', [candidate({ score: 0.99 })], {
      scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08,
    }).status).toBe('resolved');
  });
});

/**
 * The live regression this suite was opened for.
 *
 * A user asked the voice agent for "my nephew". The audio model rendered the
 * description as the phonetic proper name `MinaFi`, and the agent told the user
 * the contact does not exist. It did exist — stored as `Sophie`, with the
 * description `"My nephew"` — and the repository had returned it on both
 * queries. `no_match` shipped an EMPTY candidate list, so the surface had
 * nothing to read back and a comprehension error became a false claim about the
 * user's own data.
 *
 * The scores below are the ones measured against the deployed stack.
 */
describe('a below-floor result still reports the rows the store returned', () => {
  const RANKING = { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 };
  const sophie = candidate({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Sophie',
    normalizedName: 'sophie',
    description: 'My nephew',
  });
  const test1 = candidate({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Test1',
    normalizedName: 'test1',
    description: '',
  });

  it('RED: a misheard query carries the right contact and its stored description', () => {
    // `MinaFi` measured 0.263 for Sophie, 0.231 and 0.224 for the others: all
    // below the 0.55 floor, so nothing is selectable.
    const misheard = classifyRecipientCandidates('minafi', [
      { ...sophie, score: 0.263 },
      { ...test1, score: 0.231 },
      { ...sophie, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', score: 0.224, description: 'otra fila' },
    ], RANKING);

    expect(misheard.status).toBe('no_match');
    // The evidence must survive, ranked, so the surface can say "I found Sophie,
    // saved as my nephew" instead of "that contact does not exist".
    expect(misheard.candidates.map((entry) => entry.name)).toEqual(['Sophie', 'Test1', 'Sophie']);
    expect(misheard.candidates[0]).toMatchObject({ name: 'Sophie', description: 'My nephew' });
    expect(misheard.candidates[0]!.score).toBeCloseTo(0.263, 3);
  });

  it('the SAME query is still not selectable, so carrying the rows adds no way to act on them', () => {
    const misheard = classifyRecipientCandidates('minafi', [{ ...sophie, score: 0.263 }], RANKING);

    expect(misheard.status).toBe('no_match');
    // `no_match` never yields a `recipient`, and the selection is only ever set
    // from `resolved` (see `src/memory/tools.ts`), so a low-score row can be
    // reported but never becomes a transfer target on its own.
    expect(misheard).not.toHaveProperty('recipient');
    expect(misheard.candidates.every((entry) => entry.status === 'active')).toBe(true);
  });

  it('a genuinely empty store still reports nothing, so the two cases stay distinguishable', () => {
    // An empty retrieval and a below-floor retrieval are NOT the same fact, and
    // after this change they are no longer the same payload either.
    expect(classifyRecipientCandidates('minafi', [], RANKING)).toEqual({ status: 'no_match', candidates: [] });
  });
});
