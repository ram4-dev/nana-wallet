import { Agent, AgentSession, inference } from "@livekit/agents";
import { TTS as ElevenLabsTTS } from "@livekit/agents-plugin-elevenlabs";
import type { LiveKitAgentRuntime } from "../config/process.js";
import { readVoiceProviderConfig } from "../config/privacy.js";
import type {
  ConversationEvent,
  WalletConversationService,
} from "../conversations/service.js";
import {
  buildWalletAgentInstructions,
  getWalletAgentConfig,
} from "../agent/instructions.js";
import {
  WalletConversationLLM,
  type WalletConversationBinding,
} from "./wallet-conversation-llm.js";
import {
  createNativeLiveKitAgent,
  type NativeLiveKitAgentInput,
} from "./create-native-agent.js";

export type AgentSessionDependencies = {
  conversationService: WalletConversationService;
  binding: WalletConversationBinding;
  runtime?: LiveKitAgentRuntime;
  native?: NativeLiveKitAgentInput;
  onEvent?: (event: ConversationEvent) => Promise<void> | void;
};

function createTTS(voiceProvider: ReturnType<typeof readVoiceProviderConfig>) {
  if (process.env.LIVEKIT_TTS_PROVIDER === "inference") {
    return new inference.TTS({
      model: process.env.LIVEKIT_TTS_MODEL ?? "cartesia/sonic-3",
      voice:
        process.env.LIVEKIT_TTS_VOICE ??
        "5c5ad5e7-1020-476b-8b91-fdcbe9cc313c",
      language: "es",
    });
  }
  return new ElevenLabsTTS({
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
    model: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
    languageCode: "es",
    enableLogging: voiceProvider.elevenLabsEnableLogging,
  });
}

export function createAgentSession(dependencies: AgentSessionDependencies) {
  const voiceProvider = readVoiceProviderConfig();
  const sessionOptions = {
    stt: new inference.STT({
      model: "deepgram/nova-3:multi",
      modelOptions: { mip_opt_out: true },
    }),
    tts: createTTS(voiceProvider),
    turnHandling: {
      turnDetection: new inference.TurnDetector({ version: "v1" }),
      preemptiveGeneration: { enabled: false },
      interruption: { enabled: true },
    },
  };
  if (dependencies.runtime === "native-livekit") {
    if (!dependencies.native) {
      throw new Error("Native LiveKit runtime requires a bound conversation snapshot.");
    }
    const agent = createNativeLiveKitAgent(dependencies.native);
    return { session: new AgentSession(sessionOptions), agent };
  }
  const llm = new WalletConversationLLM(
    dependencies.conversationService,
    dependencies.binding,
    dependencies.onEvent,
  );
  const agent = new Agent({
    instructions: buildWalletAgentInstructions(getWalletAgentConfig(), "es"),
    llm,
  });
  const session = new AgentSession({
    ...sessionOptions,
    llm,
  });

  return { session, agent };
}
