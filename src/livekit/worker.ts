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
  config: LiveKitWorkerConfig,
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
      const created = createAgentSession({
        conversationService: dependencies.conversationService,
        binding,
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
      wsURL: config.url,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      drainTimeout: config.shutdownTimeoutMs,
      shutdownProcessTimeout: config.shutdownTimeoutMs,
    }),
  );
}
