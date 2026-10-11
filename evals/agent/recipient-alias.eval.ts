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
  aliasRefusalMessage,
  createVoiceContactActions,
  REVIEW_CHANNEL_MESSAGE,
  type AliasResolution,
} from '../../src/livekit/contact-proposal-publication.js';

/**
 * Recipient-alias evals, text context and voice context (task 6.5; design
 * §2.3/§2.4/§4.2; `AGENTS.md` rule 2).
 *
 * Six claims are observed through the adapter each context actually uses — the
 * AI SDK surface (`toAiSdkTools`) for text, the LiveKit realtime surface
 * (`toLivekitRealtimeTools`) plus the production voice port
 * (`createVoiceContactActions`) for voice:
 *
 *   1. both contexts expose the recipient create tool **with `snsName`** and
 *      with no address key on its surface;
 *   2. a name is resolved **server-side, before any proposal** exists;
 *   3. a failed resolution produces a **typed refusal and no card**;
 *   4. the spoken sentence **asks about the screen and never reads an address
 *      aloud** (the address travels on the card, not in the sentence);
 *   5. an unsupported suffix is refused **with no fallback**;
 *   6. a name is **never accepted as a confirmation argument**.
 *
 * Deterministic and offline: no model, no network, no database, and no live RPC.
 * The transport is injected and the fixtures are the recorded devnet values —
 * `sophie.sns` was observed to resolve to
 * `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2`, which is the only address any
 * case below may ever name. A live resolution is slice U8's explicit step; an
 * eval that dialled devnet would be flaky by construction.
 *
 * The address detector carries its own positive control, so "no address was
 * spoken" can never pass vacuously.
 */

type ContextKind = 'text' | 'voice';

/** The recorded devnet fixture: `sophie.sns`. Never re-resolved here. */
const RECORDED_ADDRESS = '3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2';
const RECORDED_NAME = 'sophie.sns';

/**
 * The surface keys a create call may carry. `address`, `network`, `policyId`,
 * `signerId` and a cap are absent by construction, and this list is what proves
 * it rather than the narration.
 */
const ALLOWED_STAGE_KEYS = [
  'userId',
  'conversationId',
  'origin',
  'action',
  'name',
  'description',
  'snsName',
] as const;

const RESOLVED: AliasResolution = {
  status: 'resolved',
  snsName: RECORDED_NAME,
  address: RECORDED_ADDRESS,
  resolvedAt: '2026-01-01T00:00:00.000Z',
  resolver: 'sns/solana-devnet/v3',
  reverseDomain: null,
  reverseDomainState: 'none',
};

const PROPOSAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A base58-shaped value: what no spoken sentence may contain. */
const BASE58_VALUE = /[1-9A-HJ-NP-Za-km-z]{32,88}/u;
/** A key asserting wallet authority that no model boundary may accept. */
const AUTHORITY_KEY = /address|network|policy|signer|cap/iu;

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

type SurfaceTool = {
  schema: unknown;
  execute: (input: unknown) => Promise<unknown>;
};

/**
 * The tool surface as this context's adapter exposes it. The AI SDK wraps the
 * schema, so an unparseable wrapper falls back to the shared definition's zod
 * schema — the same object `tests/unit/agent-tool-parity.test.ts` proves the
 * adapters pass through unchanged.
 */
function surfaceTools(kind: ContextKind, ctx: WalletAgentContext): Record<string, SurfaceTool> {
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
    if (!adapter.execute) throw new Error(`text tool ${name} exposes no execute`);
    tools[name] = {
      schema: adapter.inputSchema ?? adapter.parameters ?? shared.get(name),
      // The AI SDK execute signature requires its execution options object.
      execute: (input) => adapter.execute!(input, {} as never),
    };
  }
  return tools;
}

function zodOf(schema: unknown): z.ZodType {
  if (schema && typeof (schema as z.ZodType).safeParse === 'function') {
    return schema as z.ZodType;
  }
  throw new Error('the surface exposed no parseable schema');
}

function issueCodes(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.code);
}

/** True when the sentence carries an address-shaped value. */
function readsAnAddressAloud(sentence: string): boolean {
  return BASE58_VALUE.test(sentence);
}

/** A recording stand-in for the server-owned proposal service (text context). */
function recordingPort(stageResult: unknown) {
  const stageCalls: unknown[] = [];
  const confirmCalls: unknown[] = [];
  const port: ContactActionPort = {
    stage: async (input) => {
      stageCalls.push(input);
      return stageResult as Awaited<ReturnType<ContactActionPort['stage']>>;
    },
    confirm: async (input) => {
      confirmCalls.push(input);
      return { status: 'refused_not_open', message: 'No hay ninguna acción abierta esperando tu confirmación.' };
    },
  };
  return { port, stageCalls, confirmCalls };
}

type OrderWritingPorts = {
  order: string[];
  cards: string[];
  stageCalls: unknown[];
  publishCalls: number;
};

/**
 * The production voice port over recording stand-ins for the proposal service
 * and the card transport. This is the only place the ordering claim is observed
 * in production code: `resolveAlias` records itself, so "resolution precedes the
 * proposal" is read off the real `stage` implementation, not off a narration.
 */
function voicePorts(resolution: AliasResolution | undefined): {
  port: ContactActionPort;
  recorded: OrderWritingPorts;
} {
  const order: string[] = [];
  const cards: string[] = [];
  const stageCalls: unknown[] = [];
  let publishCalls = 0;
  const boundIdentity = 'nana-eval-participant';

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

  const actions = {
    stage: async (input: unknown) => {
      order.push('stage');
      stageCalls.push(input);
      const staged = input as { address?: string; alias?: unknown };
      return {
        ...proposal,
        address: staged.address ?? null,
        payload: staged.alias ? { addressSource: 'sns' } : {},
      };
    },
    markPublished: async () => {
      order.push('markPublished');
      return proposal;
    },
    read: async () => proposal,
    consumeInTransaction: async () => true,
  } as never;

  const port = createVoiceContactActions({
    actions,
    ...(boundIdentity ? { boundParticipantIdentity: boundIdentity } : {}),
    ...(resolution
      ? {
          resolveAlias: async () => {
            order.push('resolve');
            return resolution;
          },
        }
      : {}),
    publish: async (payload: { bytes: Uint8Array }) => {
      order.push('publish');
      publishCalls += 1;
      cards.push(new TextDecoder().decode(payload.bytes));
    },
    consume: async () => true,
  });

  return { port, recorded: { order, cards, stageCalls, publishCalls } };
}

type RefusalObservation = {
  code: string;
  status: string;
  message: string;
  order: string[];
  stageCalls: number;
  publishCalls: number;
  typedCodePresent: boolean;
  honestRefusal: boolean;
  noCard: boolean;
  noFallbackAddress: boolean;
};

/**
 * One refused resolution through the production voice port: the code must be
 * spoken verbatim, no proposal may be staged, no card may be published, and the
 * name must never be turned into an address as a fallback.
 */
async function observeRefusal(code: string, name: string): Promise<RefusalObservation> {
  const { port, recorded } = voicePorts({
    status: 'refused',
    code,
    reason: 'eval_fixture',
  });
  const result = (await port.stage({
    userId: 'user-1',
    conversationId: 'conv-1',
    origin: 'voice',
    action: 'create',
    name: 'Sofía',
    snsName: name,
  })) as { status: string; message: string; code?: string };

  const expected = aliasRefusalMessage(code);
  return {
    code,
    status: result.status,
    message: result.message,
    order: [...recorded.order],
    stageCalls: recorded.stageCalls.length,
    publishCalls: recorded.publishCalls,
    typedCodePresent: result.code === code && result.message.includes(code),
    honestRefusal:
      result.status === 'alias_unresolved' &&
      result.message === expected &&
      result.message.includes('No voy a habilitar este destinatario'),
    noCard: recorded.publishCalls === 0 && recorded.stageCalls.length === 0,
    noFallbackAddress:
      !readsAnAddressAloud(result.message) &&
      !recorded.stageCalls.some((call) =>
        Object.keys(call as Record<string, unknown>).includes('address'),
      ),
  };
}

type Observation = {
  label: string;
  context: ContextKind;
  createToolExposesSnsName: boolean;
  createToolSurfaceHasNoAuthorityKey: boolean;
  snsNameArgumentAccepted: boolean;
  createPayloadParsed: boolean;
  addressArgumentRejected: boolean;
  resolutionPrecedesProposal: boolean;
  resolutionOrder: string[];
  serverStageCallsOnResolvedName: number;
  recordedStageKeys: string[];
  recordedStageCarriesAlias: boolean;
  refusalOrder: string[];
  refusal: RefusalObservation;
  unsupportedSuffix: RefusalObservation;
  spokenSentenceAsksForScreen: boolean;
  spokenSentencesCarryNoAddress: boolean;
  detectorControl: { addressSentence: boolean; cleanSentence: boolean };
  nameNeverAConfirmationArgument: boolean;
  confirmDetail: string[];
  failClosedWithoutServerPort: { status: string; readAnAddressAloud: boolean } | null;
  cardCarriesTheAddress: boolean | null;
};

async function observe(kind: ContextKind): Promise<Observation> {
  const voice = kind === 'voice';
  const recording = recordingPort({
    status: 'staged',
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    message: 'Revisá la dirección en la tarjeta y confirmá cuando esté lista.',
  });
  const ctx = baseContext(recording.port, voice);
  const tools = surfaceTools(kind, ctx);

  const create = tools.stage_trusted_recipient;
  const confirm = tools.confirm_trusted_recipient_action;
  const createSchema = zodOf(create.schema);
  const confirmSchema = zodOf(confirm.schema);

  const createJson = JSON.stringify(z.toJSONSchema(createSchema));
  const createToolExposesSnsName = /"snsName"/u.test(createJson);
  const createToolSurfaceHasNoAuthorityKey = !AUTHORITY_KEY.test(createJson);

  const snsNameArgumentAccepted = createSchema.safeParse({
    name: 'Sofía',
    snsName: RECORDED_NAME,
  }).success;  const addressArgumentRejected =
    !createSchema.safeParse({ name: 'Sofía', address: RECORDED_ADDRESS }).success &&
    issueCodes(createSchema.safeParse({ name: 'Sofía', address: RECORDED_ADDRESS })).includes(
      'unrecognized_keys',
    );

  // Claim 2, text context: the model hands the server the NAME and nothing else.
  // The call is gated on the same schema the runtime gates it on, so a surface
  // that stopped accepting `snsName` fails the ordering claim too.
  const createPayloadParsed = createSchema.safeParse({
    name: 'Sofía',
    snsName: RECORDED_NAME,
  });
  if (createPayloadParsed.success) await create.execute(createPayloadParsed.data);
  const recordedStageKeys = Object.keys(
    (recording.stageCalls.at(-1) ?? {}) as Record<string, unknown>,
  );
  const stagedCall = (recording.stageCalls.at(-1) ?? {}) as Record<string, unknown>;

  // Claim 6: a name is never a confirmation argument, on the schema and on the
  // executed call the model would make with one.
  const confirmDetail: string[] = [];
  const confirmByName = confirmSchema.safeParse({
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    name: 'Sofía',
  });
  if (confirmByName.success || !issueCodes(confirmByName).includes('unrecognized_keys')) {
    confirmDetail.push('the confirmation schema accepted a name');
  }
  const confirmByAliasName = confirmSchema.safeParse({
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    snsName: RECORDED_NAME,
  });
  if (confirmByAliasName.success || !issueCodes(confirmByAliasName).includes('unrecognized_keys')) {
    confirmDetail.push('the confirmation schema accepted an snsName');
  }
  await confirm.execute({ proposalId: PROPOSAL_ID, proposalVersion: 1, name: 'Sofía' });
  const recordedConfirm = (recording.confirmCalls.at(-1) ?? {}) as Record<string, unknown>;
  if (Object.keys(recordedConfirm).some((key) => key === 'name' || key === 'snsName')) {
    confirmDetail.push('the executed confirmation carried a name to the server port');
  }
  const nameNeverAConfirmationArgument = confirmDetail.length === 0;

  // Claim 5: an unsupported suffix is refused with no fallback, on both contexts
  // through the same server-owned taxonomy.
  const unsupportedSuffix = await observeRefusal('NOMBRE_NO_SOPORTADO', 'sofia');

  let resolutionPrecedesProposal = false;
  let resolutionOrder: string[] = [];
  let serverStageCallsOnResolvedName = 0;
  let recordedStageCarriesAlias = false;
  let refusalOrder: string[] = [];
  let refusal: RefusalObservation;
  let spokenSentenceAsksForScreen = false;
  let spokenSentencesCarryNoAddress = false;
  let cardCarriesTheAddress: boolean | null = null;

  if (voice) {
    // Production voice port: the real ordering, the real card bytes.
    const resolved = voicePorts(RESOLVED);
    const staged = (await resolved.port.stage({
      userId: 'user-1',
      conversationId: 'conv-1',
      origin: 'voice',
      action: 'create',
      name: 'Sofía',
      snsName: RECORDED_NAME,
    })) as { status: string; message: string };
    resolutionOrder = [...resolved.recorded.order];
    serverStageCallsOnResolvedName = resolved.recorded.stageCalls.length;
    const stagedPayload = (resolved.recorded.stageCalls.at(-1) ?? {}) as Record<string, unknown>;
    recordedStageCarriesAlias =
      stagedPayload.address === RECORDED_ADDRESS && stagedPayload.alias !== undefined;

    // Claim 2: the name was resolved before the proposal row was staged, which
    // is the ordering the production `stage` implementation establishes.
    resolutionPrecedesProposal =
      resolutionOrder[0] === 'resolve' &&
      resolutionOrder.indexOf('resolve') < resolutionOrder.indexOf('stage') &&
      resolutionOrder.indexOf('stage') < resolutionOrder.indexOf('publish') &&
      resolutionOrder.indexOf('publish') < resolutionOrder.indexOf('markPublished');

    const card = JSON.parse(resolved.recorded.cards.at(-1) ?? '{}') as { address?: unknown };
    cardCarriesTheAddress = card.address === RECORDED_ADDRESS;

    const spoken = [staged.message, REVIEW_CHANNEL_MESSAGE];
    spokenSentenceAsksForScreen =
      staged.message.includes('tarjeta') &&
      staged.message.includes('confirmá') &&
      REVIEW_CHANNEL_MESSAGE.includes('pantalla');
    spokenSentencesCarryNoAddress = spoken.every(
      (sentence) => !readsAnAddressAloud(sentence),
    );

    const refused = await observeRefusal('NOMBRE_NO_ENCONTRADO', 'noexiste.sns');
    refusal = refused;
    refusalOrder = refused.order;
  } else {
    // Text context: there is exactly one production construction of the voice
    // port (`src/livekit/worker.ts`), and `createRealtimeTools` hands the same
    // port to both surfaces. The ordering claim therefore lives in that one
    // implementation, and the text surface's own observable is the surface it
    // uses: the model can supply a name and cannot supply or receive an address.
    const refusalRecording = recordingPort({
      status: 'alias_unresolved',
      code: 'NOMBRE_NO_ENCONTRADO',
      message: aliasRefusalMessage('NOMBRE_NO_ENCONTRADO'),
    });
    const textTools = surfaceTools('text', baseContext(refusalRecording.port));
    const textRefusal = (await textTools.stage_trusted_recipient.execute({
      name: 'Sofía',
      snsName: 'noexiste.sns',
    })) as { status: string; code?: string; message: string };
    const serverReviewed = await observeRefusal('NOMBRE_NO_ENCONTRADO', 'noexiste.sns');
    refusal = {
      ...serverReviewed,
      status: textRefusal.status,
      message: textRefusal.message,
      typedCodePresent: textRefusal.code === 'NOMBRE_NO_ENCONTRADO',
      honestRefusal:
        textRefusal.status === 'alias_unresolved' &&
        textRefusal.message === aliasRefusalMessage('NOMBRE_NO_ENCONTRADO'),
      noCard: textRefusal.status === 'alias_unresolved',
      noFallbackAddress: !readsAnAddressAloud(textRefusal.message),
    };

    spokenSentenceAsksForScreen = REVIEW_CHANNEL_MESSAGE.includes('pantalla');
    spokenSentencesCarryNoAddress =
      !readsAnAddressAloud(refusal.message) &&
      !readsAnAddressAloud(REVIEW_CHANNEL_MESSAGE);
    resolutionPrecedesProposal =
      stagedCall.snsName === RECORDED_NAME && !('address' in stagedCall);
    resolutionOrder = ['text:name-to-server'];
    serverStageCallsOnResolvedName = recording.stageCalls.length;
    recordedStageCarriesAlias = stagedCall.snsName === RECORDED_NAME;
  }

  // The fail-closed production path of the shared definition, for both contexts.
  const failClosedTool = surfaceTools(kind, baseContext())[
    'stage_trusted_recipient'
  ];
  const failClosed = (await failClosedTool.execute({ name: 'Sofía' })) as {
    status: string;
    message: string;
  };

  return {
    label: voice
      ? 'voice context (LiveKit realtime surface + production port)'
      : 'text context (AI SDK surface)',
    context: kind,
    createToolExposesSnsName,
    createToolSurfaceHasNoAuthorityKey,
    snsNameArgumentAccepted,
    createPayloadParsed: createPayloadParsed.success,
    addressArgumentRejected,
    resolutionPrecedesProposal,
    resolutionOrder,
    serverStageCallsOnResolvedName,
    recordedStageKeys: [...recordedStageKeys],
    recordedStageCarriesAlias,
    refusalOrder,
    refusal,
    unsupportedSuffix,
    spokenSentenceAsksForScreen,
    spokenSentencesCarryNoAddress,
    detectorControl: {
      addressSentence: readsAnAddressAloud(`Le mandé a ${RECORDED_ADDRESS}?`),
      cleanSentence: readsAnAddressAloud('Revisá la tarjeta en la pantalla.'),
    },
    nameNeverAConfirmationArgument,
    confirmDetail,
    failClosedWithoutServerPort: {
      status: failClosed.status,
      readAnAddressAloud: readsAnAddressAloud(failClosed.message),
    },
    cardCarriesTheAddress,
  };
}

const data: Array<{ input: ContextKind }> = [{ input: 'text' }, { input: 'voice' }];

evalite('Agent: recipient alias (text and voice)', {
  data,
  task: (kind: ContextKind) => observe(kind),
  scorers: [
    {
      name: 'create_tool_exposes_sns_name_and_no_authority_key',
      scorer: ({ output }) => ({
        score:
          output.createToolExposesSnsName &&
          output.createToolSurfaceHasNoAuthorityKey &&
          output.snsNameArgumentAccepted &&
          output.addressArgumentRejected &&
          output.recordedStageKeys.every((key) =>
            (ALLOWED_STAGE_KEYS as readonly string[]).includes(key),
          )
          ? 1
          : 0,
      }),
    },
    {
      name: 'name_resolved_server_side_before_any_proposal',
      scorer: ({ output }) => ({
        score:
          output.resolutionPrecedesProposal &&
          output.createPayloadParsed &&
          output.serverStageCallsOnResolvedName > 0 &&
          output.recordedStageCarriesAlias
            ? 1
            : 0,
      }),
    },
    {
      name: 'failed_resolution_is_typed_and_cardless',
      scorer: ({ output }) => ({
        score:
          output.refusal.typedCodePresent &&
          output.refusal.honestRefusal &&
          output.refusal.noCard
            ? 1
            : 0,
      }),
    },
    {
      name: 'spoken_sentence_never_reads_an_address',
      scorer: ({ output }) => ({
        // The positive control must fire, or a "clean" sentence proves nothing.
        score:
          output.detectorControl.addressSentence &&
          !output.detectorControl.cleanSentence &&
          output.spokenSentenceAsksForScreen &&
          output.spokenSentencesCarryNoAddress &&
          (output.failClosedWithoutServerPort?.readAnAddressAloud === false)
            ? 1
            : 0,
      }),
    },
    {
      name: 'unsupported_suffix_refused_without_fallback',
      scorer: ({ output }) => ({
        score:
          output.unsupportedSuffix.typedCodePresent &&
          output.unsupportedSuffix.honestRefusal &&
          output.unsupportedSuffix.noCard &&
          output.unsupportedSuffix.noFallbackAddress
            ? 1
            : 0,
      }),
    },
    {
      name: 'name_never_a_confirmation_argument',
      scorer: ({ output }) => ({ score: output.nameNeverAConfirmationArgument ? 1 : 0 }),
    },
  ],
});
