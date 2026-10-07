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
import { createAgentSession } from "./create-agent-session.js";
import { createRealtimeTools } from "./realtime-tools/index.js";
import { createVoiceDecisionGate } from "./voice-decision-gate.js";
import { isCancellation, isConfirmation } from "./resolution-phrases.js";
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
import {
  bindWalletForUser,
  walletChainFamilyForNetwork,
  type WalletForUser,
} from "../wallet/privy-user-provider.js";

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
  ): import("../wallet/privy-user-provider.js").WalletChainFamilyHint =>
    !net || net === "" ? defaultFamily : () => walletChainFamilyForNetwork(net);
  const resolve = (family?: import("../wallet/privy-user-provider.js").WalletChainFamilyHint) =>
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
        await input?.dependencies?.close();
      })();
      return closePromise;
    },
  };
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
  const voiceDecisionGate = createVoiceDecisionGate({ isConfirmation, isCancellation });
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
      const memoryService = getConfiguredRecipientMemoryService();
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
        speakPreview: async (text) => {
          if (!session) return { interrupted: true };
          const speech = session.say(text, { allowInterruptions: true });
          await speech.waitForPlayout();
          return { interrupted: speech.interrupted };
        },
      });
      const created = createAgentSession({ tools });
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
    await session?.close();
    await roomConversation.release();
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
