import 'dotenv/config';
import { evalite } from 'evalite';
import { z } from 'zod';
import {
  createWalletAgentDefinition,
  type ContactActionPort,
  type WalletAgentContext,
} from '../../src/agent/definition.js';
import { toAiSdkTools } from '../../src/agent/ai-sdk-adapter.js';
import { toLivekitRealtimeTools } from '../../src/agent/livekit-realtime-adapter.js';
import {
  createVoiceContactActions,
  REVIEW_CHANNEL_MESSAGE,
} from '../../src/livekit/contact-proposal-publication.js';
import { policyReadinessSchema } from '../../src/contracts/http.js';

/**
 * Recipient lifecycle evals, text context and voice context (task 4.9; design
 * §12.2; `AGENTS.md` rule 2).
 *
 * Every case declares its context and is observed through the adapter that
 * context actually uses: the AI SDK surface (`toAiSdkTools`) for text, the
 * LiveKit realtime surface (`toLivekitRealtimeTools`) for voice. The tool
 * surface, the argument discipline and the address prohibition are asserted
 * through those adapters, never through the shared definition alone.
 *
 * Deterministic and offline (no model, no network, no database): the persistence
 * adapter behind the voice port is stubbed, because what this eval measures is
 * the model/agent boundary — the schema gate, the truthful refusal wording, and
 * the fact that a name can never become an address. The status vocabulary is
 * asserted against the exact vocabulary in
 * `openspec/changes/trusted-recipient-policy-sync/spec.md`, and the success-word
 * detector carries its own positive control so a scorer can never pass
 * vacuously.
 */

type ContextKind = 'text' | 'voice';

const LIFECYCLE_TOOLS = [
  'stage_trusted_recipient',
  'stage_trusted_recipient_edit',
  'stage_trusted_recipient_removal',
  'confirm_trusted_recipient_action',
] as const;

/**
 * Verbatim from spec.md, "Effective status vocabulary and no premature
 * success": saved or not configured, pending, syncing, applied, retryable
 * failure, and blocked conflict/configuration.
 */
const SPEC_STATUS_VOCABULARY = [
  'saved_not_configured',
  'pending',
  'syncing',
  'applied',
  'retryable_failure',
  'blocked_conflict',
  'blocked_configuration',
] as const;

/** Statuses the lifecycle ports are declared to answer with. `applied` is not one. */
const DECLARED_PORT_STATUSES = [
  'staged',
  'consumed',
  'confirmation_required',
  'conflict_active_window',
  'address_review_required',
  'proposal_not_published',
] as const;

const CONTACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOUND_IDENTITY = 'nana-visual-reviewer-1';

/** A synthetic display label. Never an address, never a real contact. */
const SYNTHETIC_NAME = 'Marta Sintetica';

/** Keys a model must never smuggle into a lifecycle call. */
const FORBIDDEN_KEYS: Array<[string, unknown]> = [
  ['address', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
  ['network', 'solana-devnet'],
  ['policyId', 'pol_123'],
  ['signerId', 'did:privy:synthetic-signer'],
  ['cap', '10000000'],
  ['confirmationId', 'conf-1'],
  ['timestamp', 1_700_000_000],
  ['turnCount', 4],
];

const VALID_INPUT: Record<(typeof LIFECYCLE_TOOLS)[number], Record<string, unknown>> = {
  stage_trusted_recipient: { name: SYNTHETIC_NAME },
  stage_trusted_recipient_edit: { contactId: CONTACT_ID, expectedVersion: 3 },
  stage_trusted_recipient_removal: { contactId: CONTACT_ID, expectedVersion: 3 },
  confirm_trusted_recipient_action: { proposalId: PROPOSAL_ID, proposalVersion: 1 },
};

/** A base58-shaped value: what any of these paths must never emit. */
const BASE58_VALUE = /[1-9A-HJ-NP-Za-km-z]{32,88}/u;
/** Keys asserting wallet authority the model boundary must not accept or emit. */
const AUTHORITY_KEY = /address|network|policy|signer|cap/iu;

const AFFIRMATIVE_SUCCESS = /\b(?:habilitad|aplicad|activad|revocad)[oa]s?\b/giu;
const NEGATION_IN_CLAUSE = /(?:^|\s)(?:no|nunca|jam[áa]s|sin|ni|todav[íi]a|a[úu]n)\s/u;

/**
 * True when the message claims a recipient is enabled/applied/active/revoked.
 * A negation in the same clause turns that into an honest denial, which is the
 * wording the refusal paths are required to use.
 */
function claimsSuccessWording(message: string): boolean {
  const normalized = message.toLocaleLowerCase('es-AR');
  for (const match of normalized.matchAll(AFFIRMATIVE_SUCCESS)) {
    const clause = normalized.slice(0, match.index ?? 0).split(/[.;:,!?]/u).pop() ?? '';
    if (!NEGATION_IN_CLAUSE.test(` ${clause} `)) return true;
  }
  return false;
}

type SurfaceTool = {
  schema: unknown;
  execute: (input: unknown) => Promise<unknown>;
};

function baseContext(port?: ContactActionPort, voice = false): WalletAgentContext {
  return {
    conversationId: 'conv-1',
    userId: 'user-1',
    language: 'es',
    config: { wallet: 'wallet', network: 'solana-devnet', token: 'SOL' },
    session: { id: 'conv-1', messages: [] },
    wallet: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
    ...(port ? { contactActions: port } : {}),
    ...(voice ? { voiceService: {} as never } : {}),
  };
}

/**
 * The tool surface as the adapter of this context exposes it. The AI SDK wraps
 * the schema, so an unparseable wrapper falls back to the shared definition's
 * zod schema — the same object the parity unit test proves the adapters pass
 * through unchanged.
 */
function surfaceTools(
  kind: ContextKind,
  ctx: WalletAgentContext,
): Record<string, SurfaceTool> {
  const definition = createWalletAgentDefinition();
  const shared = new Map(
    definition.tools(ctx).map((entry) => [entry.name, entry.inputSchema]),
  );
  const tools: Record<string, SurfaceTool> = {};

  if (kind === 'voice') {
    const voiceTools = toLivekitRealtimeTools(definition, ctx) as unknown as Array<{
      name: string;
      parameters: unknown;
      execute: (input: unknown) => Promise<unknown>;
    }>;
    for (const entry of voiceTools) {
      tools[entry.name] = {
        schema: entry.parameters,
        execute: (input) => entry.execute(input),
      };
    }
    return tools;
  }

  for (const [name, value] of Object.entries(toAiSdkTools(definition, ctx))) {
    const adapter = value as unknown as {
      inputSchema?: unknown;
      parameters?: unknown;
      execute?: (input: unknown) => Promise<unknown>;
    };
    const execute = adapter.execute;
    if (!execute) throw new Error(`text tool ${name} exposes no execute`);
    tools[name] = {
      schema: adapter.inputSchema ?? adapter.parameters ?? shared.get(name),
      // The AI SDK execute signature requires its execution options object.
      execute: (input) => execute(input, {} as never),
    };
  }
  return tools;
}

function zodOf(schema: unknown, name: string, ctx: WalletAgentContext): z.ZodType {
  if (schema && typeof (schema as z.ZodType).safeParse === 'function') {
    return schema as z.ZodType;
  }
  const shared = createWalletAgentDefinition()
    .tools(ctx)
    .find((entry) => entry.name === name);
  if (!shared) throw new Error(`tool ${name} is missing from the shared definition`);
  return shared.inputSchema as z.ZodType;
}

function issuePaths(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => String(issue.path[0] ?? ''));
}

function issueCodes(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.code);
}

/** A recording stand-in for the server-owned proposal service (text context). */
function recordingPort() {
  const calls: Array<Parameters<ContactActionPort['stage']>[0]> = [];
  const port: ContactActionPort = {
    stage: async (input) => {
      calls.push(input);
      return {
        status: 'staged',
        proposalId: PROPOSAL_ID,
        proposalVersion: 1,
        message: 'Revisá la dirección en la tarjeta y confirmá cuando esté lista.',
      };
    },
  };
  return { port, calls };
}

type Observation = {
  label: string;
  context: ContextKind;
  toolsExposed: boolean;
  missingTools: string[];
  argumentDiscipline: Array<{ tool: string; key: string; ok: boolean }>;
  schemaKeepsAddressOut: boolean;
  ambiguousNameAsksFirst: boolean;
  ambiguousDetail: string[];
  serverCallsOnAmbiguousName: number;
  noAddressFromName: boolean;
  noAddressDetail: string[];
  wording: Array<{ label: string; status: string; message: string; claimsSuccess: boolean }>;
  refusalWordingHonest: boolean;
  detectorControl: { affirmative: boolean; denial: boolean };
  noUnverifiedSuccessWording: boolean;
  vocabulary: string[];
  statusVocabularyExact: boolean;
  undeclaredStatuses: string[];
  publishedCardAddressIsNull: boolean;
};

/**
 * Observes one context. The voice refusal wording and the published card come
 * from the production port (`createVoiceContactActions`); the text refusal
 * wording comes from the production fail-closed path of the shared definition
 * when no server-owned port is wired.
 */
async function observe(kind: ContextKind): Promise<Observation> {
  const voice = kind === 'voice';
  const recording = recordingPort();
  const ctx = baseContext(recording.port, voice);
  const tools = surfaceTools(kind, ctx);

  const missingTools = LIFECYCLE_TOOLS.filter((name) => !tools[name]);
  const toolsExposed = missingTools.length === 0;

  const ambiguousDetail: string[] = [];
  const argumentDiscipline: Array<{ tool: string; key: string; ok: boolean }> = [];
  const noAddressDetail: string[] = [];
  const wording: Observation['wording'] = [];
  const statuses: string[] = [];

  for (const name of LIFECYCLE_TOOLS) {
    const schema = zodOf(tools[name].schema, name, ctx);
    const valid = schema.safeParse(VALID_INPUT[name]);
    argumentDiscipline.push({ tool: name, key: '(valid payload)', ok: valid.success });
    if (!valid.success) ambiguousDetail.push(`${name} rejected its own valid payload`);

    for (const [key, value] of FORBIDDEN_KEYS) {
      const result = schema.safeParse({ ...VALID_INPUT[name], [key]: value });
      argumentDiscipline.push({
        tool: name,
        key,
        ok: !result.success && issueCodes(result).includes('unrecognized_keys'),
      });
    }

    const json = JSON.stringify(z.toJSONSchema(schema));
    if (AUTHORITY_KEY.test(json)) noAddressDetail.push(`${name} schema exposes an authority field`);
  }

  // An ambiguous name is a label, never a selector: the identifier is what is
  // missing, so the model must ask which recipient it means.
  for (const name of ['stage_trusted_recipient_edit', 'stage_trusted_recipient_removal'] as const) {
    const schema = zodOf(tools[name].schema, name, ctx);
    const byName = schema.safeParse({ name: SYNTHETIC_NAME, expectedVersion: 3 });
    if (byName.success || !issuePaths(byName).includes('contactId')) {
      ambiguousDetail.push(`${name} accepted a name instead of a contact id`);
    }
    const nameAlongsideId = schema.safeParse({
      contactId: CONTACT_ID,
      expectedVersion: 3,
      name: SYNTHETIC_NAME,
    });
    if (nameAlongsideId.success || !issueCodes(nameAlongsideId).includes('unrecognized_keys')) {
      ambiguousDetail.push(`${name} treated a name as an alias for the id`);
    }
  }
  const confirmSchema = zodOf(
    tools.confirm_trusted_recipient_action.schema,
    'confirm_trusted_recipient_action',
    ctx,
  );
  const phraseInsteadOfEvidence = confirmSchema.safeParse({
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    name: SYNTHETIC_NAME,
  });
  if (
    phraseInsteadOfEvidence.success ||
    !issueCodes(phraseInsteadOfEvidence).includes('unrecognized_keys')
  ) {
    ambiguousDetail.push('confirm_trusted_recipient_action accepted a name as evidence');
  }

  // Nothing executes on a payload the schema rejected; the runtime gate is the
  // same schema, so the recorded server calls stay at zero.
  const ambiguousParse = zodOf(
    tools.stage_trusted_recipient_edit.schema,
    'stage_trusted_recipient_edit',
    ctx,
  ).safeParse({ name: SYNTHETIC_NAME, expectedVersion: 3 });
  if (ambiguousParse.success) {
    await tools.stage_trusted_recipient_edit.execute(ambiguousParse.data);
  }
  const serverCallsOnAmbiguousName = recording.calls.length;

  // A new recipient's address can only arrive through the review channel: the
  // staged payload carries the label and nothing that identifies a wallet.
  const createResult = await tools.stage_trusted_recipient.execute({ name: SYNTHETIC_NAME });
  statuses.push((createResult as { status: string }).status);
  wording.push({
    label: 'create with a synthetic label',
    status: (createResult as { status: string }).status,
    message: (createResult as { message: string }).message,
    claimsSuccess: claimsSuccessWording((createResult as { message: string }).message),
  });
  const staged = recording.calls.at(-1);
  const stagedKeys = Object.keys(staged ?? {});
  if (stagedKeys.some((key) => AUTHORITY_KEY.test(key))) {
    noAddressDetail.push('the staged server payload carries an authority field');
  }
  const createJson = JSON.stringify(createResult);
  if (BASE58_VALUE.test(createJson) || AUTHORITY_KEY.test(createJson)) {
    noAddressDetail.push('a name-only create returned an address-shaped value');
  }

  let publishedCardAddressIsNull = true;

  if (voice) {
    // Production voice port: the real refusal wording and the real card bytes.
    const proposal = {
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      userId: 'user-1',
      conversationId: 'conv-1',
      action: 'create' as const,
      contactId: null,
      contactVersion: null,
      address: null,
      previousAddress: null,
      revokedGrantIds: [],
      status: 'open' as const,
      expiresAt: '2030-01-01T00:00:00.000Z',
      publishedAt: null,
      payload: {},
    };
    const published: string[] = [];
    const actions = {
      stage: async () => proposal,
      markPublished: async () => proposal,
      read: async () => proposal,
      consumeInTransaction: async () => true,
    } as never;

    const unbound = createVoiceContactActions({
      actions,
      publish: async () => undefined,
      consume: async () => true,
    });
    const noVisualClient = (await unbound.stage({
      userId: 'user-1',
      conversationId: 'conv-1',
      origin: 'voice',
      action: 'create',
      name: SYNTHETIC_NAME,
    })) as { status: string; message: string };
    statuses.push(noVisualClient.status);
    wording.push({
      label: 'voice, no bound visual client',
      status: noVisualClient.status,
      message: noVisualClient.message,
      claimsSuccess: claimsSuccessWording(noVisualClient.message),
    });
    if (noVisualClient.message !== REVIEW_CHANNEL_MESSAGE) {
      ambiguousDetail.push('voice refusal did not request the review channel');
    }

    const unpublished = createVoiceContactActions({
      actions,
      boundParticipantIdentity: BOUND_IDENTITY,
      publish: async () => {
        throw new Error('synthetic transport failure');
      },
      consume: async () => true,
    });
    const notPublished = (await unpublished.stage({
      userId: 'user-1',
      conversationId: 'conv-1',
      origin: 'voice',
      action: 'create',
      name: SYNTHETIC_NAME,
    })) as { status: string; message: string };
    statuses.push(notPublished.status);
    wording.push({
      label: 'voice, card publication failed',
      status: notPublished.status,
      message: notPublished.message,
      claimsSuccess: claimsSuccessWording(notPublished.message),
    });

    const delivery = createVoiceContactActions({
      actions,
      boundParticipantIdentity: BOUND_IDENTITY,
      publish: async (payload) => {
        published.push(new TextDecoder().decode(payload.bytes));
      },
      consume: async () => true,
    });
    const stagedVoice = (await delivery.stage({
      userId: 'user-1',
      conversationId: 'conv-1',
      origin: 'voice',
      action: 'create',
      name: SYNTHETIC_NAME,
    })) as { status: string; message: string };
    statuses.push(stagedVoice.status);
    wording.push({
      label: 'voice, card published for review',
      status: stagedVoice.status,
      message: stagedVoice.message,
      claimsSuccess: claimsSuccessWording(stagedVoice.message),
    });

    const noWindow = (await delivery.confirm?.({
      userId: 'user-1',
      conversationId: 'conv-1',
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      source: 'voice',
    })) as { status: string; message: string };
    statuses.push(noWindow.status);
    wording.push({
      label: 'voice, confirmation without an open window',
      status: noWindow.status,
      message: noWindow.message,
      claimsSuccess: claimsSuccessWording(noWindow.message),
    });

    // The published card must carry no address: a label did not become one.
    const card = JSON.parse(published.at(-1) ?? '{}') as {
      address?: unknown;
      destinationIdentities?: string[];
    };
    publishedCardAddressIsNull = card.address === null;
    if (!publishedCardAddressIsNull) {
      noAddressDetail.push('the published card carried a name-derived address');
    }
    if (BASE58_VALUE.test(published.at(-1) ?? '')) {
      noAddressDetail.push('the published card contained an address-shaped value');
    }
  } else {
    // Text context: no server-owned port wired is the production fail-closed
    // path of the shared definition.
    const failClosed = surfaceTools(kind, baseContext());
    for (const name of LIFECYCLE_TOOLS) {
      const result = (await failClosed[name].execute(VALID_INPUT[name])) as {
        status: string;
        message: string;
      };
      statuses.push(result.status);
      wording.push({
        label: `text, ${name} without a server-owned port`,
        status: result.status,
        message: result.message,
        claimsSuccess: claimsSuccessWording(result.message),
      });
    }
  }

  const refusalWordingHonest = wording.every((entry) => !entry.claimsSuccess);
  const detectorControl = {
    affirmative: claimsSuccessWording('El destinatario quedó habilitado.'),
    denial: claimsSuccessWording('Todavía no está habilitado.'),
  };
  const vocabulary = [...policyReadinessSchema.options];
  const undeclaredStatuses = statuses.filter(
    (status) => !(DECLARED_PORT_STATUSES as readonly string[]).includes(status),
  );

  return {
    label: voice ? 'voice context (LiveKit realtime surface)' : 'text context (AI SDK surface)',
    context: kind,
    toolsExposed,
    missingTools: [...missingTools],
    argumentDiscipline,
    schemaKeepsAddressOut: noAddressDetail.every(
      (detail) => !detail.includes('schema exposes an authority field'),
    ),
    ambiguousNameAsksFirst: ambiguousDetail.length === 0 && serverCallsOnAmbiguousName === 0,
    ambiguousDetail,
    serverCallsOnAmbiguousName,
    noAddressFromName: noAddressDetail.length === 0,
    noAddressDetail,
    wording,
    refusalWordingHonest,
    detectorControl,
    noUnverifiedSuccessWording:
      refusalWordingHonest && detectorControl.affirmative && !detectorControl.denial,
    vocabulary,
    statusVocabularyExact:
      vocabulary.length === SPEC_STATUS_VOCABULARY.length &&
      SPEC_STATUS_VOCABULARY.every((value) => vocabulary.includes(value)) &&
      undeclaredStatuses.length === 0 &&
      !statuses.includes('applied'),
    undeclaredStatuses,
    publishedCardAddressIsNull,
  };
}

const data: Array<{ input: ContextKind }> = [
  { input: 'text' },
  { input: 'voice' },
];

evalite('Agent: recipient lifecycle (text and voice)', {
  data,
  task: (kind: ContextKind) => observe(kind),
  scorers: [
    {
      name: 'lifecycle_tools_exposed',
      scorer: ({ output }) => ({ score: output.toolsExposed ? 1 : 0 }),
    },
    {
      name: 'argument_discipline',
      scorer: ({ output }) => {
        const failures = output.argumentDiscipline.filter((entry) => !entry.ok);
        return { score: failures.length === 0 ? 1 : 0 };
      },
    },
    {
      name: 'no_address_from_name',
      scorer: ({ output }) => ({ score: output.noAddressFromName ? 1 : 0 }),
    },
    {
      name: 'ambiguous_name_asks_first',
      scorer: ({ output }) => ({ score: output.ambiguousNameAsksFirst ? 1 : 0 }),
    },
    {
      name: 'refusal_wording_honest',
      scorer: ({ output }) => ({ score: output.refusalWordingHonest ? 1 : 0 }),
    },
    {
      name: 'no_unverified_success_wording',
      scorer: ({ output }) => ({
        score: output.noUnverifiedSuccessWording ? 1 : 0,
      }),
    },
    {
      name: 'status_vocabulary_exact',
      scorer: ({ output }) => ({ score: output.statusVocabularyExact ? 1 : 0 }),
    },
  ],
});
