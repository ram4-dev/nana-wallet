import {
  AccessToken,
  RoomConfiguration,
  type TokenVerifier,
} from "livekit-server-sdk";
import type { LiveKitTokenIssuerConfig } from "../config/livekit.js";

export type RoomTokenInput = {
  conversationId: string;
  agentName?: string;
  /** Server-resolved participant identity (PMU-020); always the authenticated user. */
  identity?: string;
};

export type RoomTokenResult = {
  serverUrl: string;
  participantToken: string;
  roomName: string;
};

export type IssuerConfig = LiveKitTokenIssuerConfig & { identity: string };

/**
 * Issues a short-lived, single-room browser token for the LiveKit room bound to
 * a conversation. The room name and identity are server-owned: the browser only
 * sends the conversation id. Grants are join/publish/subscribe only — no admin
 * grants, so the token can never control or record the room. The embedded
 * RoomConfiguration dispatches the agent into the room automatically when the
 * browser connects.
 */
export async function issueRoomToken(
  config: IssuerConfig,
  input: RoomTokenInput,
): Promise<RoomTokenResult> {
  if (!config.identity) {
    throw new Error(
      "A resolved participant identity is required to issue LiveKit room tokens.",
    );
  }

  const roomName = `nani-${input.conversationId}`;
  const agentName = input.agentName ?? config.defaultAgentName;

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: config.identity,
    ttl: config.roomTokenTtlSeconds,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  token.roomConfig = new RoomConfiguration({
    agents: [{ agentName }],
  });

  return {
    // The browser must reach the server through a URL that is valid from
    // its own network position (loopback in local dev), not necessarily
    // the server-side registration URL.
    serverUrl: config.browserUrl,
    participantToken: await token.toJwt(),
    roomName,
  };
}
