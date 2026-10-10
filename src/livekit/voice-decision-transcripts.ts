import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import type { VoiceDecisionGate } from "./voice-decision-gate.js";

/**
 * Attach final transcript evidence to the per-session gate only. This listener
 * intentionally has no ConversationService/RoomConversation dependency, so it
 * cannot create a second generic confirmation route.
 */
export function attachVoiceDecisionTranscripts(
  session: AgentSession,
  gate: VoiceDecisionGate,
  isAuthenticatedSpeaker: (speakerId: string | null) => boolean,
): () => void {
  const listener = (event: {
    transcript: string;
    isFinal: boolean;
    speakerId: string | null;
    createdAt: number;
  }) => {
    // Offer this incoming event to whichever window the gate currently holds —
    // transfer or contact (design §7.2: the arbiter owns "which kind may be
    // authorized right now"). The gate binds it to that window's own identity;
    // the transcript payload has no persisted-window identity of its own, so a
    // sentinel would either reject all real speech or let an old event cross a
    // window boundary. Requiring a transfer preview here dropped every contact
    // affirmative and made voice authorization of a trusted-recipient card
    // impossible (spec: "Explicit confirmation is authorized by final user
    // speech" — final transcript evidence is recorded independently of model
    // tool selection).
    gate.recordDecisionTranscript({
      text: event.transcript,
      isFinal: event.isFinal,
      authenticatedSpeaker: isAuthenticatedSpeaker(event.speakerId),
      createdAt: event.createdAt,
    });
  };
  session.on(AgentSessionEventTypes.UserInputTranscribed, listener);
  return () => session.off(AgentSessionEventTypes.UserInputTranscribed, listener);
}
