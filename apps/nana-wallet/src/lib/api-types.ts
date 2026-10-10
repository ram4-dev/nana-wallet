// Estos tipos duplican manualmente los contratos HTTP del backend definidos en
// `src/contracts/http.ts` (zod). Son la fuente de verdad del servidor; el front
// los replica a mano. Si cambiás el contrato HTTP, actualizá AMBOS lados en el
// mismo PR.

export type Ok<T> = { ok: true; data: T };

export type Err = {
  ok: false;
  error: { code: ErrCode; message: string; field?: string };
};

export type ApiEnvelope<T> = Ok<T> | Err;

export type ErrCode =
  | "NO_AUTORIZADO"
  | "SIN_PERMISO"
  | "NO_ENCONTRADO"
  | "DATOS_INVALIDOS"
  | "INVALID_QUERY"
  | "WALLET_DATOS_INVALIDOS"
  | "BALANCE_NO_DISPONIBLE"
  | "SALDO_INSUFICIENTE"
  | "LIMITE_DIARIO"
  | "CONFIRMACION_VENCIDA"
  | "DUPLICADO"
  | "DEMASIADOS_INTENTOS"
  | "ERROR_INTERNO"
  | "SERVICIO_CAIDO"
  | "wallet_not_ready"
  | "wallet_config_error"
  | "wallet_unavailable"
  | "wallet_feature_unavailable"
  | "CONFLICTO_POLITICA"
  | "REVISION_POLITICA_OBSOLETA"
  | "COBERTURA_DESCONOCIDA"
  | "PERMISO_CONFIGURACION_BLOQUEADA"
  | "COMPOSICION_VACIA_NO_SOPORTADA"
  | "PROPUESTA_OBSOLETA";

export type Money = {
  amount: string;
  currency: "ARS" | "USD" | "USDC" | "SOL";
  display: string;
};

export type ISODate = string;
export type ISODateTime = string;

export type WalletAccount = {
  id: string;
  name: string;
  subtitle: string;
  balance: Money;
  approxInArs?: Money;
  kind: "pesos" | "dolares" | "usdc" | "sol" | "plazo_fijo";
  maturesOn?: ISODate;
};

export type WalletSummary = {
  total: Money;
  accounts: WalletAccount[];
  updatedAt: ISODateTime;
};

export type WalletMovement = {
  id: string;
  kind: "entrada" | "salida";
  title: string;
  subtitle: string;
  amount: Money;
  at: ISODateTime;
  counterparty?: { name: string; contactId?: string };
  billId?: string;
};

export type MovementsPage = {
  items: WalletMovement[];
  nextCursor: string | null;
};

export type WalletBalanceResponse = {
  network: string;
  token?: string;
  address: string;
  balance: string;
};

export type WalletHistoryResponse = {
  network: string;
  transactions: Array<{
    hash: string;
    direction: "in" | "out";
    counterparty: string;
    amount: string;
    token: string;
    timestamp: string;
  }>;
};

export type NotificationFeedItem = {
  id: string;
  category: string;
  status: string;
  title: string;
  explanation: string | null;
  resolved: boolean;
  projection: Record<string, unknown>;
  createdAt: ISODateTime;
  eventAt: ISODateTime;
  readAt: ISODateTime | null;
};

export type Contact = {
  id: string;
  name: string;
  description: string;
  address: string;
  network?: "solana-devnet";
  version: number;
  status: "active" | "inactive";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  permission: ContactPermission;
};

/**
 * Read-only policy readiness for a trusted recipient. `applied` is returned
 * only after the backend has verified Privy's signed readback.
 */
export type PolicyReadiness =
  | "saved_not_configured"
  | "pending"
  | "syncing"
  | "applied"
  | "retryable_failure"
  | "blocked_conflict"
  | "blocked_configuration";

export type ContactPermission = {
  state: PolicyReadiness;
  desiredRevision: number;
  appliedRevision: number;
  retryable: boolean;
  reason?: string;
};

export type CreateContactInput = {
  name: string;
  description: string;
  address: string;
  /** The only configured network; callers never select a chain. */
  network?: "solana-devnet";
};

export type UpdateContactInput = {
  name?: string;
  description?: string;
  address?: string;
  network?: "solana-devnet" | null;
  expectedVersion: number;
  expectedPolicyRevision?: number;
  expectedRevokedGrantIds?: string[];
};

export type ContactRemovalPreview = {
  contactId: string;
  contactVersion: number;
  revokedGrantIds: string[];
  lastAlias: boolean;
};

export type DeleteContactInput = {
  expectedVersion: number;
  expectedRevokedGrantIds: string[];
};

export type DeleteContactResponse = {
  contact: Contact;
  permission?: ContactPermission;
  revocation: {
    grantIds: string[];
    state: "pending" | "applied" | "retryable_failure";
  };
};

export type ContactAction = "create" | "edit" | "remove";
export type ContactActionProposalStatus = "open" | "consumed" | "superseded" | "expired";

/** Immutable server-owned proposal rendered by the review card. */
export type ContactActionProposal = {
  proposalId: string;
  proposalVersion: number;
  action: ContactAction;
  contactId: string | null;
  contactVersion: number | null;
  address: string;
  previousAddress?: string | null;
  revokedGrantIds: string[];
  revocationDisclosure?: string | null;
  expiresAt: ISODateTime;
  status: ContactActionProposalStatus;
};

/** LiveKit carries only this wakeup; the UI reloads the canonical proposal by id. */
export type ContactActionProposalNotification = {
  type: "contact_action_proposal";
  proposalId: string;
  proposalVersion: number;
  conversationId: string;
};

export type ReplaceContactActionAddressInput = {
  address: string;
  expectedProposalVersion: number;
};

/** `POST /v1/contact-actions/:proposalId/address` — the newly created version. */
export type ContactActionAddressResponse = {
  proposalId: string;
  proposalVersion: number;
  address: string;
};

export type RevealedCbu = { id: string; address: string };

export type AgendaEvent = {
  id: string;
  title: string;
  date: ISODate;
  kind: "cumpleanos" | "turno_medico" | "recordatorio" | "otro";
  contactId: string | null;
  note: string | null;
  suggestedAction: null | {
    label: string;
    intent: "transfer";
    contactId: string;
  };
};

export type CreateAgendaEventInput = Omit<AgendaEvent, "id">;

export type BillStatus = "pendiente" | "programada" | "pagada" | "vencida";

export type Bill = {
  id: string;
  provider: string;
  providerLogoUrl: string | null;
  amount: Money;
  dueDate: ISODate;
  dueDateHuman: string;
  status: BillStatus;
  statusHuman: string;
  daysUntilDue: number;
  canPayNow: boolean;
  paidAt: ISODateTime | null;
  receiptId: string | null;
};

export type PaymentConfirmation = {
  headline: string;
  amountDisplay: string;
  fromAccountDisplay: string;
  detailLines: string[];
  warnings: string[];
  confirmLabel: string;
  cancelLabel: string;
};

export type PaymentIntent = {
  intentId: string;
  expiresAt: ISODateTime;
  confirmation: PaymentConfirmation;
  balanceAfter: Money;
};

export type PaymentResult = {
  paymentId: string;
  status: "confirmado" | "en_proceso" | "fallido";
  receipt: {
    headline: string;
    amountDisplay: string;
    at: ISODateTime;
    atHuman: string;
    reference: string;
    newBalanceDisplay: string;
  };
};

export type TransferIntentInput = {
  contactId: string;
  amount: string;
  currency: "ARS";
  fromAccountId: string;
  note?: string;
};

export type BillPaymentIntentInput = { accountId: string };

export type CreateConversationResponse = {
  conversationId: string;
  mode: "typed";
};

export type LiveVoiceBindingResponse = {
  conversationId: string;
  bindingToken: string;
};

export type VoiceRoomTokenResponse = {
  serverUrl: string;
  participantToken: string;
  roomName: string;
};

export type EndLiveConversationResponse = {
  mode: "typed";
  revision: number;
  state: ConversationState;
};

export type AgentAudioTranscriptionInput = {
  audioBase64: string;
  mimeType: string;
};

export type AgentAudioTranscription = {
  transcript: string;
};

export type TransferPreview = {
  network: string;
  token: string;
  recipient: string;
  amount: string;
  estimatedFee: string;
  previewId?: string;
};

export type RecipientCandidate = {
  id: string;
  name: string;
  description: string;
  version: number;
  evidence?: string;
  score?: number;
};

export type TransactionResult = {
  network: string;
  transactionHash: string;
  explorerUrl: string;
};

export type ConversationTurnResult =
  | { status: "answer"; message: string }
  | { status: "clarification_required"; message: string; candidates: RecipientCandidate[] }
  | { status: "confirmation_required"; message: string; preview: TransferPreview }
  | { status: "sent"; message: string; transaction: TransactionResult }
  | { status: "cancelled"; message: string }
  | { status: "error"; message: string; code: string };

export type ConversationState = {
  id: string;
  mode: "typed" | "live";
  revision: number;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  pendingTransfer?: TransferPreview & { previewId: string };
  lastTransactionHash?: string;
  activity?:
    "idle" | "working" | "awaiting_confirmation" | "verifying" | "uncertain" | "request_waiting";
  progress?: { phase: string; label?: string };
  transaction?: TransactionResult;
  error?: { code: string; message: string };
};

export type MeResponse = {
  userId: string;
  displayName: string | null;
};

export type ConfirmableIntent = {
  kind: "transfer" | "bill_payment";
  intentId: string;
  expiresAt: ISODateTime;
  confirmation: PaymentConfirmation;
};

export type EmptyResponse = Record<string, never>;

/** PEW-005: identity != wallet readiness. Mirrors backend walletReadinessStateSchema. */
export type WalletReadinessState =
  "unprovisioned" | "provisioning" | "ready" | "recovery_required" | "conflict" | "unavailable";

export type CurrentWalletResponse = {
  userId: string;
  state: WalletReadinessState;
  address: string;
  chainFamily: string;
  provider: string;
};

export type WalletSyncResponse = {
  userId: string;
  state: WalletReadinessState;
  address: string;
  created: boolean;
};

/** PEW-013: permission lifecycle is separate from login and payment confirmation. */
export type PermissionState = "pending" | "active" | "revoking" | "revoked" | "unavailable";

/**
 * Chain selector for the wallet/permission surface. Mirrors the backend
 * `walletChainFamilySchema`; when omitted the backend keeps the legacy `arc`
 * behaviour. Only `arc` and `solana` are valid.
 */
export type WalletChainFamily = "arc" | "solana";

export type WalletPermissionResponse = {
  userId: string;
  state: PermissionState;
  perTransferUsdc: string;
  perTransferSol: string;
  rollingTotalUsdc: string;
  rollingWindowSeconds: number;
  gasCeiling: string;
  recipients: string[];
  aggregateOvershootCaveat: boolean;
  // PEW-014: rolling-window aggregation is provider-unproven and surfaced as a
  // hard payment block; optional so older fixtures still parse.
  aggregationReady?: boolean;
  aggregateBlockReason?: string;
};

/** PEW-013: activation returns the read-back-verified permission summary. */
export type WalletActivationResponse = WalletPermissionResponse;

export type ActivateWalletPermissionInput = {
  recipients: string[];
  // Optional chain selector; absent means the legacy `arc` wallet.
  chain?: WalletChainFamily;
};

/** PEW-014: signer enrollment prepare posts the explicit recipient allowlist. */
export type EnrollmentPrepareInput = {
  recipients: string[];
};

export type EnrollmentPreparationResponse = {
  walletId: string;
  walletAddress: string;
  policyId: string;
  quorumId: string;
  perTransferUsdc: string;
  perTransferSol: string;
  rollingTotalUsdc: string;
  windowSeconds: number;
  aggregationReady: false;
  aggregateBlockReason: string;
};

export type EnrollmentCompleteInput = {
  walletId: string;
  // Optional chain guard; when present the wallet must belong to this chain.
  chain?: WalletChainFamily;
};

export type EnrollmentCompleteResponse = {
  verified: boolean;
  state: PermissionState;
  permission?: WalletPermissionResponse;
  observed?: {
    walletOwnerMatches: boolean;
    policyAttached: boolean;
    observedPolicyIds: string[];
    observedSignerIds: string[];
  };
};

export type WalletRevokeResponse = {
  userId: string;
  state: PermissionState;
  remote: "revoked" | "unavailable";
};

/** Optional chain selector for the revoke mutation; absent keeps `arc`. */
export type WalletRevokeInput = {
  chain?: WalletChainFamily;
};

// wallet-profile (WP-004/WP-005): duplicated manually from the backend
// balances contract in `src/contracts/http.ts`. The catalog is fixed on the
// server; the client never selects chain, token or owner.
//
// The value is the CAIP-2 chain identifier as a STRING: Solana has no EIP-155
// numeric chain id, so the backend sends CAIP-2 under the (unchanged) field
// name `chainId`. The client only uses it as a react-query cache-key value.
export const SOLANA_DEVNET_CHAIN_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export type BalanceAsset = {
  tokenId: typeof SOLANA_DEVNET_CHAIN_ID;
  // A native asset has no token contract: the backend sends this sentinel.
  contract: "native";
  symbol: "SOL";
  name: "Solana";
  decimals: 9;
  balanceAtomic: string;
};

export type BalancesReadyData = {
  walletState: "ready";
  address: string;
  chainId: typeof SOLANA_DEVNET_CHAIN_ID;
  networkName: "Solana devnet";
  testnet: true;
  source: "fixture" | "rpc";
  observedAt: ISODateTime;
  assets: [BalanceAsset];
};

export type BalancesNotReadyData = {
  walletState: Exclude<WalletReadinessState, "ready">;
  chainId: typeof SOLANA_DEVNET_CHAIN_ID;
  networkName: "Solana devnet";
  testnet: true;
  observedAt: null;
  assets: [];
};

export type BalancesData = BalancesReadyData | BalancesNotReadyData;

// DGC-5: delegated grants lifecycle (Slice 1). Mirror of the backend zod
// schemas in src/contracts/http.ts — update BOTH sides in the same PR.
// Amounts are decimal strings in the grant chain's smallest unit.
export type DelegatedGrantAction = "transfer";

export type DelegatedGrantState = "active" | "revoked" | "expired";

export type DelegatedGrant = {
  id: string;
  walletId: string;
  action: DelegatedGrantAction;
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  state: DelegatedGrantState;
  policyReady: boolean;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  revokedAt: ISODateTime | null;
};

export type CreateDelegatedGrantRequest = {
  action: DelegatedGrantAction;
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  expiresAt: ISODateTime;
};

export type CreateDelegatedGrantResponse = { grant: DelegatedGrant };
export type ListDelegatedGrantsResponse = { grants: DelegatedGrant[] };
export type RevokeDelegatedGrantResponse = { grant: DelegatedGrant };
