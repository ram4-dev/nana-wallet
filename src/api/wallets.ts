import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  activateWalletPermissionInputSchema,
  balancesDataSchema,
  currentWalletResponseSchema,
  enrollmentCompleteInputSchema,
  enrollmentCompleteResponseSchema,
  enrollmentPrepareInputSchema,
  enrollmentPreparationResponseSchema,
  walletChainFamilySchema,
  walletPermissionResponseSchema,
  walletRevokeInputSchema,
  walletRevokeResponseSchema,
  walletSyncResponseSchema,
  type BalancesData,
  type CurrentWalletResponse,
  type EnrollmentCompleteResponse,
  type EnrollmentPreparationResponse,
  type WalletChainFamily,
  type WalletPermissionResponse,
  type WalletRevokeResponse,
  type WalletSyncResponse,
} from "../contracts/http.js";
import { WalletBalancesError } from "../wallet/balances.js";
import { PolicyCompositionRefusalError } from "../wallet/policy/errors.js";
import {
  GrantNotFoundError,
  GrantValidationError,
  WalletConflictError,
  WalletNotFoundError,
  WalletOwnershipError,
  WalletUnavailableError,
  type EmbeddedWalletService,
} from "../wallet/embedded.js";
import { PrivyIdentityError } from "../auth/privy-identity.js";
import { TransferRejectedError } from "../wallet/transfer-errors.js";
import type { WalletBalancesService } from "../wallet/balances.js";

export type WalletsRouteDependencies = {
  resolveUserId(request: FastifyRequest): Promise<string>;
  wallet: EmbeddedWalletService;
  /** Read-only personal balances service (WP-003..WP-009), separate from signing. */
  balances: WalletBalancesService;
};

export type WalletApiError = {
  ok: false;
  error: { code: string; message: string };
};

type WalletReply = {
  code(status: number): { send(payload: WalletApiError): void };
};

/**
 * Reads the optional `chain` query selector. Absent keeps the legacy `arc`
 * default; an unsupported value is a 422 DATOS_INVALIDOS (never a 500).
 */
function chainFromQuery(query: unknown):
  | { ok: true; chain: WalletChainFamily | undefined }
  | { ok: false; message: string } {
  const raw = (query as { chain?: unknown } | undefined)?.chain;
  if (raw === undefined) return { ok: true, chain: undefined };
  const parsed = walletChainFamilySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Cadena inválida: solo se acepta 'arc' o 'solana'.",
    };
  }
  return { ok: true, chain: parsed.data };
}

function errorReply(reply: WalletReply, error: unknown): WalletApiError {
  // Identity failures map to 401 via the server-wide handler, never 500.
  if (error instanceof PrivyIdentityError) throw error;
  if (error instanceof GrantValidationError) {
    reply.code(422);
    return {
      ok: false,
      error: { code: "GRANT_INVALIDO", message: error.message },
    };
  }
  if (error instanceof WalletOwnershipError) {
    reply.code(422);
    return {
      ok: false,
      error: { code: "PROPIEDAD_NO_VERIFICADA", message: error.message },
    };
  }
  if (error instanceof TransferRejectedError) {
    reply.code(422);
    return {
      ok: false,
      error: { code: "TRANSFERENCIA_RECHAZADA", message: error.message },
    };
  }
  if (error instanceof WalletConflictError) {
    reply.code(409);
    return {
      ok: false,
      error: { code: "WALLET_CONFLICTO", message: error.message },
    };
  }
  // Design §3.3/§3.4: a writer path that cannot route through the single policy
  // composer must fail VISIBLY. Enrollment used to obtain a policy directly and
  // can no longer be handed one, so the stop is reported as the typed
  // configuration conflict it is instead of a generic 500 — never a success.
  if (error instanceof PolicyCompositionRefusalError) {
    reply.code(409);
    return {
      ok: false,
      error: { code: "CONFLICTO_POLITICA", message: error.message },
    };
  }
  if (error instanceof WalletUnavailableError) {
    reply.code(503);
    return {
      ok: false,
      error: { code: "WALLET_NO_DISPONIBLE", message: error.message },
    };
  }
  if (
    error instanceof WalletNotFoundError ||
    error instanceof GrantNotFoundError
  ) {
    reply.code(404);
    return {
      ok: false,
      error: { code: "WALLET_NO_ENCONTRADA", message: error.message },
    };
  }
  reply.code(500);
  return {
    ok: false,
    error: { code: "ERROR_INTERNO", message: "Unexpected wallet error." },
  };
}

/**
 * /v1/wallets (PEW-001..013): authenticated, user-scoped embedded wallet
 * surface. Identity failures are 401 via the server-wide handler; foreign and
 * missing resources are indistinguishable 404. Responses expose readable limits
 * and readiness — never signing credentials or raw transactions (PEW-011).
 */
export async function registerWalletsRoutes(
  app: FastifyInstance,
  dependencies: WalletsRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/wallets/current",
    async (
      request: FastifyRequest<{ Querystring: unknown }>,
      reply,
    ): Promise<{ ok: true; data: CurrentWalletResponse } | WalletApiError> => {
      const chain = chainFromQuery(request.query);
      if (!chain.ok) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: chain.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const wallet = await dependencies.wallet.getCurrentWallet(
          userId,
          chain.chain,
        );
        return { ok: true, data: currentWalletResponseSchema.parse(wallet) };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post(
    "/v1/wallets/sync",
    async (
      request,
      reply,
    ): Promise<{ ok: true; data: WalletSyncResponse } | WalletApiError> => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const result = await dependencies.wallet.syncWallet(userId);
        return { ok: true, data: walletSyncResponseSchema.parse(result) };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.get(
    "/v1/wallets/current/permission",
    async (
      request: FastifyRequest<{ Querystring: unknown }>,
      reply,
    ): Promise<
      { ok: true; data: WalletPermissionResponse } | WalletApiError
    > => {
      const chain = chainFromQuery(request.query);
      if (!chain.ok) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: chain.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const permission = await dependencies.wallet.getPermission(
          userId,
          chain.chain,
        );
        return {
          ok: true,
          data: walletPermissionResponseSchema.parse(permission),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  // PEW-013: explicit activation — the SERVER reads back the effective
  // provider policy before marking active; the client cannot assert
  // enrollment success. Live mode fails closed without credentials.
  app.post(
    "/v1/wallets/current/permission",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<
      { ok: true; data: WalletPermissionResponse } | WalletApiError
    > => {
      const parsed = activateWalletPermissionInputSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const permission = await dependencies.wallet.activatePermission(
          userId,
          parsed.data.recipients,
          parsed.data.chain,
        );
        return {
          ok: true,
          data: walletPermissionResponseSchema.parse(permission),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  // PEW-014: user-authenticated signer enrollment — prepare step. The backend
  // creates (or reuses) a policy and persists a `pending` grant; the browser
  // then adds the signer. The response never exposes secret/key material.
  app.post(
    "/v1/wallets/current/permission/prepare",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<
      { ok: true; data: EnrollmentPreparationResponse } | WalletApiError
    > => {
      const parsed = enrollmentPrepareInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const preparation = await dependencies.wallet.preparePermission(
          userId,
          parsed.data.recipients,
        );
        return {
          ok: true,
          data: enrollmentPreparationResponseSchema.parse(preparation),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  // PEW-014: signer enrollment — complete step. The server reads back the
  // wallet and proves owner + policy attachment before activating; a client
  // success flag can NEVER activate. Not-verified results surface honest
  // observed fields and keep the grant `pending`.
  app.post(
    "/v1/wallets/current/permission/complete",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<
      { ok: true; data: EnrollmentCompleteResponse } | WalletApiError
    > => {
      const parsed = enrollmentCompleteInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const verification = await dependencies.wallet.completePermission(
          userId,
          parsed.data.walletId,
          parsed.data.chain,
        );
        return {
          ok: true,
          data: enrollmentCompleteResponseSchema.parse(verification),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post(
    "/v1/wallets/current/permission/revoke",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<{ ok: true; data: WalletRevokeResponse } | WalletApiError> => {
      const parsed = walletRevokeInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const result = await dependencies.wallet.revokePermission(
          userId,
          parsed.data.chain,
        );
        return { ok: true, data: walletRevokeResponseSchema.parse(result) };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  // WP-003..WP-007: personal SOL balance. Authenticated, owner-resolved
  // and read-only: no owner/chain/token selection from query or body, and
  // private no-store caching on every response shape.
  app.get(
    "/v1/wallets/current/balances",
    async (
      request: FastifyRequest<{ Body: unknown; Querystring: unknown }>,
      reply,
    ): Promise<{ ok: true; data: BalancesData } | WalletApiError> => {
      reply.header("Cache-Control", "private, no-store");
      const hasQuery =
        request.url.includes("?") &&
        new URL(request.url, "http://localhost").search.length > 1;
      if (hasQuery || request.body !== undefined) {
        reply.code(400);
        return {
          ok: false,
          error: {
            code: "INVALID_QUERY",
            message: "Esta consulta no acepta parámetros.",
          },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const balances = await dependencies.balances.getBalances(userId);
        return { ok: true, data: balancesDataSchema.parse(balances) };
      } catch (error) {
        // Identity failures map to 401 via the server-wide handler.
        if (error instanceof PrivyIdentityError) throw error;
        if (error instanceof WalletBalancesError) {
          reply.code(error.status);
          return {
            ok: false,
            error: { code: error.code, message: error.message },
          };
        }
        reply.code(500);
        return {
          ok: false,
          error: {
            code: "ERROR_INTERNO",
            message: "Unexpected balance error.",
          },
        };
      }
    },
  );
}
