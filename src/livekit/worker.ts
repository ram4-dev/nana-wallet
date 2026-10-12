import "dotenv/config";
import { fileURLToPath } from "node:url";
import {
  AgentSessionEventTypes,
  AutoSubscribe,
  cli,
  defineAgent,
  type JobContext,
  ServerOptions,
} from "@livekit/agents";
import {
  readLiveKitWorkerConfig,
  readWorkerProcessConfig,
  type LiveKitWorkerConfig,
  type WorkerProcessConfig,
} from "../config/process.js";
import { resolveDefaultAgentName } from "../config/livekit.js";
import { FinancialTaskRegistry } from "../conversations/financial-task-registry.js";
import { createWalletConversationService } from "../conversations/service.js";
import { getWalletAgentConfig } from "../agent/instructions.js";
import { getConfiguredRecipientMemoryService } from "../memory/runtime.js";
import {
  createRecipientContactMutationPort,
  type ContactEmbedder,
} from "../memory/contact-policy-adapter.js";
import { createContactsEmbedder } from "../api/contacts.js";
import { createAgentSession } from "./create-agent-session.js";
import { createRealtimeTools } from "./realtime-tools/index.js";
import { createVoiceDecisionGate } from "./voice-decision-gate.js";
import { createConfirmationArbiter } from "../conversations/confirmation-arbiter.js";
import { ContactActionService } from "../wallet/policy/contact-actions.js";
import { createAliasResolver, createAliasReverifier, createVoiceContactActions } from "./contact-proposal-publication.js";
import { createSnsResolver, type SnsResolver } from "../wallet/sns/resolver.js";
import { createSnsTransport, readSnsTransportConfig } from "../wallet/sns/transport.js";
import {
  createRecipientPolicyService,
  createUnavailablePolicyApplyPort,
  SOLANA_POLICY_NETWORK,
} from "../wallet/policy/service.js";
import { RecipientPolicyRepository } from "../wallet/policy/repository.js";
import { isCancellation, isConfirmation } from "./resolution-phrases.js";
import type { ConversationLanguage } from "../conversations/language.js";
import { attachVoiceDecisionTranscripts } from "./voice-decision-transcripts.js";
import {
  createBindingRpcHandler,
  createRoomConversationGate,
  RoomConversation,
} from "./room-conversation.js";
import {
  createWorkerDependencies,
  type WorkerDependencies,
} from "../runtime/dependencies.js";
import { walletChainFamilyForNetwork } from "../wallet/chain-family.js";
import {
  bindWalletForUser,
  type WalletForUser,
} from "../wallet/user-wallet.js";

/**
 * The worker process's SNS resolver, built through the transport's own config
 * reader so `SNS_RPC_URL` has one definition (design §1.4). A transport that
 * cannot be built (an empty endpoint) yields `null`, and the caller reports the
 * re-verification as unavailable instead of pretending it happened.
 */
function createWorkerSnsResolver(): SnsResolver | null {
  try {
    return createSnsResolver({
      transport: createSnsTransport(readSnsTransportConfig()),
      network: SOLANA_POLICY_NETWORK,
    });
  } catch {
    return null;
  }
}

/**
 * The embedder the proposal path writes recipients through.
 *
 * ONE instance per process, the same shape `src/memory/runtime.ts` uses for the
 * memory service: `EmbeddingService` loads its pipeline lazily, so a per-session
 * instance would load the model once per voice session. It is the SAME factory
 * the HTTP contacts surface uses, so the recipient projection has one embedder
 * definition rather than two.
 */
let proposalContactEmbedder: ContactEmbedder | undefined;
function proposalEmbedder(): ContactEmbedder {
  proposalContactEmbedder ??= createContactsEmbedder();
  return proposalContactEmbedder;
}

/**
 * The service that applies a confirmed proposal's contact mutation (design flow
 * (c), task 4.5).
 *
 * Its collaborators are deliberately the HTTP contacts surface's, so a voice
 * confirmation and a screen confirmation produce the same rows: the contact
 * projection writes through the same adapter (over a repository and the shared
 * embedder), and the active grants are read from the same ledger projection.
 *
 * The apply port is `unavailable` for the same reason `src/server.ts` wires it
 * that way for `/v1/contacts`: this process records the desired revision and its
 * intent, and the reconciler loop the worker already runs applies it. Wiring a
 * second signed apply path into the voice construct would duplicate the
 * sidecar/signer wiring and could apply a revision no other surface observed.
 */
function createWorkerProposalApplicationService(dependencies: {
  database: WorkerDependencies["database"];
  contacts: WorkerDependencies["contacts"];
}) {
  const repository = new RecipientPolicyRepository(dependencies.database);
  return createRecipientPolicyService({
    database: dependencies.database,
    repository,
    contacts: createRecipientContactMutationPort({
      contacts: dependencies.contacts,
      embedder: proposalEmbedder(),
    }),
    listActiveGrants: (walletId, userId, chain) =>
      dependencies.database.withUserTransaction(userId, (transaction) =>
        repository.listActiveLedgerGrants(
          userId,
          walletId,
          chain,
          transaction,
        ),
      ),
    // No alias resolver: the ONLY mutation this service performs is the one a
    // proposal describes, and that address was already resolved by the server and
    // persisted on the row (the proposal's `frozenAlias`). A resolver here would
    // be a second resolution path with no caller.
    provider: createUnavailablePolicyApplyPort(
      "provider_unavailable: the voice worker records the desired revision and its intent; the reconciler loop this same process runs applies it.",
    ),
  });
}

export function bindLiveKitWalletForUser(
  walletForUser: WalletForUser,
  userId: string,
  network?: string | (() => string),
) {
  /**
   * Legacy: when a fixed network hint is provided, use the old single-net binding
   * (kept for tests that assert chain-family selection). Production voice binding
   * now omits this parameter so each tool call resolves chain family from its
   * requested network (see spec: unified-agent-tools, D3).
   */
  if (network !== undefined) {
    return bindWalletForUser(walletForUser, userId, () =>
      walletChainFamilyForNetwork(
        typeof network === "function" ? network() : network,
      ),
    );
  }
  // Per-call resolution: each method derives the chain family from the method's
  // network argument so the voice agent can read balances on any supported
  // network without the session being locked to one.
  const defaultFamily = () =>
    walletChainFamilyForNetwork(getWalletAgentConfig().network);
  const familyFor = (
    net: string | undefined,
  ): import("../wallet/chain-family.js").WalletChainFamilyHint =>
    !net || net === "" ? defaultFamily : () => walletChainFamilyForNetwork(net);
  const resolve = (family?: import("../wallet/chain-family.js").WalletChainFamilyHint) =>
    walletForUser(userId, family);
  type WP = import("../wallet/provider.js").WalletProvider;
  return {
    id: "privy-user-scoped",
    mode: "live" as const,
    health: async (ctx) => {
      try {
        return await (await resolve(defaultFamily())).health(ctx);
      } catch (err) {
        return {
          status: "unavailable" as const,
          reason: err instanceof Error ? err.message : "Wallet is unavailable.",
        };
      }
    },
    listNetworks: async () => {
      // Union of both chain families so the multi-network get_balance
      // discovers every network the user can hold (see unified-agent-tools).
      const hinted = await (await resolve(defaultFamily())).listNetworks();
      const other = await (await resolve("solana")).listNetworks().catch(() => []);
      const seen = new Set<string>();
      return [...hinted, ...other].filter(({ network }) => {
        if (seen.has(network)) return false;
        seen.add(network);
        return true;
      });
    },
    listTokens: async (net) => (await resolve(familyFor(net))).listTokens(net),
    getAddress: async (ctx) => (await resolve(familyFor(ctx.network))).getAddress(ctx),
    getBalance: async (q) => (await resolve(familyFor(q.network))).getBalance(q),
    getHistory: async (q) => (await resolve(familyFor(q.network))).getHistory(q),
    previewTransfer: async (r) => (await resolve(familyFor(r.network))).previewTransfer(r),
    broadcastTransfer: async (r) => (await resolve(familyFor(r.network))).broadcastTransfer(r),
    waitForFinality: async (r, signal) => {
      const tx = "transaction" in r ? r.transaction : r;
      return (await resolve(familyFor(tx.network))).waitForFinality(r, signal);
    },
    close: async () => {},
  } as WP;
}

export { readLiveKitWorkerConfig } from "../config/process.js";
export type { LiveKitWorkerConfig } from "../config/process.js";

/**
 * How long the process may keep running AFTER its shutdown steps settled.
 *
 * The steps below are bounded, so this point is always reachable — but reaching it
 * does not by itself end the process: a job that logged `job exiting` and
 * `disconnected from room` went on handling audio, creating speech handles and
 * running tool calls, and survived its own SIGTERM. Something kept the event loop
 * alive, so the runtime's exit path never completed and the job stayed resident.
 *
 * A grace window is enough for anything legitimately still in flight, and an
 * `unref`'d timer is the right instrument: it fires while the loop is alive (which
 * is exactly the hung case) and never holds the loop open itself (so a clean exit
 * is unaffected).
 */
const SHUTDOWN_EXIT_GRACE_MS = 2_000;

/**
 * Runs a teardown step, but never waits longer than `timeoutMs` for it.
 *
 * A shutdown step that hangs must not be able to keep a job process alive. Both
 * callers used to `await` unbounded, and the cost was observed live: stale job
 * processes accumulated at 127-886 MB each, competing for four cores, while the
 * live session's speech stalled 2-7 s between deciding to answer and the first
 * audio frame. The step is best-effort by contract — the money-safety drain that
 * must be waited for is `financialTasks.drain`, which is bounded and runs first.
 */
async function boundedShutdownStep(
  label: string,
  timeoutMs: number,
  work: () => Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[voice-worker] ${label} did not finish within ${timeoutMs}ms during shutdown; continuing.`,
          );
          resolve();
        }, timeoutMs);
        // Advisory only: it must not be the reason a process stays up.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createLiveKitWorkerRuntime(input?: {
  dependencies?: WorkerDependencies;
  shutdownTimeoutMs?: number;
}) {
  let acceptingJobs = true;
  let closePromise: Promise<void> | undefined;
  const financialTasks =
    input?.dependencies?.financialTasks ?? new FinancialTaskRegistry();
  const shutdownTimeoutMs = input?.shutdownTimeoutMs ?? 10_000;
  return {
    financialTasks,
    get acceptingJobs() {
      return acceptingJobs;
    },
    async close() {
      if (closePromise) return closePromise;
      acceptingJobs = false;
      closePromise = (async () => {
        await financialTasks.drain({ timeoutMs: shutdownTimeoutMs });
        // Bounded like the drain above. An unbounded `close()` was the second way
        // a job process could outlive its shutdown: the pool close is what releases
        // the last handles, so if it hangs the event loop stays alive and the
        // process is never reaped.
        await boundedShutdownStep("dependency close", shutdownTimeoutMs, async () => {
          await input?.dependencies?.close();
        });
      })();
      return closePromise;
    },
  };
}

/**
 * The language a voice session starts in.
 *
 * WHY THE PERSISTED LANGUAGE AND NOT A DETECTED ONE
 * ------------------------------------------------
 * The greeting is the session's FIRST turn and it is generated before the user
 * has said anything, so at this point there is no speech to detect a language
 * from. The conversation's own persisted language is the only evidence that
 * exists, and it is what `service.ts` already threads into every text turn
 * (`HandleMessageOptions.language` -> `WalletAgentContext.language`). The voice
 * session now starts from the same value.
 *
 * `'en'` is the fallback for the same reason `detectConversationLanguage`
 * defaults to it, and a read that fails must not cost the user their session:
 * the greeting, the read-back, the decision gate and the financial-task
 * subscription all live behind this line. Once the user speaks, the session's own
 * instructions order the model to follow the user's language, and the text path
 * persists the language it detects for the next session.
 */
async function readVoiceSessionLanguage(
  conversations: WorkerDependencies["conversations"],
  binding: { conversationId: string; userId: string },
): Promise<ConversationLanguage> {
  try {
    const snapshot = await conversations.get(
      binding.userId,
      binding.conversationId,
    );
    return snapshot?.language === "es" ? "es" : "en";
  } catch (error) {
    console.error(
      "[live-voice] conversation language read failed:",
      error instanceof Error ? error.message : error,
    );
    return "en";
  }
}

async function runJob(
  ctx: JobContext,
  config: WorkerProcessConfig,
  dependencies: WorkerDependencies,
): Promise<void> {
  if (!config.publicKey)
    throw new Error("LiveKit worker requires LIVE_VOICE_BINDING_PUBLIC_KEY.");
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  const participant = await ctx.waitForParticipant();
  const roomConversation = new RoomConversation({
    publicKey: config.publicKey,
    conversations: dependencies.conversations,
    service: dependencies.conversationService,
  });
  const agentParticipant = ctx.agent;
  if (!agentParticipant)
    throw new Error("LiveKit agent participant is unavailable.");

  let session: ReturnType<typeof createAgentSession>["session"] | undefined;
  let sessionClosed: Promise<void> | undefined;
  let unsubscribeRevisions: (() => void) | undefined;
  const gate = createRoomConversationGate({
    conversation: roomConversation,
    startSession: async (binding) => {
      const confirmationArbiter = createConfirmationArbiter({
        isConfirmation,
        isCancellation,
        onObservation: (observation) => console.info(JSON.stringify({
          type: "voice_confirmation_gate", pid: process.pid, ...observation,
        })),
      });
      const voiceDecisionGate = createVoiceDecisionGate({
        isConfirmation,
        isCancellation,
        arbiter: confirmationArbiter,
        userId: binding.userId,
        conversationId: binding.conversationId,
        onObservation: (observation) => console.info(JSON.stringify({
          type: "voice_confirmation_gate", pid: process.pid, ...observation,
        })),
      });
      const memoryService = getConfiguredRecipientMemoryService();
      const contactActionService = new ContactActionService(dependencies.database);
      // The contact mutation a confirmation runs (design flow (c), task 4.5),
      // built per binding like every other user-scoped seam in this block and
      // wired to the SAME collaborators the HTTP contacts surface uses.
      const proposalApplicationService = createWorkerProposalApplicationService({
        database: dependencies.database,
        contacts: dependencies.contacts,
      });
      // The same SNS seam the HTTP alias route uses, built once per session from
      // the transport's own reader (design §1.4): no second definition of the
      // endpoint's precedence. A transport that cannot be built yields `null`, and
      // the re-verification is then reported as unavailable rather than emulated.
      const snsResolver = createWorkerSnsResolver();
      const contactActions = createVoiceContactActions({
        actions: contactActionService,
        // BOTH alias arms come from the ONE resolver above, and both are present
        // exactly when it could be built.
        //
        // The stage arm resolves the name the user SPOKE before any proposal row
        // exists: it is the only source of the address on the alias path, so
        // without it every spoken `.sns` name fails closed with a typed refusal
        // and the alias flow can never reach a card at all.
        //
        // The confirm arm re-resolves the name the displayed version was frozen
        // from, immediately before the persisted consume, and supersedes when the
        // address moved. Without it a confirmation of an alias proposal records
        // `reverify:'unavailable'` instead of checking the name (never a silent
        // "verified").
        ...(snsResolver
          ? {
              resolveAlias: createAliasResolver({ resolver: snsResolver }),
              reverifyAlias: createAliasReverifier({
                actions: contactActionService,
                resolver: snsResolver,
              }),
            }
          : {}),
        // The unpublished-orphan cleanup. `stage` writes the row and only then
        // delivers the card, and a delivery that fails deliberately leaves the
        // row behind — but the one-open-per-conversation partial unique index has
        // no expiry predicate, so without this cleanup a torn card could never be
        // retried, in this session or any later one. This seam is the worker's own
        // retry path, so the worker is the caller that owns it; the predicate
        // (`published_at IS NULL`) lives in the service, which is what keeps a row
        // whose card WAS delivered untouched.
        supersedeUnpublished: ({ userId, conversationId }) =>
          contactActionService.supersedeUnpublished(userId, conversationId),
        // The bound authenticated participant. `RoomConversation.bind` already
        // rejected a caller whose identity differs from `binding.sub`, so this is
        // the only participant a card may be delivered to. A room without it has
        // no bound visual client, and permission creation is refused.
        ...(ctx.room.remoteParticipants.has(participant.identity)
          ? { boundParticipantIdentity: participant.identity }
          : {}),
        publish: (payload) =>
          agentParticipant.publishData(payload.bytes, {
            reliable: payload.reliable,
            topic: payload.topic,
            destination_identities: payload.destinationIdentities,
          }),
        arbiter: confirmationArbiter,
        // The persisted authority for which proposal is open. The review channel
        // runs over HTTP in the backend process, so after a paste creates a new
        // immutable version this is the only way the worker can learn its handle:
        // it is what makes a stale refusal actionable instead of a dead end.
        currentOpenProposal: async ({ userId, conversationId }) => {
          const open = await contactActionService.readOpen(userId, conversationId);
          return open
            ? { proposalId: open.proposalId, proposalVersion: open.proposalVersion }
            : null;
        },
        // THE ONE TRANSACTION (design flow (c), task 4.5). The proposal's CAS
        // consume and the contact mutation it describes commit together, or
        // neither does: zero rows on the CAS rolls the whole transaction back, so
        // a confirmation can never mark the row `consumed` and save nothing.
        //
        // It used to be the bare CAS in its own transaction here, and a comment
        // claimed the mutation ran in `beforeCommit`. It did not, in this process
        // or in any other: that is the defect this replaced.
        //
        // The confirm-time re-verification is NOT inside this transaction, and
        // must not move here: design S10 pins it, outside every transaction,
        // after the affirmative and immediately before this call.
        applyProposal: ({ userId, conversationId, proposalId, proposalVersion, origin, tool, reverify }) =>
          proposalApplicationService.consumeContactProposal(userId, {
            proposalId,
            proposalVersion,
            consumedBySession: conversationId,
            consumedByTool: tool,
            origin,
            // Recorded in the SAME statement as the consume, so the row is never
            // observable as open-with-an-outcome (design §4.4/S11).
            ...(reverify ? { reverify } : {}),
          }),
      });
      const wallet = dependencies.walletForUser
        ? bindLiveKitWalletForUser(
            dependencies.walletForUser,
            binding.userId,
          )
        : dependencies.wallet;
      // REVIEW FIX V3 (voice path): the voice service is built per binding so its
      // recipient memory runtime scopes to `binding.sub` — never the demo tenant.
      // It shares the repository, wallet, and financialTasks with the worker so all
      // paths (voice tool, text transcript, touch button) arbitrate on the same
      // claim and emit revisions through the same frontend data topic.
      const voiceService = createWalletConversationService({
        conversations: dependencies.conversations,
        wallet,
        ...(dependencies.walletForUser ? { walletForUser: dependencies.walletForUser } : {}),
        ...(memoryService
          ? { memory: { userId: binding.userId, service: memoryService } }
          : {}),
        financialTasks: dependencies.financialTasks,
        // DGC-6: the voice binding shares the worker's grant-creation seam, so
        // a grant created through voice goes through the same ledger composition.
        grantCreator: dependencies.grantCreator,
        contextRenewal: dependencies.contextRenewal,
      });
      const tools = createRealtimeTools({
        conversationId: binding.conversationId,
        userId: binding.userId,
        wallet,
        service: voiceService,
        conversations: dependencies.conversations,
        ...(memoryService ? { recipientMemory: memoryService } : {}),
        voiceDecisionGate,
        confirmationArbiter,
        contactActions,
        // The worker's own contact read (built in `createWorkerDependencies` from
        // the same database), so `list_contacts` on the voice tool surface
        // enumerates exactly what `GET /v1/contacts` enumerates.
        contacts: dependencies.contacts,
      });
      // The language this session OPENS in: the conversation's persisted one,
      // resolved before the greeting is dispatched (see
      // `readVoiceSessionLanguage`).
      const languageForSession = await readVoiceSessionLanguage(
        dependencies.conversations,
        binding,
      );
      const created = createAgentSession({
        tools,
        language: languageForSession,
      });
      unsubscribeRevisions = dependencies.financialTasks.subscribe((event) => {
        if (
          !event ||
          typeof event !== "object" ||
          (event as { type?: unknown }).type !== "state-revision"
        )
          return;
        const revision = (event as { revision?: unknown }).revision;
        if (typeof revision !== "number") return;
        void agentParticipant.publishData(
          new TextEncoder().encode(
            JSON.stringify({
              type: "conversation_state_changed",
              conversationId: binding.conversationId,
              revision,
            }),
          ),
          {
            reliable: true,
            topic: "conversation_state_changed",
            destination_identities: [participant.identity],
          },
        );
      });
      session = created.session;
      const detachVoiceDecisionTranscripts = attachVoiceDecisionTranscripts(
        created.session,
        voiceDecisionGate,
        (speakerId) => {
        const participantIsSoleSpeaker =
          ctx.room.remoteParticipants.size === 1 &&
          ctx.room.remoteParticipants.has(participant.identity);
        return speakerId
          ? speakerId === participant.identity && participantIsSoleSpeaker
          : participantIsSoleSpeaker;
        },
      );
      created.session.once(AgentSessionEventTypes.Close, () => {
        detachVoiceDecisionTranscripts();
      });
      sessionClosed = new Promise<void>((resolve) =>
        created.session.once(AgentSessionEventTypes.Close, () => resolve()),
      );
      await created.session.start({
        agent: created.agent,
        room: ctx.room,
        record: false,
      });
      // S1 proactive onboarding: Nani opens the session before the user speaks.
      // Best effort on purpose — a greeting that cannot be dispatched must never
      // break the bind/start path, the preview read-back, the decision gate or the
      // financial-task subscription. `speakGreeting` is at-most-once per session,
      // so no reconnect/resume of this session can re-greet.
      try {
        created.speakGreeting();
      } catch (error) {
        console.error(
          "[live-voice] proactive greeting failed:",
          error instanceof Error ? error.message : error,
        );
      }
      agentParticipant.registerRpcMethod("interrupt_agent", async () => {
        await created.session?.interrupt({ force: true });
        return JSON.stringify({ ok: true });
      });
    },
  });
  let resolveBinding!: (result: Awaited<ReturnType<typeof gate.bind>>) => void;
  const bindingAccepted = new Promise<Awaited<ReturnType<typeof gate.bind>>>(
    (resolve) => {
      resolveBinding = resolve;
    },
  );

  agentParticipant.registerRpcMethod(
    "bind_conversation",
    createBindingRpcHandler({
      gate,
      workerId: ctx.workerId,
      onResult: resolveBinding,
    }),
  );

  const binding = await bindingAccepted;
  if (!binding.ok) {
    agentParticipant.unregisterRpcMethod("bind_conversation");
    await roomConversation.release();
    ctx.shutdown(`conversation binding failed: ${binding.code}`);
    return;
  }
  const leaseRenewal = setInterval(() => {
    void roomConversation.renew().catch(() => undefined);
  }, 10_000);
  ctx.addShutdownCallback(async () => {
    clearInterval(leaseRenewal);
    agentParticipant.unregisterRpcMethod("bind_conversation");
    agentParticipant.unregisterRpcMethod("interrupt_agent");
    unsubscribeRevisions?.();
    // BOTH BOUNDED, and that is the fix for a real defect rather than tidiness.
    // They were awaited unbounded, and a live session showed what that costs: the
    // job logged `job exiting` and `disconnected from room`, then kept handling
    // audio, creating new speech handles and running tool calls — the closing
    // websocket never resolved, the process never exited, and the supervisor saw
    // `job shutdown is taking too much time` followed by `job is unresponsive`.
    // Stale job processes accumulated holding 127-886 MB each, competing for four
    // cores, and the LIVE session's speech stalled 2-7 s between deciding to
    // answer and the first audio frame. A shutdown step that does not finish must
    // not be able to keep the process alive.
    await boundedShutdownStep("session close", config.shutdownTimeoutMs, async () => {
      await session?.close();
    });
    await boundedShutdownStep("conversation release", config.shutdownTimeoutMs, async () => {
      await roomConversation.release();
    });
    // Last, and only after the steps above settled: everything money-related has
    // already drained in `runtime.close`, so nothing else is pending on this
    // process. See SHUTDOWN_EXIT_GRACE_MS for why the process needs to be told to
    // end rather than left to the runtime's exit path.
    setTimeout(() => process.exit(0), SHUTDOWN_EXIT_GRACE_MS).unref();
  });
  await sessionClosed;
}

const agent = defineAgent({
  entry: async (ctx) => {
    const config = readWorkerProcessConfig();
    const dependencies = createWorkerDependencies();
    const runtime = createLiveKitWorkerRuntime({
      dependencies,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
    ctx.addShutdownCallback(runtime.close);
    await runJob(ctx, config, dependencies);
  },
});

export default agent;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readWorkerProcessConfig();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      // The room token issuer dispatches explicitly by agent name
      // (token-issuer.ts → RoomConfiguration.agents, default
      // LIVEKIT_AGENT_NAME ?? 'nani-agent'). The worker must register under
      // the SAME name or explicit dispatch targets no registered worker.
      // resolveDefaultAgentName is the shared source both sides use.
      agentName: resolveDefaultAgentName(),
      wsURL: config.url,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      drainTimeout: config.shutdownTimeoutMs,
      shutdownProcessTimeout: config.shutdownTimeoutMs,
    }),
  );
}
