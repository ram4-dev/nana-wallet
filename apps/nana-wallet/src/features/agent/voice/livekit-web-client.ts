import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";

import { api } from "@/lib/api";

import type { VoiceClient } from "./voice-client";

export type LiveKitWebClientOptions = {
  getConversationId?: () => string | null;
  onConversationBound?: (conversationId: string) => void;
  onRevision?: (revision: number) => void;
  onAgentState?: (state: string) => void;
  onConnectionLost?: () => void;
  onReconnected?: () => void;
  room?: Room;
  url?: string;
  token?: string;
  agentIdentity?: string;
};

function readConfig(options: LiveKitWebClientOptions) {
  const url = options.url ?? import.meta.env["VITE_LIVEKIT_URL"];
  const token = options.token ?? import.meta.env["VITE_LIVEKIT_TOKEN"];
  const agentIdentity =
    options.agentIdentity ?? import.meta.env["VITE_LIVEKIT_AGENT_IDENTITY"] ?? "nani-agent";
  if (!url || !token) throw new Error("Live voice is not configured for this browser.");
  return { url, token, agentIdentity };
}

function parseAgentState(participant: RemoteParticipant, onAgentState?: (state: string) => void) {
  const state = participant.attributes["lk.agent.state"];
  if (state) onAgentState?.(state);
}

export function createLiveKitWebClient(options: LiveKitWebClientOptions = {}): VoiceClient {
  let room: Room | undefined;
  let bound = false;
  let boundConversationId: string | undefined;
  let manuallyDisconnected = false;
  let reconnecting = false;
  const attachedAudio = new Set<HTMLMediaElement>();

  const handleTrackSubscribed = (track: { kind: Track.Kind; attach: () => HTMLMediaElement }) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.setAttribute("aria-hidden", "true");
    document.body.appendChild(element);
    attachedAudio.add(element);
  };

  const handleTrackUnsubscribed = (track: { detach: () => HTMLMediaElement[] }) => {
    for (const element of track.detach()) {
      attachedAudio.delete(element);
      element.remove();
    }
  };

  function stopAgentAudio() {
    for (const element of attachedAudio) element.remove();
    attachedAudio.clear();
  }

  async function connect() {
    const config = readConfig(options);
    const binding = await api.createLiveVoiceBinding(options.getConversationId?.() ?? undefined);
    room = options.room ?? new Room({ adaptiveStream: true, dynacast: true });
    manuallyDisconnected = false;
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    room.on(RoomEvent.Reconnecting, () => {
      if (reconnecting) return;
      reconnecting = true;
      stopAgentAudio();
      void room?.localParticipant.setMicrophoneEnabled(false);
      options.onConnectionLost?.();
    });
    room.on(RoomEvent.Reconnected, () => {
      reconnecting = false;
      // The hook restores the previous preference after it refreshes the
      // canonical conversation state. Reconnect must not replay microphone
      // audio before that state is current.
      options.onReconnected?.();
    });
    room.on(RoomEvent.Disconnected, () => {
      stopAgentAudio();
      if (!manuallyDisconnected && !reconnecting) options.onConnectionLost?.();
    });
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== "conversation_state_changed") return;
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as {
          conversationId?: unknown;
          revision?: unknown;
        };
        if (event.conversationId !== boundConversationId) return;
        if (typeof event.revision === "number") options.onRevision?.(event.revision);
      } catch {
        // Ignore malformed room data. Canonical state remains available through Fastify.
      }
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (changed["lk.agent.state"])
        parseAgentState(participant as RemoteParticipant, options.onAgentState);
    });
    try {
      await room.connect(config.url, config.token, { autoSubscribe: true });
      const agent = await waitForAgent(room, config.agentIdentity);
      parseAgentState(agent, options.onAgentState);
      const response = await room.localParticipant.performRpc({
        destinationIdentity: config.agentIdentity,
        method: "bind_conversation",
        payload: JSON.stringify({ bindingToken: binding.bindingToken }),
        responseTimeout: 10_000,
      });
      const result = JSON.parse(response) as {
        ok?: boolean;
        conversationId?: string;
        revision?: number;
        code?: string;
      };
      if (!result.ok || !result.conversationId || typeof result.revision !== "number") {
        throw new Error(
          result.code === "conversation_already_live"
            ? "This conversation is already open."
            : "Live voice could not be bound.",
        );
      }
      bound = true;
      boundConversationId = result.conversationId;
      options.onConversationBound?.(result.conversationId);
      options.onRevision?.(result.revision);
      return { conversationId: result.conversationId, revision: result.revision };
    } catch (error) {
      manuallyDisconnected = true;
      reconnecting = false;
      await room.disconnect();
      room = undefined;
      throw error;
    }
  }

  return {
    connect,
    setMicrophoneEnabled: async (enabled) => {
      if (!room || !bound) throw new Error("Live voice is not bound.");
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    interruptAgentSpeech: async () => {
      if (!room || !bound) return;
      const config = readConfig(options);
      await room.localParticipant.performRpc({
        destinationIdentity: config.agentIdentity,
        method: "interrupt_agent",
        payload: "{}",
        responseTimeout: 5_000,
      });
    },
    pauseForLifecycle: async () => {
      if (room && bound) await room.localParticipant.setMicrophoneEnabled(false);
    },
    disconnect: async () => {
      manuallyDisconnected = true;
      bound = false;
      boundConversationId = undefined;
      stopAgentAudio();
      await room?.disconnect();
      room = undefined;
    },
  };
}

async function waitForAgent(room: Room, identity: string): Promise<RemoteParticipant> {
  const current = room.remoteParticipants.get(identity);
  if (current) return current;
  return new Promise<RemoteParticipant>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      room.off(RoomEvent.ParticipantConnected, onConnected);
      reject(new Error("Nani did not join the LiveKit room."));
    }, 10_000);
    const onConnected = (participant: RemoteParticipant) => {
      if (participant.identity !== identity) return;
      window.clearTimeout(timeout);
      room.off(RoomEvent.ParticipantConnected, onConnected);
      resolve(participant);
    };
    room.on(RoomEvent.ParticipantConnected, onConnected);
  });
}
