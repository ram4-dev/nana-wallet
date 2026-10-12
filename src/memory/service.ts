import { EMBEDDING_MODEL_ID, type Embedding, type RecipientCandidate, type RecipientInput, type RecipientRecord, type UserMemoryFact, type UserMemoryInput } from './types.js';
import { comparisonTextKey, factEmbeddingText, normalizeMemoryText, recipientEmbeddingText } from './embedding.js';
import { isValidRecipientAddress, resolveRecipientNetwork } from './address.js';
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
  /**
   * Relevance floor. Below it a candidate is noise, so the lookup is a real miss.
   * Between the floor and `scoreThreshold` there is a plausible-but-unsure
   * candidate: the caller must ask, never deny that the contact exists.
   */
  scoreFloor: number;
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

  // NAME MATCHING HAPPENS ON THE FOLDED COMPARISON KEY, NEVER ON THE STORED
  // NORMALIZATION. `recipients.normalized_name` keeps its diacritics (`Sofía` is
  // stored as `sofía`), so comparing it directly made the user's own contact
  // unfindable under the accent-less spelling of their own name: no exact match,
  // and the answer then came from the retrieval score path, where a near-tie put
  // an unrelated contact into the reply. See `comparisonTextKey` for why the fold
  // lives at comparison time instead of in the stored value.
  const queryKey = comparisonTextKey(query);

  // 1. THE SAME NAME, diacritics ignored. Two rows one accent apart are ONE name,
  //    not two: they stay ambiguous rather than being silently separated.
  const exactMatches = ranked.filter((candidate) => comparisonTextKey(candidate.normalizedName) === queryKey);
  if (exactMatches.length === 1) return resolvedOn(exactMatches[0]!);
  if (exactMatches.length > 1) return { status: 'clarification_required', candidates: ranked };

  // 2. The name plus a description qualifier, which is the STRICTER lexical rule
  //    and therefore runs before the loose one below.
  const qualifiedRecipient = resolveUniqueLexicallyQualifiedRecipient(queryKey, ranked);
  if (qualifiedRecipient === 'ambiguous') return { status: 'clarification_required', candidates: ranked };
  if (qualifiedRecipient) return resolvedOn(qualifiedRecipient);

  // 3. A spoken SHORT FORM of one name, bounded by
  //    `resolveUniquePrefixedRecipient`.
  const prefixedRecipient = resolveUniquePrefixedRecipient(queryKey, ranked);
  if (prefixedRecipient === 'ambiguous') return { status: 'clarification_required', candidates: ranked };
  if (prefixedRecipient) return resolvedOn(prefixedRecipient);

  const [first, second] = ranked;
  // NO CANDIDATE IS SELECTABLE BELOW THE FLOOR — but the rows are still
  // RETURNED, and the difference between those two facts is the whole point.
  //
  // `no_match` answers "can I hand you a recipient to act on?" and that answer is
  // no. It is NOT a claim that the user has no contacts, so the retrieved rows
  // travel with it. Destroying them here made a misheard query (a description the
  // audio model rendered as the phonetic name `MinaFi`) come back as an empty
  // list, and the surface then told the user their contact does not exist while
  // the row — `Sophie`, described as "My nephew" — was there all along. A caller
  // that receives evidence it cannot act on can still say what it found; a caller
  // that receives nothing can only deny.
  //
  // The floor keeps gating ACTIONS, not DISCLOSURE: nothing below it yields a
  // `recipient`, and a selection is only ever set from `resolved`, so a
  // low-scoring row can be reported but never becomes a transfer target.
  if (!first || first.score < config.scoreFloor) return { status: 'no_match', candidates: ranked };
  // Plausible but unproven: hand the candidates over so the caller can ask
  // "is this the contact you meant?" instead of reporting that nothing exists.
  if (first.score < config.scoreThreshold) return { status: 'clarification_required', candidates: ranked };
  if (second && first.score - second.score < config.scoreMargin) {
    return { status: 'clarification_required', candidates: ranked };
  }
  return { status: 'resolved', candidates: ranked, recipient: first };
}

/**
 * The answer for a recipient a NAME RULE identified.
 *
 * The ranked list is deliberately NOT carried here, and that is part of the fix:
 * a deterministic name match means the other rows the retrieval returned are
 * irrelevant to what the user said, and handing them over presents a stranger as
 * a plausible candidate for a name that already identified someone. The score
 * path below still carries the whole list, because there the list IS the question
 * ("is this the contact you meant?") and dropping candidates from it would hide
 * the very evidence the caller is asking about.
 */
function resolvedOn(recipient: RecipientCandidate): RecipientSearchResult {
  return { status: 'resolved', candidates: [recipient], recipient };
}

const NON_MEANINGFUL_DESCRIPTION_TERMS = new Set([
  'a', 'al', 'and', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'los', 'mi', 'my', 'of', 'para', 'the', 'to', 'un', 'una', 'y',
]);

/**
 * The shortest short form the prefix rule will act on.
 *
 * Three characters would make function words and initials start resolving names
 * (`del` -> `Delia`, `mar` -> `Marcos`) off a single syllable nobody said as a
 * name. Four is the shortest span that is a plausible abbreviation of a name
 * (`sofi` -> `Sofía`, `luci` -> `Lucía`) and is what the spoken defect needs.
 */
const MIN_NAME_PREFIX_LENGTH = 4;

function meaningfulTerms(value: string): Set<string> {
  return new Set((value.match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !NON_MEANINGFUL_DESCRIPTION_TERMS.has(term)));
}

/**
 * The ONE candidate a bounded name prefix identifies, `'ambiguous'` when more
 * than one candidate starts with it, or `undefined` when there is none.
 *
 * WHY A PREFIX IS DEFENSIBLE HERE, AND WHERE IT IS BOUNDED
 * -------------------------------------------------------
 * A person refers to a contact by a short form of their name (`sofi` for
 * `Sofía`), and a short form is by definition a PREFIX of the name — not an
 * arbitrary fuzzy neighbour. Every bound below exists so this cannot become a
 * loose match to a payee:
 *
 *   - the query must be a prefix of the WHOLE name (so `sofi` matches `Sofía`),
 *     compared on the folded key, so an accent never defeats it;
 *   - the folded query must be at least {@link MIN_NAME_PREFIX_LENGTH} long;
 *   - the folded query must not be a non-meaningful function word (`para` is a
 *     prefix of `Paraná` and is still not a name);
 *   - MORE THAN ONE match is `'ambiguous'`, never a pick. The rule can therefore
 *     only ever resolve a name that identifies exactly one contact, which is the
 *     same guard exact matching already applies.
 *
 * Matching inside a word (`garcia` for `Ana García`) is deliberately NOT done
 * here: that widens the lexical surface to any word of any name with no defect
 * asking for it, and a surname a user only half-remembers is a question the
 * retrieval fallback already answers — with evidence, and with the ambiguity
 * guard the whole list preserves.
 */
function resolveUniquePrefixedRecipient(
  queryKey: string,
  candidates: RecipientCandidate[],
): RecipientCandidate | 'ambiguous' | undefined {
  if (queryKey.length < MIN_NAME_PREFIX_LENGTH) return undefined;
  if (NON_MEANINGFUL_DESCRIPTION_TERMS.has(queryKey)) return undefined;
  // `startsWith` includes equality, which the exact rule above already answered
  // for: a query that EQUALS a folded name never reaches this point.
  const prefixed = candidates.filter((candidate) =>
    comparisonTextKey(candidate.normalizedName).startsWith(queryKey),
  );
  if (prefixed.length > 1) return 'ambiguous';
  return prefixed[0];
}

/**
 * A description-qualified request can be grounded lexically even when an
 * embedding under-scores it. The name must identify exactly one candidate and
 * the remaining query must share a meaningful description term; name-only,
 * duplicate-name, and conflicting candidates stay on the normal safe path.
 *
 * Both sides are compared on the FOLDED key, so the same diacritic insensitivity
 * the exact rule gets applies to the name and to the qualifier alike: `Sofia el
 * electricista` is the same request as `Sofía el electricista`. The offsets come
 * from the folded query, never from the stored name, so they agree with the text
 * being sliced.
 */
function resolveUniqueLexicallyQualifiedRecipient(
  queryKey: string,
  candidates: RecipientCandidate[],
): RecipientCandidate | 'ambiguous' | undefined {
  const named = candidates.filter((candidate) =>
    queryKey.startsWith(`${comparisonTextKey(candidate.normalizedName)} `),
  );
  if (named.length > 1) return 'ambiguous';
  if (named.length === 0) return undefined;
  const candidate = named[0]!;
  const qualifier = queryKey.slice(comparisonTextKey(candidate.normalizedName).length).trim();
  if (!qualifier) return undefined;
  const qualifierTerms = meaningfulTerms(qualifier);
  const descriptionTerms = meaningfulTerms(comparisonTextKey(candidate.description));
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
      // RAM-009: a legacy record stored without a network is resolved against the
      // configured chain, never accepted through the EVM regex, so the address
      // handed to a transfer preview is always a canonical base58 key.
      return recipient && isValidRecipientAddress(recipient.address, resolveRecipientNetwork(recipient.network)) ? recipient : undefined;
    } catch {
      return undefined;
    }
  }

  public async writeConfirmed(userId: string, draft: RecipientMemoryWriteDraft): Promise<RecipientMemoryWriteResult> {
    if (draft.kind === 'recipient') {
      if (!isValidRecipientAddress(draft.address, 'solana-devnet')) {
        throw new Error('Recipient address must be a canonical Solana address.');
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
