import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  voiceRoomTokenRequestSchema,
  type VoiceRoomTokenResponse,
} from "../contracts/http.js";
import type {
  RoomTokenInput,
  RoomTokenResult,
} from "../livekit/token-issuer.js";

export type LiveKitTokenIssuerDependency = {
  issue: (input: RoomTokenInput) => Promise<RoomTokenResult>;
};

export type RoomTokenAuthorization =
  | { ok: true; identity: string; roomName?: string }
  | { ok: false; reason: "unauthenticated" | "not_found" };

export type VoiceRoutesOptions = {
  liveKitTokenIssuer?: LiveKitTokenIssuerDependency;
  /**
   * PMU-020: authenticated room-token issuance. When provided (privy mode),
   * the route resolves identity, verifies conversation ownership under RLS and
   * derives the participant identity server-side. Denials never reach the issuer.
   */
  authorizeRoomToken?: (
    request: FastifyRequest,
    conversationId: string,
  ) => Promise<RoomTokenAuthorization>;
};

export async function registerVoiceRoutes(
  app: FastifyInstance,
  options: VoiceRoutesOptions = {},
): Promise<void> {
  app.post(
    "/v1/voice/room-token",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<VoiceRoomTokenResponse | void> => {
      const parsed = voiceRoomTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return reply.send({
          status: "error",
          message: parsed.error.message,
          code: "invalid_body",
        });
      }

      const issuer = options.liveKitTokenIssuer;
      if (!issuer) {
        reply.code(503);
        return reply.send({
          status: "error",
          message: "LiveKit room token issuance is not configured on this API.",
          code: "voice_token_unavailable",
        });
      }

      // PMU-020: in privy mode the caller must present a verified token and own
      // the conversation. Denials never reach the issuer; missing and foreign
      // conversations are indistinguishable (same 404).
      let identity: string | undefined;
      if (options.authorizeRoomToken) {
        const authorization = await options.authorizeRoomToken(
          request,
          parsed.data.conversationId,
        );
        if (!authorization.ok) {
          if (authorization.reason === "unauthenticated") {
            reply.code(401);
            return reply.send({
              status: "error",
              message: "Authentication required.",
              code: "no_autenticado",
            });
          }
          reply.code(404);
          return reply.send({
            status: "error",
            message: "Conversation not found.",
            code: "conversation_not_found",
          });
        }
        identity = authorization.identity;
      }

      try {
        // The issuer reads LiveKit credentials lazily per request, so the API
        // boots fine without LiveKit configuration and fails closed here.
        return await issuer.issue({ ...parsed.data, identity });
      } catch (error) {
        reply.code(503);
        return reply.send({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "LiveKit room token issuance failed.",
          code: "voice_token_unavailable",
        });
      }
    },
  );
}
