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
} from "../config/process.js";
import { getWalletAgentConfig } from "../agent/instructions.js";
import type {
  NativeDecisionRouter,
  NativeLiveKitAgentInput,
} from "./create-native-agent.js";
import { FinancialTaskRegistry } from "../conversations/financial-task-registry.js";
import { createAgentSession } from "./create-agent-session.js";
import {
  createBindingRpcHandler,
  createRoomConversationGate,
  RoomConversation,
} from "./room-conversation.js";
import {
  createWorkerDependencies,
  type WorkerDependencies,
} from "../runtime/dependencies.js";
import { getConfiguredRecipientMemoryRuntime } from "../memory/runtime.js";
import {
  VoiceLatencyMilestones,
  VoiceMetrics,
} from "../observability/voice-metrics.js";
import { routeNativeTextTurn } from "./native-text-turn-router.js";
import { canInspectVoiceMetrics } from "../config/privacy.js";
import { createVoiceMetricsInspectionHandler } from "./voice-metrics-inspection.js";

export { readLiveKitWorkerConfig } from "../config/process.js";
export type { LiveKitWorkerConfig } from "../config/process.js";

export function createLiveKitWorkerRuntime(input?: {
  dependencies?: WorkerDependencies;
  shutdownTimeoutMs?: number;
  voiceMetrics?: VoiceMetrics;
}) {
  let acceptingJobs = true;
  let closePromise: Promise<void> | undefined;
  const financialTasks =
    input?.dependencies?.financialTasks ?? new FinancialTaskRegistry();
  const shutdownTimeoutMs = input?.shutdownTimeoutMs ?? 10_000;
  const voiceMetrics = input?.voiceMetrics ?? new VoiceMetrics();
  return {
    financialTasks,
    voiceMetrics,
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
  config: LiveKitWorkerConfig,
  dependencies: WorkerDependencies,
  voiceMetrics: VoiceMetrics,
): Promise<void> {
  if (!config.publicKey)
    throw new Error("LiveKit worker requires LIVE_VOICE_BINDING_PUBLIC_KEY.");
  const latency = new VoiceLatencyMilestones(voiceMetrics, config.agentRuntime);
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  latency.connected();
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
  let nativeNarrationInterrupted = false;
  let voiceMetricsInspectionRegistered = false;
  const gate = createRoomConversationGate({
    conversation: roomConversation,
    startSession: async (binding) => {
      const native =
        config.agentRuntime === "native-livekit"
          ? await createNativeAgentInput(binding, dependencies, async (text) => {
            const events = await roomConversation.resolvePendingDecision(text);
            if (events) nativeNarrationInterrupted = false;
            return events;
          })
          : undefined;
      const created = createAgentSession({
        conversationService: dependencies.conversationService,
        binding,
        runtime: config.agentRuntime,
        ...(native ? { native } : {}),
      });
      unsubscribeRevisions = dependencies.financialTasks.subscribe((event) => {
        if (
          !event ||
          typeof event !== "object"
        )
          return;
        if (
          config.agentRuntime === "native-livekit" &&
          !nativeNarrationInterrupted &&
          (event as { type?: unknown }).type === "spoken-segment"
        ) {
          const text = (event as { text?: unknown }).text;
          if (typeof text === "string" && text.trim()) {
            created.session.say(text, { addToChatCtx: false });
          }
          return;
        }
        if ((event as { type?: unknown }).type !== "state-revision") return;
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
      sessionClosed = new Promise<void>((resolve) =>
        created.session.once(AgentSessionEventTypes.Close, () => resolve()),
      );
      created.session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
        if (event.isFinal) latency.finalTranscript();
      });
      created.session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
        if (event.metrics.type === "llm_metrics") {
          latency.firstTokenDuration(event.metrics.ttftMs);
        }
        if (event.metrics.type === "tts_metrics") {
          latency.firstAudioDuration(event.metrics.ttfbMs);
        }
      });
      created.session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
        if (event.item.type === "message" && event.item.role === "assistant") {
          latency.completed();
        }
      });
      await created.session.start({
        agent: created.agent,
        room: ctx.room,
        record: false,
        ...(config.agentRuntime === "native-livekit"
          ? {
            inputOptions: {
              textInputCallback: async (agentSession, event) => {
                await routeNativeTextTurn({
                  session: agentSession,
                  text: event.text,
                  resolvePendingDecision: (text) =>
                    roomConversation.resolvePendingDecision(text),
                  onDecisionRouted: () => {
                    nativeNarrationInterrupted = false;
                  },
                });
              },
            },
          }
          : {}),
      });
      if (config.agentRuntime === "native-livekit") {
        created.session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
          if (
            event.item.type !== "message" ||
            (event.item.role !== "user" && event.item.role !== "assistant")
          ) return;
          const text = event.item.textContent;
          if (!text) return;
          void dependencies.conversationService.appendNativeMessage({
            conversationId: binding.conversationId,
            userId: binding.userId,
            role: event.item.role,
            text,
          });
        });
      }
      agentParticipant.registerRpcMethod("interrupt_agent", async () => {
        const interruptedAt = Date.now();
        if (config.agentRuntime === "native-livekit") {
          nativeNarrationInterrupted = true;
        }
        await created.session?.interrupt({ force: true });
        latency.interrupted(interruptedAt);
        return JSON.stringify({ ok: true });
      });
      const inspectVoiceMetrics = createVoiceMetricsInspectionHandler({
        enabled: canInspectVoiceMetrics(),
        participantIdentity: participant.identity,
        metrics: voiceMetrics,
      });
      if (inspectVoiceMetrics) {
        agentParticipant.registerRpcMethod("get_voice_metrics", inspectVoiceMetrics);
        voiceMetricsInspectionRegistered = true;
      }
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
    if (voiceMetricsInspectionRegistered) {
      agentParticipant.unregisterRpcMethod("get_voice_metrics");
    }
    unsubscribeRevisions?.();
    await session?.close();
    await roomConversation.release();
  });
  await sessionClosed;
}

async function createNativeAgentInput(
  binding: { conversationId: string; userId: string },
  dependencies: WorkerDependencies,
  resolvePendingDecision?: NativeDecisionRouter,
): Promise<NativeLiveKitAgentInput> {
  const recipientMemory = getConfiguredRecipientMemoryRuntime();
  const snapshot = await dependencies.conversations.get(
    binding.userId,
    binding.conversationId,
  );
  if (!snapshot) {
    throw new Error("Bound conversation disappeared before native LiveKit startup.");
  }
  return {
    binding,
    snapshot,
    context: {
      conversationId: snapshot.id,
      userId: snapshot.userId,
      language: snapshot.language,
      config: getWalletAgentConfig(),
      session: {
        id: snapshot.id,
        messages: [...snapshot.messages],
        ...(snapshot.pendingTransfer
          ? { pendingTransfer: snapshot.pendingTransfer }
          : {}),
        ...(snapshot.recipientMemory
          ? { recipientMemory: snapshot.recipientMemory }
          : {}),
        ...(snapshot.transferResolutionState
          ? { transferResolutionState: snapshot.transferResolutionState }
          : {}),
        ...(snapshot.lastTransactionHash
          ? { lastTransactionHash: snapshot.lastTransactionHash }
          : {}),
      },
      wallet: dependencies.wallet,
      ...(recipientMemory
        ? { recipientMemory }
        : {}),
    },
    conversationService: dependencies.conversationService,
    ...(resolvePendingDecision ? { resolvePendingDecision } : {}),
  };
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
    await runJob(ctx, config, dependencies, runtime.voiceMetrics);
  },
});

export default agent;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readWorkerProcessConfig();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      wsURL: config.url,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      drainTimeout: config.shutdownTimeoutMs,
      shutdownProcessTimeout: config.shutdownTimeoutMs,
    }),
  );
}
