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
    // Bind this incoming event to the exact preview active at listener time.
    // The transcript payload has no persisted-preview identity of its own, so
    // a sentinel would either reject all real speech or let an old event cross
    // a preview boundary.
    const previewId = gate.currentPreviewId();
    if (!previewId) return;
    gate.recordTranscript({
      previewId,
      text: event.transcript,
      isFinal: event.isFinal,
      authenticatedSpeaker: isAuthenticatedSpeaker(event.speakerId),
      createdAt: event.createdAt,
    });
  };
  session.on(AgentSessionEventTypes.UserInputTranscribed, listener);
  return () => session.off(AgentSessionEventTypes.UserInputTranscribed, listener);
}
