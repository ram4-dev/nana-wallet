import type { ConversationSession } from '../conversations/session-state.js';
import type { RecipientSelection } from '../conversations/types.js';
import { detectRecipientReference } from './recipient-intent.js';
import { factSupportsRelationshipReference } from '../memory/relationship.js';

type Candidate = {
  id: string;
  name: string;
  description: string;
  version: number;
  score?: number;
};

type Fact = { fact: string; evidence?: string; score?: number };

export type RecipientMemoryToolPort = {
  search_recipients(input: { query: string }): Promise<
    | { status: 'resolved'; candidates: Candidate[]; recipient: Candidate }
    | { status: 'clarification_required' | 'no_match' | 'unavailable'; candidates: Candidate[] }
  >;
  search_user_memory(input: { query: string }): Promise<
    | { status: 'ok'; facts: Fact[] }
    | { status: 'clarification_required' | 'unavailable'; facts: [] }
  >;
};

export type TransferRecipientResolution =
  | { status: 'not_applicable' }
  | { status: 'resolved'; recipient: RecipientSelection }
  | { status: 'clarification_required'; candidates: Candidate[] }
  | { status: 'no_match'; candidates: Candidate[] }
  | { status: 'unavailable'; candidates: [] };

function candidateResult(result: Awaited<ReturnType<RecipientMemoryToolPort['search_recipients']>>): TransferRecipientResolution {
  if (result.status === 'resolved') {
    return { status: 'resolved', recipient: { recipientId: result.recipient.id, version: result.recipient.version } };
  }
  if (result.status === 'unavailable') return { status: 'unavailable', candidates: [] };
  if (result.status === 'clarification_required') return { status: 'clarification_required', candidates: result.candidates };
  return { status: 'no_match', candidates: result.candidates };
}

function namesFromFacts(reference: string, facts: Fact[]): string[] {
  const names = new Set<string>();
  for (const fact of facts) {
    if (!factSupportsRelationshipReference(fact.fact, reference)) continue;
    const match = fact.fact.trim().match(/^([^,.!;]+?)\s+(?:is|es)\s+(?:my|mi)\s+/i);
    if (match?.[1]) names.add(match[1].trim());
  }
  return [...names];
}

/**
 * Produces only a selected stable recipient. Address retrieval remains a
 * separate session-bound tool call, so a relationship/fuzzy match can never
 * turn straight into a WDK preview.
 */
export async function resolveTransferRecipient(
  text: string,
  session: ConversationSession,
  memory: RecipientMemoryToolPort,
): Promise<TransferRecipientResolution> {
  const reference = detectRecipientReference(text);
  if (reference.kind === 'none') return { status: 'not_applicable' };
  if (reference.kind === 'pronoun') {
    return session.recipientMemory?.selectedRecipient
      ? { status: 'resolved', recipient: session.recipientMemory.selectedRecipient }
      : { status: 'clarification_required', candidates: [] };
  }
  if (reference.kind === 'query') return candidateResult(await memory.search_recipients({ query: reference.query }));

  const facts = await memory.search_user_memory({ query: reference.query });
  if (facts.status === 'unavailable') return { status: 'unavailable', candidates: [] };
  if (facts.status === 'clarification_required') return { status: 'clarification_required', candidates: [] };
  const names = namesFromFacts(reference.query, facts.facts);
  if (names.length > 1) return { status: 'clarification_required', candidates: [] };
  if (names.length === 1) return candidateResult(await memory.search_recipients({ query: names[0]! }));
  return candidateResult(await memory.search_recipients({ query: reference.query }));
}
