import { EMBEDDING_MODEL_ID, type Embedding, type RecipientCandidate, type RecipientInput, type RecipientRecord, type UserMemoryFact, type UserMemoryInput } from './types.js';
import { factEmbeddingText, normalizeMemoryText, recipientEmbeddingText } from './embedding.js';
import { isValidEvmAddress } from './address.js';
import { factSupportsRelationshipReference, isRelationshipReference, relationshipFactIdentity } from './relationship.js';

export type RecipientMemoryRepositoryPort = {
  searchRecipients(userId: string, query: string, embedding: Embedding, limit?: number): Promise<RecipientCandidate[]>;
  searchFacts(userId: string, query: string, embedding: Embedding, limit?: number): Promise<UserMemoryFact[]>;
  getRecipientForVersion(userId: string, recipientId: string, expectedVersion: number): Promise<RecipientRecord | undefined>;
  insertRecipient(userId: string, input: RecipientInput, embedding: Embedding, embeddingModelRevision: string): Promise<RecipientRecord>;
  insertFact(userId: string, input: UserMemoryInput, embedding: Embedding, embeddingModelRevision: string): Promise<UserMemoryFact>;
};

export type EmbeddingPort = {
  embed(text: string): Promise<number[]>;
};

export type RankingConfig = {
  scoreThreshold: number;
  scoreMargin: number;
};

export type RecipientSearchResult =
  | { status: 'resolved'; candidates: RecipientCandidate[]; recipient: RecipientCandidate }
  | { status: 'clarification_required'; candidates: RecipientCandidate[] }
  | { status: 'no_match'; candidates: RecipientCandidate[] }
  | { status: 'unavailable'; candidates: [] };

export type UserMemorySearchResult =
  | { status: 'ok'; facts: UserMemoryFact[] }
  | { status: 'clarification_required'; facts: [] }
  | { status: 'unavailable'; facts: [] };

export type RecipientMemoryWriteDraft =
  | { kind: 'recipient'; name: string; description: string; address: string }
  | { kind: 'fact'; fact: string; factKind?: string };

export type RecipientMemoryWriteResult =
  | { kind: 'recipient'; id: string; version: number; name: string }
  | { kind: 'fact'; id: string; version: number; fact: string };

export function classifyRecipientCandidates(
  query: string,
  candidates: RecipientCandidate[],
  config: RankingConfig,
): RecipientSearchResult {
  if (candidates.length === 0) return { status: 'no_match', candidates: [] };

  const ranked = [...candidates].sort((left, right) =>
    right.score - left.score || left.normalizedName.localeCompare(right.normalizedName) || left.id.localeCompare(right.id),
  );

  const normalizedQuery = normalizeMemoryText(query);
  const exactMatches = ranked.filter((candidate) => candidate.normalizedName === normalizedQuery);
  if (exactMatches.length === 1) {
    return { status: 'resolved', candidates: ranked, recipient: exactMatches[0]! };
  }
  if (exactMatches.length > 1) return { status: 'clarification_required', candidates: ranked };

  const qualifiedRecipient = resolveUniqueLexicallyQualifiedRecipient(normalizedQuery, ranked);
  if (qualifiedRecipient === 'ambiguous') return { status: 'clarification_required', candidates: ranked };
  if (qualifiedRecipient) return { status: 'resolved', candidates: ranked, recipient: qualifiedRecipient };

  const [first, second] = ranked;
  if (!first || first.score < config.scoreThreshold) return { status: 'no_match', candidates: ranked };
  if (second && first.score - second.score < config.scoreMargin) {
    return { status: 'clarification_required', candidates: ranked };
  }
  return { status: 'resolved', candidates: ranked, recipient: first };
}

const NON_MEANINGFUL_DESCRIPTION_TERMS = new Set([
  'a', 'al', 'and', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'los', 'mi', 'my', 'of', 'para', 'the', 'to', 'un', 'una', 'y',
]);

function meaningfulTerms(value: string): Set<string> {
  return new Set((value.match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !NON_MEANINGFUL_DESCRIPTION_TERMS.has(term)));
}

/**
 * A description-qualified request can be grounded lexically even when an
 * embedding under-scores it. The name must identify exactly one candidate and
 * the remaining query must share a meaningful description term; name-only,
 * duplicate-name, and conflicting candidates stay on the normal safe path.
 */
function resolveUniqueLexicallyQualifiedRecipient(
  normalizedQuery: string,
  candidates: RecipientCandidate[],
): RecipientCandidate | 'ambiguous' | undefined {
  const named = candidates.filter((candidate) =>
    normalizedQuery.startsWith(`${candidate.normalizedName} `),
  );
  if (named.length > 1) return 'ambiguous';
  if (named.length === 0) return undefined;
  const candidate = named[0]!;
  const qualifier = normalizedQuery.slice(candidate.normalizedName.length).trim();
  if (!qualifier) return undefined;
  const qualifierTerms = meaningfulTerms(qualifier);
  const descriptionTerms = meaningfulTerms(normalizeMemoryText(candidate.description));
  return [...qualifierTerms].some((term) => descriptionTerms.has(term)) ? candidate : undefined;
}

/**
 * Facts are retrieval evidence, not identity. Only one sufficiently relevant
 * fact can be promoted to a name lookup; close results are intentionally
 * ambiguous so conflicting relationships cannot select a payee.
 */
export function classifyUserMemoryFacts(
  query: string,
  facts: UserMemoryFact[],
  config: RankingConfig,
): UserMemorySearchResult {
  const relevantFacts = isRelationshipReference(query)
    ? facts.filter((fact) => factSupportsRelationshipReference(fact.fact, query))
    : facts;
  if (relevantFacts.length === 0) return { status: 'ok', facts: [] };
  if (isRelationshipReference(query)) {
    const identities = new Set(
      relevantFacts
        .map((fact) => relationshipFactIdentity(fact.fact))
        .filter((identity): identity is string => !!identity)
        .map(normalizeMemoryText),
    );
    if (identities.size > 1) return { status: 'clarification_required', facts: [] };
  }
  const ranked = [...relevantFacts].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const [first, second] = ranked;
  if (!first || first.score < config.scoreThreshold) return { status: 'ok', facts: [] };
  if (second && first.score - second.score < config.scoreMargin) {
    return { status: 'clarification_required', facts: [] };
  }
  return { status: 'ok', facts: [first] };
}

export class RecipientMemoryService {
  public constructor(
    private readonly repository: RecipientMemoryRepositoryPort,
    private readonly embeddings: EmbeddingPort,
    private readonly ranking: RankingConfig,
  ) {}

  public async searchRecipients(userId: string, query: string): Promise<RecipientSearchResult> {
    try {
      const normalizedQuery = normalizeMemoryText(query);
      if (!normalizedQuery) return { status: 'no_match', candidates: [] };
      const embedding = await this.embeddings.embed(normalizedQuery);
      const candidates = await this.repository.searchRecipients(userId, normalizedQuery, embedding);
      return classifyRecipientCandidates(normalizedQuery, candidates, this.ranking);
    } catch {
      // DB/model failures are deliberately indistinguishable to callers and can never fall back to an address.
      return { status: 'unavailable', candidates: [] };
    }
  }

  public async searchUserMemory(userId: string, query: string): Promise<UserMemorySearchResult> {
    try {
      const normalizedQuery = normalizeMemoryText(query);
      if (!normalizedQuery) return { status: 'ok', facts: [] };
      const embedding = await this.embeddings.embed(normalizedQuery);
      return classifyUserMemoryFacts(
        normalizedQuery,
        await this.repository.searchFacts(userId, normalizedQuery, embedding),
        this.ranking,
      );
    } catch {
      return { status: 'unavailable', facts: [] };
    }
  }

  public async getRecipientForVersion(userId: string, recipientId: string, expectedVersion: number): Promise<RecipientRecord | undefined> {
    try {
      const recipient = await this.repository.getRecipientForVersion(userId, recipientId, expectedVersion);
      return recipient && isValidEvmAddress(recipient.address) ? recipient : undefined;
    } catch {
      return undefined;
    }
  }

  public async writeConfirmed(userId: string, draft: RecipientMemoryWriteDraft): Promise<RecipientMemoryWriteResult> {
    if (draft.kind === 'recipient') {
      if (!isValidEvmAddress(draft.address)) {
        throw new Error('Recipient address must be a valid EVM address.');
      }
      const embedding = await this.embeddings.embed(recipientEmbeddingText(draft.name, draft.description));
      const recipient = await this.repository.insertRecipient(userId, {
        name: draft.name,
        description: draft.description,
        address: draft.address,
      }, embedding, EMBEDDING_MODEL_ID);
      return { kind: 'recipient', id: recipient.id, version: recipient.version, name: recipient.name };
    }

    const embedding = await this.embeddings.embed(factEmbeddingText(draft.fact));
    const fact = await this.repository.insertFact(userId, { fact: draft.fact, kind: draft.factKind }, embedding, EMBEDDING_MODEL_ID);
    return { kind: 'fact', id: fact.id, version: fact.version, fact: fact.fact };
  }
}
