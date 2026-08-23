import type {
  AgendaEvent,
  AgentTurn,
  AgentTurnRequest,
  ApiEnvelope,
  Bill,
  BillPaymentIntentInput,
  BillStatus,
  ConfirmableIntent,
  Contact,
  CreateAgendaEventInput,
  CreateContactInput,
  EmptyResponse,
  ErrCode,
  Me,
  MovementsPage,
  PaymentIntent,
  PaymentResult,
  RevealedCbu,
  TransferIntentInput,
  UpdateContactInput,
  WalletSummary,
} from "./api-types";

export const FALLBACK_ERROR_MESSAGE = "Algo no salió bien. Probá de nuevo en un ratito.";
const TOKEN_STORAGE_KEY = "nana-wallet-token";

/**
 * Único lugar donde se decide qué texto ve el usuario cuando algo falla.
 * El front nunca traduce códigos de error: muestra el message que mandó el backend,
 * y solo cae al fallback cuando no hay ninguno.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return FALLBACK_ERROR_MESSAGE;
}

/** true cuando no sabemos si la operación se ejecutó del lado del servidor. */
export function isAmbiguousError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.ambiguous;
}

let configuredToken: string | null = null;

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

export function setApiToken(token: string | null) {
  configuredToken = token;
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}

function getApiBaseUrl() {
  return (import.meta.env["VITE_API_URL"] || "http://localhost:3000").replace(/\/$/, "");
}

function getApiToken() {
  if (configuredToken) return configuredToken;
  if (typeof window !== "undefined") {
    const storedToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (storedToken) return storedToken;
  }
  return import.meta.env.DEV ? "token-de-desarrollo" : "";
}

function makeUrl(path: string, params?: URLSearchParams) {
  const query = params?.toString();
  return `${getApiBaseUrl()}${path}${query ? `?${query}` : ""}`;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${getApiToken()}`);
  headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  let response: Response;
  try {
    response = await fetch(makeUrl(path), { ...options, headers });
  } catch {
    // Nunca hubo respuesta. La petición pudo haber llegado igual.
    throw new ApiError("SERVICIO_CAIDO", FALLBACK_ERROR_MESSAGE, { ambiguous: true });
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // El servidor contestó algo que no podemos leer. No sabemos qué hizo antes de contestar.
    throw new ApiError("ERROR_INTERNO", FALLBACK_ERROR_MESSAGE, {
      status: response.status,
      ambiguous: true,
    });
  }

  if (envelope.ok) return envelope.data;

  throw new ApiError(envelope.error.code, envelope.error.message || FALLBACK_ERROR_MESSAGE, {
    ...(envelope.error.field ? { field: envelope.error.field } : {}),
    status: response.status,
    // Un 5xx significa que el servidor falló, posiblemente después de haber ejecutado.
    // Un 4xx es un rechazo explícito: la plata no se movió.
    ambiguous:
      response.status >= 500 ||
      envelope.error.code === "SERVICIO_CAIDO" ||
      envelope.error.code === "ERROR_INTERNO",
  });
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export const api = {
  getWalletSummary: () => request<WalletSummary>("/v1/wallet/summary"),

  getMovements: (params: { cursor?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    search.set("limit", String(params.limit ?? 20));
    return request<MovementsPage>(`/v1/wallet/movements?${search.toString()}`);
  },

  getContacts: () => request<Contact[]>("/v1/contacts"),

  createContact: (input: CreateContactInput) =>
    request<Contact>("/v1/contacts", jsonRequest("POST", input)),

  updateContact: (contactId: string, input: UpdateContactInput) =>
    request<Contact>(`/v1/contacts/${contactId}`, jsonRequest("PATCH", input)),

  deleteContact: (contactId: string) =>
    request<EmptyResponse>(`/v1/contacts/${contactId}`, jsonRequest("DELETE")),

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

  agentTurn: (input: AgentTurnRequest) =>
    request<AgentTurn>("/v1/agent/turn", jsonRequest("POST", input)),

  rejectAgentTurn: (turnId: string) =>
    request<EmptyResponse>(`/v1/agent/turn/${turnId}/reject`, jsonRequest("POST", {})),

  getMe: () => request<Me>("/v1/me"),
};

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
  wallet: ["wallet", "summary"] as const,
  movements: ["wallet", "movements"] as const,
  contacts: ["contacts"] as const,
  agenda: (from: string, to: string) => ["agenda", from, to] as const,
  bills: ["bills"] as const,
};
