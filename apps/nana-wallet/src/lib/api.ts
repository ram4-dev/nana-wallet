import type {
  AgendaEvent,
  AgentAudioTranscription,
  AgentAudioTranscriptionInput,
  ApiEnvelope,
  Bill,
  BillPaymentIntentInput,
  BillStatus,
  ConfirmableIntent,
  Contact,
  CreateAgendaEventInput,
  CreateContactInput,
  CreateConversationResponse,
  CurrentWalletResponse,
  BalancesData,
  EndLiveConversationResponse,
  ErrCode,
  MeResponse,
  MovementsPage,
  PaymentIntent,
  PaymentResult,
  RevealedCbu,
  ConversationTurnResult,
  ConversationState,
  LiveVoiceBindingResponse,
  TransferIntentInput,
  UpdateContactInput,
  VoiceRoomTokenResponse,
  ActivateWalletPermissionInput,
  WalletActivationResponse,
  CreateDelegatedGrantRequest,
  CreateDelegatedGrantResponse,
  ListDelegatedGrantsResponse,
  RevokeDelegatedGrantResponse,
  WalletPermissionResponse,
  WalletRevokeResponse,
  WalletSummary,
  WalletBalanceResponse,
  WalletHistoryResponse,
  NotificationFeedItem,
  WalletSyncResponse,
  EnrollmentCompleteInput,
  EnrollmentCompleteResponse,
  EnrollmentPrepareInput,
  EnrollmentPreparationResponse,
} from "./api-types";
import { beginRequest, finishRequest, isSessionCurrent } from "./session-isolation";

export const FALLBACK_ERROR_MESSAGE = "Algo no salió bien. Probá de nuevo en un ratito.";
const TOKEN_STORAGE_KEY = "nana-wallet-token";

/**
 * Único lugar donde se decide qué texto ve el usuario cuando algo falla.
 * El front nunca traduce códigos de error: muestra el message que mandó el backend,
 * y solo cae al fallback cuando no hay ninguno.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "wallet_not_ready") {
      return "Tu billetera de Privy todavía se está preparando. Probá de nuevo en un momento.";
    }
    if (error.code === "wallet_feature_unavailable") {
      return "Esta información de tu billetera todavía no está disponible.";
    }
    if (error.code === "wallet_config_error" || error.code === "wallet_unavailable") {
      return "No pudimos consultar tu billetera de Privy. Probá de nuevo en un momento.";
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return FALLBACK_ERROR_MESSAGE;
}

/** true cuando no sabemos si la operación se ejecutó del lado del servidor. */
export function isAmbiguousError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.ambiguous;
}

const TOKEN_STORAGE_KEY_DEMO = TOKEN_STORAGE_KEY;

/**
 * Injectable source of the Authorization bearer token.
 *
 * In Privy mode the app injects a source backed by `usePrivy().getAccessToken()`
 * (which refreshes the session automatically when it is about to expire). The
 * module stays testable: tests inject a fake source with fake fetch.
 */
export type ApiTokenSource = {
  getToken: () => Promise<string | null>;
  /** Optional hook called on a 401 so the source can drop a stale cached token. */
  invalidate?: () => void | Promise<void>;
};

let tokenSource: ApiTokenSource | null = null;
let legacyConfiguredToken: string | null = null;

/** Sets (or clears) the bearer token source used by every API request. */
export function setApiTokenSource(source: ApiTokenSource | null) {
  tokenSource = source;
}

/**
 * Backwards-compatible static token setter. Prefer `setApiTokenSource` for the
 * Privy flow; this remains useful for tests and the demo path.
 */
export function setApiToken(token: string | null) {
  legacyConfiguredToken = token;
}

function identityProviderMode(): "demo" | "privy" | undefined {
  return import.meta.env["VITE_IDENTITY_PROVIDER"] as "demo" | "privy" | undefined;
}

/** true only in the user-authenticated Privy flow (demo is always false). */
export function isPrivyIdentityProvider(): boolean {
  return identityProviderMode() === "privy";
}

function usesDemoToken(): boolean {
  // The backend defaults IDENTITY_PROVIDER to "demo" when unset; mirror that so
  // local dev works without a token source. Only "privy" is fail-closed.
  return identityProviderMode() !== "privy";
}

export class ApiError extends Error {
  readonly code: ErrCode;
  readonly field: string | undefined;
  readonly status: number | undefined;
  /**
   * true cuando no sabemos si la operación llegó a ejecutarse del lado del servidor:
   * el fetch nunca obtuvo respuesta, o el servidor contestó 5xx. En un flujo de plata
   * esto NO se puede mostrar como un rechazo, porque puede que la plata sí se haya movido.
   */
  readonly ambiguous: boolean;

  constructor(
    code: ErrCode,
    message: string,
    options: { field?: string; status?: number; ambiguous?: boolean } = {},
  ) {
    super(message || FALLBACK_ERROR_MESSAGE);
    this.name = "ApiError";
    this.code = code;
    this.field = options.field;
    this.status = options.status;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}

function getApiBaseUrl() {
  return (import.meta.env["VITE_API_URL"] || "http://localhost:3000").replace(/\/$/, "");
}

function isUnauthorized(status: number | undefined): boolean {
  return status === 401;
}

/**
 * Resolves the bearer token to attach to a request.
 *
 * Privy mode fails closed: without an injected source (i.e. not authenticated)
 * it returns null and requests are rejected before they leave the browser.
 * The demo fallback lives entirely inside the `demo` branch so the
 * `"token-de-desarrollo"` value and the `sessionStorage` token are never used
 * in Privy mode.
 */
async function getFreshToken(): Promise<string | null> {
  if (tokenSource) return tokenSource.getToken();
  if (legacyConfiguredToken) return legacyConfiguredToken;
  if (usesDemoToken()) {
    if (typeof window !== "undefined") {
      const storedToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY_DEMO);
      if (storedToken) return storedToken;
    }
    // Demo identity needs no token source: the backend resolves the demo user and
    // ignores Authorization. Gating this on DEV made a production demo build
    // return "", and `authedFetch` then rejected every request before it left
    // the browser, so the deployed demo rendered its error state on every route.
    return "token-de-desarrollo";
  }
  // Privy (or unset identity provider) without an injected source: fail closed.
  return null;
}

function makeUrl(path: string, params?: URLSearchParams) {
  const query = params?.toString();
  return `${getApiBaseUrl()}${path}${query ? `?${query}` : ""}`;
}

/**
 * Fetches a URL with the Authorization bearer header and the session-isolation
 * guard. On a 401 it invalidates the source, fetches a fresh token and retries
 * exactly once; a second 401 is surfaced without another retry.
 */
async function authedFetch(
  path: string,
  options: RequestInit = {},
  idempotencyKey?: string,
): Promise<Response> {
  const guard = beginRequest();

  const exec = async (token: string): Promise<Response> => {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    // Only claim a JSON body when one is actually sent: Fastify rejects an
    // empty body with content-type application/json (bodyless DELETE/GET),
    // which broke contact removal against the real backend.
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    let response: Response;
    try {
      response = await fetch(makeUrl(path), { ...options, headers, signal: guard.signal });
    } catch {
      // A session reset aborts the request; treat that as a failed auth, not a
      // plain network error, so the caller discards the stale result.
      if (guard.controller.signal.aborted) {
        throw new ApiError("NO_AUTORIZADO", FALLBACK_ERROR_MESSAGE, { status: 401 });
      }
      throw new ApiError("SERVICIO_CAIDO", FALLBACK_ERROR_MESSAGE, { ambiguous: true });
    }
    return response;
  };

  const token = await getFreshToken();
  if (!token) {
    finishRequest(guard.controller);
    throw new ApiError("NO_AUTORIZADO", FALLBACK_ERROR_MESSAGE, { status: 401 });
  }

  try {
    const first = await exec(token);
    if (!isSessionCurrent(guard.generation)) {
      throw new ApiError("NO_AUTORIZADO", FALLBACK_ERROR_MESSAGE, { status: 401 });
    }
    if (isUnauthorized(first.status)) {
      await tokenSource?.invalidate?.();
      const fresh = await getFreshToken();
      if (fresh) {
        const retried = await exec(fresh);
        if (!isSessionCurrent(guard.generation)) {
          throw new ApiError("NO_AUTORIZADO", FALLBACK_ERROR_MESSAGE, { status: 401 });
        }
        return retried;
      }
    }
    return first;
  } finally {
    finishRequest(guard.controller);
  }
}

/** Parses a wallet-envelope response into `T`, handling both envelope shapes. */
async function parseEnvelope<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("ERROR_INTERNO", FALLBACK_ERROR_MESSAGE, {
      status: response.status,
      ambiguous: true,
    });
  }

  const envelope = body as ApiEnvelope<T> & { status?: unknown };
  if (envelope.ok === true) return envelope.data;

  // Business error envelope: { ok:false, error:{ code, message, field? } }
  if (envelope.ok === false && envelope.error) {
    const code = isUnauthorized(response.status) ? "NO_AUTORIZADO" : envelope.error.code;
    throw new ApiError(code, envelope.error.message || FALLBACK_ERROR_MESSAGE, {
      ...(envelope.error.field ? { field: envelope.error.field } : {}),
      status: response.status,
      ambiguous:
        response.status >= 500 ||
        envelope.error.code === "SERVICIO_CAIDO" ||
        envelope.error.code === "ERROR_INTERNO",
    });
  }

  // Identity/conversation-style error: { status:'error', message, code }
  const statusError = body as { status?: unknown; message?: unknown; code?: unknown };
  if (statusError && statusError.status === "error") {
    throw new ApiError(
      isUnauthorized(response.status)
        ? "NO_AUTORIZADO"
        : ((typeof statusError.code === "string" ? statusError.code : "ERROR_INTERNO") as ErrCode),
      typeof statusError.message === "string" ? statusError.message : FALLBACK_ERROR_MESSAGE,
      { status: response.status, ambiguous: response.status >= 500 },
    );
  }

  throw new ApiError("ERROR_INTERNO", FALLBACK_ERROR_MESSAGE, {
    status: response.status,
    ambiguous: response.status >= 500,
  });
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  const response = await authedFetch(path, options, idempotencyKey);
  return parseEnvelope<T>(response);
}

/** Conversation endpoints return raw JSON instead of the wallet API envelope. */
async function rawConversationRequest<T>(
  path: string,
  options: RequestInit,
  acceptErrorResponse = false,
): Promise<T> {
  const response = await authedFetch(path, options);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("ERROR_INTERNO", FALLBACK_ERROR_MESSAGE, {
      status: response.status,
      ambiguous: response.status >= 500,
    });
  }

  if (!response.ok) {
    const errorBody = body as { status?: unknown; message?: unknown; code?: unknown };
    if (
      acceptErrorResponse &&
      response.status < 500 &&
      errorBody.status === "error" &&
      typeof errorBody.message === "string"
    ) {
      return body as T;
    }
    throw new ApiError(
      isUnauthorized(response.status)
        ? "NO_AUTORIZADO"
        : typeof errorBody.code === "string"
          ? (errorBody.code as ErrCode)
          : response.status >= 500
            ? "ERROR_INTERNO"
            : "DATOS_INVALIDOS",
      typeof errorBody.message === "string" ? errorBody.message : FALLBACK_ERROR_MESSAGE,
      { status: response.status, ambiguous: response.status >= 500 },
    );
  }

  return body as T;
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export const api = {
  getWalletSummary: async (): Promise<WalletSummary> => {
    if (!isPrivyIdentityProvider()) {
      return request<WalletSummary>("/v1/wallet/summary");
    }
    const balance = await rawConversationRequest<WalletBalanceResponse>(
      "/v1/wallet/balance?network=arc-testnet&token=USDC",
      {},
    );
    const money = {
      amount: balance.balance,
      currency: "USDC" as const,
      display: `${balance.balance} USDC`,
    };
    return {
      total: money,
      accounts: [
        {
          id: balance.address,
          name: "USDC en Arc Testnet",
          subtitle: balance.address,
          balance: money,
          kind: "usdc",
        },
      ],
      updatedAt: new Date().toISOString(),
    };
  },

  getMovements: async (params: { cursor?: string; limit?: number } = {}) => {
    if (isPrivyIdentityProvider()) {
      const history = await rawConversationRequest<WalletHistoryResponse>(
        "/v1/wallet/history?network=arc-testnet&token=USDC",
        {},
      );
      const offset = Number(params.cursor ?? "0");
      const limit = params.limit ?? 20;
      const selected = history.transactions.slice(offset, offset + limit);
      const nextOffset = offset + selected.length;
      return {
        items: selected.map((transaction) => ({
          id: transaction.hash,
          kind: transaction.direction === "in" ? ("entrada" as const) : ("salida" as const),
          title: transaction.direction === "in" ? "Recibiste USDC" : "Enviaste USDC",
          subtitle: transaction.counterparty,
          amount: {
            amount: transaction.amount,
            currency: "USDC" as const,
            display: `${transaction.amount} ${transaction.token}`,
          },
          at: transaction.timestamp,
        })),
        nextCursor: nextOffset < history.transactions.length ? String(nextOffset) : null,
      } satisfies MovementsPage;
    }
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    search.set("limit", String(params.limit ?? 20));
    return request<MovementsPage>(`/v1/wallet/movements?${search.toString()}`);
  },

  // PEW-005/007/013: wallet lifecycle + permission surface. Readiness is
  // separate from permission readiness; these call the authenticated,
  // user-scoped /v1/wallets endpoints.
  getCurrentWallet: () => request<CurrentWalletResponse>("/v1/wallets/current"),

  getNotifications: () => request<NotificationFeedItem[]>("/v1/notifications"),

  markNotificationRead: async (notificationId: string): Promise<void> => {
    await request<undefined>(
      `/v1/notifications/${encodeURIComponent(notificationId)}/read`,
      jsonRequest("POST", {}),
    );
  },

  // WP-003/WP-004: personal USDC balance. No parameters are accepted by the
  // contract; the server resolves owner, chain and token itself.
  getBalances: () => request<BalancesData>("/v1/wallets/current/balances"),

  // LuckGnome structure (owner decision 2026-10-07): "Tus activos" covers
  // every chain the user holds. Privy mode reads each network through the
  // per-user conversation wallet API; demo mode keeps the single fixture.
  getNetworkBalances: async (): Promise<
    Array<{ network: string; token: string; address: string; balance: string }>
  > => {
    if (!isPrivyIdentityProvider()) return [];
    const arc = await rawConversationRequest<WalletBalanceResponse>(
      "/v1/wallet/balance?network=arc-testnet&token=USDC",
      {},
    );
    const solana = await rawConversationRequest<WalletBalanceResponse>(
      "/v1/wallet/balance?network=solana-devnet&token=SOL",
      {},
    ).catch(() => null);
    const rows = [
      { network: "Arc testnet", token: "USDC", address: arc.address, balance: arc.balance },
    ];
    if (solana) {
      rows.push({
        network: "Solana devnet",
        token: "SOL",
        address: solana.address,
        balance: solana.balance,
      });
    }
    return rows;
  },

  // DGC-5: delegated grants lifecycle (authenticated HTTP only; never
  // voice). The server enforces scope, caps, window, expiry and revocation.
  listGrants: () => request<ListDelegatedGrantsResponse>("/v1/grants"),

  createGrant: (input: CreateDelegatedGrantRequest) =>
    request<CreateDelegatedGrantResponse>("/v1/grants", jsonRequest("POST", input)),

  revokeGrant: (grantId: string) =>
    request<RevokeDelegatedGrantResponse>(
      `/v1/grants/${encodeURIComponent(grantId)}/revoke`,
      jsonRequest("POST", {}),
    ),

  syncWallet: () => request<WalletSyncResponse>("/v1/wallets/sync", jsonRequest("POST", {})),

  getCurrentWalletPermission: () =>
    request<WalletPermissionResponse>("/v1/wallets/current/permission"),

  revokeWalletPermission: () =>
    request<WalletRevokeResponse>("/v1/wallets/current/permission/revoke", jsonRequest("POST", {})),

  // PEW-013: explicit activation request. The SERVER reads back the effective
  // provider policy before marking active; the client cannot assert enrollment
  // succeeded (a failed read-back surfaces as an error, never as "active").
  activateWalletPermission: (input: ActivateWalletPermissionInput) =>
    request<WalletActivationResponse>("/v1/wallets/current/permission", jsonRequest("POST", input)),

  // PEW-014: user-authenticated signer enrollment. `prepare` creates/reuses the
  // provider policy and returns the wallet/policy/quorum ids; the browser then
  // adds the signer, and `complete` asks the SERVER to re-prove owner + policy
  // attachment. A `verified:false` result must be surfaced honestly, never as
  // an active grant.
  prepareWalletPermission: (input: EnrollmentPrepareInput) =>
    request<EnrollmentPreparationResponse>(
      "/v1/wallets/current/permission/prepare",
      jsonRequest("POST", input),
    ),

  completeWalletPermission: (input: EnrollmentCompleteInput) =>
    request<EnrollmentCompleteResponse>(
      "/v1/wallets/current/permission/complete",
      jsonRequest("POST", input),
    ),

  getContacts: () => request<Contact[]>("/v1/contacts"),

  createContact: (input: CreateContactInput) =>
    request<Contact>("/v1/contacts", jsonRequest("POST", input)),

  updateContact: (contactId: string, input: UpdateContactInput) =>
    request<Contact>(`/v1/contacts/${contactId}`, jsonRequest("PATCH", input)),

  deleteContact: (contactId: string) =>
    request<Contact>(`/v1/contacts/${contactId}`, jsonRequest("DELETE")),

  revealContactCbu: (contactId: string) =>
    request<RevealedCbu>(`/v1/contacts/${contactId}/reveal-cbu`, jsonRequest("POST", {})),

  getAgenda: (params: { from: string; to: string }) => {
    const search = new URLSearchParams({ from: params.from, to: params.to });
    return request<AgendaEvent[]>(`/v1/agenda?${search.toString()}`);
  },

  createAgendaEvent: (input: CreateAgendaEventInput) =>
    request<AgendaEvent>("/v1/agenda", jsonRequest("POST", input)),

  getBills: (params: { status?: BillStatus; month?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.month) search.set("month", params.month);
    const query = search.toString();
    return request<Bill[]>(`/v1/bills${query ? `?${query}` : ""}`);
  },

  getBill: (billId: string) => request<Bill>(`/v1/bills/${billId}`),

  scheduleBill: (billId: string) =>
    request<Bill>(`/v1/bills/${billId}/schedule`, jsonRequest("POST", {})),

  cancelBillSchedule: (billId: string) =>
    request<Bill>(`/v1/bills/${billId}/schedule`, jsonRequest("DELETE")),

  createBillPaymentIntent: (billId: string, input: BillPaymentIntentInput) =>
    request<PaymentIntent>(`/v1/bills/${billId}/payment-intent`, jsonRequest("POST", input)),

  createTransferIntent: (input: TransferIntentInput) =>
    request<PaymentIntent>("/v1/transfers/intent", jsonRequest("POST", input)),

  confirmPayment: (intentId: string, idempotencyKey: string = createIdempotencyKey()) =>
    request<PaymentResult>(
      `/v1/payments/${intentId}/confirm`,
      jsonRequest("POST", {}),
      idempotencyKey,
    ),

  confirmTransfer: (intentId: string, idempotencyKey: string = createIdempotencyKey()) =>
    request<PaymentResult>(
      `/v1/transfers/${intentId}/confirm`,
      jsonRequest("POST", {}),
      idempotencyKey,
    ),

  transcribeAgentAudio: (input: AgentAudioTranscriptionInput) =>
    request<AgentAudioTranscription>("/v1/agent/transcribe", jsonRequest("POST", input)),

  createConversation: () =>
    rawConversationRequest<CreateConversationResponse>(
      "/v1/conversations",
      jsonRequest("POST", {}),
    ),

  createLiveVoiceBinding: (conversationId?: string) =>
    rawConversationRequest<LiveVoiceBindingResponse>(
      "/v1/live-bindings",
      jsonRequest("POST", conversationId ? { conversationId } : {}),
    ),

  fetchVoiceRoomToken: (conversationId: string) =>
    rawConversationRequest<VoiceRoomTokenResponse>(
      "/v1/voice/room-token",
      jsonRequest("POST", { conversationId }),
    ),

  sendConversationTurn: (conversationId: string, message: string) =>
    rawConversationRequest<ConversationTurnResult>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/turns`,
      jsonRequest("POST", { message }),
      true,
    ),

  getConversationState: async (
    conversationId: string,
    etag?: string,
  ): Promise<ConversationState | null> => {
    const headers = new Headers();
    if (etag) headers.set("If-None-Match", etag);
    const response = await authedFetch(
      `/v1/conversations/${encodeURIComponent(conversationId)}/state`,
      { method: "GET", headers },
    );
    if (response.status === 304) return null;
    if (!response.ok) {
      throw new ApiError(
        isUnauthorized(response.status) ? "NO_AUTORIZADO" : "DATOS_INVALIDOS",
        FALLBACK_ERROR_MESSAGE,
        { status: response.status, ambiguous: response.status >= 500 },
      );
    }
    return (await response.json()) as ConversationState;
  },

  decideConversation: (conversationId: string, previewId: string, decision: "confirm" | "cancel") =>
    rawConversationRequest<{ accepted: boolean; revision: number; state: ConversationState }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/decisions`,
      jsonRequest("POST", { previewId, decision }),
    ),

  endLiveConversation: (
    conversationId: string,
    expectedRevision: number,
    acknowledgeUnresolvedFinancialWork = false,
  ) =>
    rawConversationRequest<EndLiveConversationResponse>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/end-live`,
      jsonRequest("POST", {
        expectedRevision,
        acknowledgeUnresolvedFinancialWork,
      }),
    ),

  getMe: () => request<MeResponse>("/v1/me"),

  speak: (text: string) => speak(text),
};

async function speak(text: string): Promise<Blob> {
  const response = await authedFetch("/v1/voice/speak", {
    method: "POST",
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new ApiError("ERROR_INTERNO", "No pudimos generar el audio.", {
      status: response.status,
      ambiguous: response.status >= 500,
    });
  }

  return response.blob();
}

/**
 * Builds a sender whose durable conversation identity stays in React-owned memory.
 * Only the in-flight creation promise lives here, preventing two initial sends
 * from creating separate conversations before React has rendered the new id.
 */
export function createConversationTurnSender(
  getConversationId: () => string | null,
  setConversationId: (conversationId: string | null) => void,
) {
  let pendingConversation: Promise<string> | null = null;

  async function ensureConversation() {
    const currentConversationId = getConversationId();
    if (currentConversationId) return currentConversationId;

    pendingConversation ??= api
      .createConversation()
      .then(({ conversationId }) => {
        setConversationId(conversationId);
        return conversationId;
      })
      .finally(() => {
        pendingConversation = null;
      });
    return pendingConversation;
  }

  return async (message: string): Promise<ConversationTurnResult> => {
    let conversationId = await ensureConversation();
    let response = await api.sendConversationTurn(conversationId, message);

    if (response.status === "error" && response.code === "conversation_not_found") {
      if (getConversationId() === conversationId) setConversationId(null);
      conversationId = await ensureConversation();
      response = await api.sendConversationTurn(conversationId, message);
    }

    return response;
  };
}

export function confirmMoneyIntent(
  intent: ConfirmableIntent,
  idempotencyKey: string,
): Promise<PaymentResult> {
  return intent.kind === "bill_payment"
    ? api.confirmPayment(intent.intentId, idempotencyKey)
    : api.confirmTransfer(intent.intentId, idempotencyKey);
}

export const queryKeys = {
  me: ["me"] as const,
  // WP-013: personal balances cache is user-scoped with its own "balances"
  // root, distinct from the legacy wallet summary keys.
  balances: (userId: string | undefined, chainId: number) => ["balances", userId, chainId] as const,
  networkBalances: (userId: string | undefined) => ["balances", "networks", userId] as const,
  wallet: (userId: string | undefined) => ["wallet", "summary", userId] as const,
  movements: (userId: string | undefined) => ["wallet", "movements", userId] as const,
  currentWallet: (userId: string | undefined) => ["wallet", "current", userId] as const,
  walletPermission: (userId: string | undefined) => ["wallet", "permission", userId] as const,
  contacts: (userId: string | undefined) => ["contacts", userId] as const,
  grants: (userId: string | undefined) => ["grants", userId] as const,
  notifications: (userId: string | undefined) => ["notifications", userId] as const,
  agenda: (userId: string | undefined, from: string, to: string) =>
    ["agenda", userId, from, to] as const,
  bills: (userId: string | undefined) => ["bills", userId] as const,
};
