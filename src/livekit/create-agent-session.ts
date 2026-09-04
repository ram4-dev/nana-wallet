import { Agent, AgentSession, inference } from "@livekit/agents";
import {
  STT as ElevenLabsSTT,
  TTS as ElevenLabsTTS,
} from "@livekit/agents-plugin-elevenlabs";
import type { LiveKitAgentRuntime } from "../config/process.js";
import {
  readElevenLabsApiKey,
  readVoiceProviderConfig,
} from "../config/privacy.js";
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
  return new ElevenLabsTTS({
    apiKey: readElevenLabsApiKey(),
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
    model: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
    languageCode: "es",
    enableLogging: voiceProvider.elevenLabsEnableLogging,
  });
}

export function createAgentSession(dependencies: AgentSessionDependencies) {
  const voiceProvider = readVoiceProviderConfig();
  const sessionOptions = {
    stt: new ElevenLabsSTT({
      apiKey: readElevenLabsApiKey(),
      model: "scribe_v2_realtime",
      languageCode: "es",
      serverVad: { vadSilenceThresholdSecs: 0.5 },
      enableLogging: voiceProvider.elevenLabsEnableLogging,
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
