import { Agent, AgentSession, inference } from "@livekit/agents";
import { TTS as ElevenLabsTTS } from "@livekit/agents-plugin-elevenlabs";
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

export type AgentSessionDependencies = {
  conversationService: WalletConversationService;
  binding: WalletConversationBinding;
  onEvent?: (event: ConversationEvent) => Promise<void> | void;
};

export function createAgentSession(dependencies: AgentSessionDependencies) {
  const voiceProvider = readVoiceProviderConfig();
  const llm = new WalletConversationLLM(
    dependencies.conversationService,
    dependencies.binding,
    dependencies.onEvent,
  );
  const agent = new Agent({
    instructions: buildWalletAgentInstructions(getWalletAgentConfig()),
    llm,
  });
  const session = new AgentSession({
    stt: new inference.STT({
      model: "deepgram/nova-3:multi",
      modelOptions: { mip_opt_out: true },
    }),
    llm,
    tts: new ElevenLabsTTS({
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
      model: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
      languageCode: "es",
      enableLogging: voiceProvider.elevenLabsEnableLogging,
    }),
    turnHandling: {
      turnDetection: new inference.TurnDetector({ version: "v1" }),
      preemptiveGeneration: { enabled: false },
      interruption: { enabled: true },
    },
  });

  return { session, agent };
}
