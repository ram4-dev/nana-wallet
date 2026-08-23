import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactAddressLikeText } from './embedding.js';
import { isValidEvmAddress } from './address.js';
import type { RecipientMemoryWriteDraft, RecipientMemoryService } from './service.js';
import type { DemoSession } from '../sessions/in-memory-store.js';
import { clearSelectedRecipient, consumeMemoryWrite, currentUserTurnCount, setRecipientClarification, setSelectedRecipient, stageMemoryWrite } from '../sessions/in-memory-store.js';

const searchSchema = z.object({ query: z.string().trim().min(1) });
const selectedAddressSchema = z.object({ recipientId: z.string().uuid(), expectedVersion: z.number().int().positive() });
const writeSchema = z.object({ confirmationId: z.string().uuid() });
const draftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recipient'), name: z.string().trim().min(1), description: z.string().trim().min(1), address: z.string().trim().refine(isValidEvmAddress, 'Expected a valid EVM address.') }),
  z.object({ kind: z.literal('fact'), fact: z.string().trim().min(1), factKind: z.string().trim().min(1).optional() }),
]);

type RecipientMemoryToolsOptions = {
  userId: string;
  session: DemoSession;
  service: RecipientMemoryService;
  confirmationTtlMs?: number;
  now?: () => number;
};

type WriteConfirmation =
  | { status: 'confirmation_required'; confirmationId: string; expiresAt: string; draft: RecipientMemoryWriteDraft }
  | { status: 'invalid_draft' };

function candidateWithoutAddress<T extends Record<string, unknown>>(value: T): T {
  const clone = { ...value };
  delete clone.address;
  return clone;
}

function redactFact<T extends { fact: string; evidence: string }>(fact: T): T {
  return { ...fact, fact: redactAddressLikeText(fact.fact), evidence: redactAddressLikeText(fact.evidence) };
}

export function createRecipientMemoryTools(options: RecipientMemoryToolsOptions) {
  const ttl = options.confirmationTtlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;

  return {
    async search_recipients(input: unknown) {
      const parsed = searchSchema.safeParse(input);
      if (!parsed.success) return { status: 'no_match' as const, candidates: [] };
      clearSelectedRecipient(options.session.id);
      const result = await options.service.searchRecipients(options.userId, parsed.data.query);
      if (result.status === 'resolved') {
        setSelectedRecipient(options.session.id, { recipientId: result.recipient.id, version: result.recipient.version });
      }
      if (result.status === 'clarification_required') {
        setRecipientClarification(options.session.id, result.candidates.map((candidate) => ({
          recipientId: candidate.id,
          version: candidate.version,
          name: candidate.name,
          description: candidate.description,
        })));
      }
      if (result.status === 'resolved') {
        return { status: result.status, candidates: result.candidates.map(candidateWithoutAddress), recipient: candidateWithoutAddress(result.recipient) };
      }
      return { status: result.status, candidates: result.candidates.map(candidateWithoutAddress) };
    },

    async search_user_memory(input: unknown) {
      const parsed = searchSchema.safeParse(input);
      if (!parsed.success) return { status: 'ok' as const, facts: [] };
      const result = await options.service.searchUserMemory(options.userId, parsed.data.query);
      return result.status === 'ok'
        ? { status: 'ok' as const, facts: result.facts.map(redactFact) }
        : { status: result.status, facts: [] };
    },

    async get_recipient_address(input: unknown) {
      const parsed = selectedAddressSchema.safeParse(input);
      const selected = options.session.recipientMemory?.selectedRecipient;
      if (!parsed.success || !selected || selected.recipientId !== parsed.data.recipientId || selected.version !== parsed.data.expectedVersion) {
        return { status: 'selection_required' as const };
      }
      const recipient = await options.service.getRecipientForVersion(options.userId, selected.recipientId, selected.version);
      if (!recipient || !isValidEvmAddress(recipient.address)) {
        clearSelectedRecipient(options.session.id);
        return { status: 'stale_selection' as const };
      }
      return { status: 'resolved' as const, recipientId: recipient.id, version: recipient.version, address: recipient.address };
    },

    async stage_user_memory(input: unknown): Promise<WriteConfirmation> {
      const parsed = draftSchema.safeParse(input);
      if (!parsed.success) return { status: 'invalid_draft' };
      const draft: RecipientMemoryWriteDraft = parsed.data.kind === 'recipient'
        ? { kind: 'recipient', name: parsed.data.name, description: parsed.data.description, address: parsed.data.address }
        : { kind: 'fact', fact: parsed.data.fact, factKind: parsed.data.factKind };
      const confirmationId = randomUUID();
      const expiresAt = now() + ttl;
      stageMemoryWrite(options.session.id, {
        confirmationId,
        userId: options.userId,
        draft,
        expiresAt,
        stagedUserTurn: currentUserTurnCount(options.session),
      });
      return { status: 'confirmation_required', confirmationId, expiresAt: new Date(expiresAt).toISOString(), draft };
    },

    async write_user_memory(input: unknown) {
      const parsed = writeSchema.safeParse(input);
      if (!parsed.success) return { status: 'confirmation_required' as const };
      const pending = consumeMemoryWrite(options.session.id, options.userId, parsed.data.confirmationId, now());
      if (pending.status !== 'ready') return pending;
      try {
        const result = await options.service.writeConfirmed(options.userId, pending.draft);
        return { status: 'written' as const, ...result };
      } catch {
        return { status: 'write_failed' as const };
      }
    },
  };
}
