import { z } from "zod";

import { SOLANA_DEVNET_CAIP2 } from "../wallet/solana-devnet-provider.js";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  mode: z.enum(["fixture", "live"]),
  mcp: z.enum(["connected", "disconnected", "unknown"]),
  wallet: z.enum(["unlocked", "locked", "unknown"]),
  network: z.string(),
  provider: z
    .object({
      status: z.enum(["healthy", "degraded", "unavailable"]),
      reason: z.string().optional(),
    })
    .optional(),
  /**
   * Design §6.4 layer 3, task 2.7: the readiness surface for the
   * signed-authorization capability. `{ capable, code }` and nothing else — no
   * token, key, payload or signature value can appear here.
   */
  policySigner: z.object({
    capable: z.boolean(),
    code: z.enum([
      "verified",
      "signer_unavailable",
      "signer_rejected",
      "signer_timeout",
      "signature_mismatch",
    ]),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const walletAddressResponseSchema = z.object({
  network: z.string(),
  address: z.string(),
});
export type WalletAddressResponse = z.infer<typeof walletAddressResponseSchema>;

export const walletBalanceQuerySchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1).optional(),
});
export type WalletBalanceQuery = z.infer<typeof walletBalanceQuerySchema>;

export const walletBalanceResponseSchema = z.object({
  network: z.string(),
  token: z.string().optional(),
  address: z.string(),
  balance: z.string(),
});
export type WalletBalanceResponse = z.infer<typeof walletBalanceResponseSchema>;

export const walletHistoryQuerySchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1).optional(),
});
export type WalletHistoryQuery = z.infer<typeof walletHistoryQuerySchema>;

export const walletTransactionSchema = z.object({
  hash: z.string(),
  direction: z.enum(["in", "out"]),
  counterparty: z.string(),
  amount: z.string(),
  token: z.string(),
  timestamp: z.string(),
});
export type WalletTransaction = z.infer<typeof walletTransactionSchema>;

export const walletHistoryResponseSchema = z.object({
  network: z.string(),
  transactions: z.array(walletTransactionSchema),
});
export type WalletHistoryResponse = z.infer<typeof walletHistoryResponseSchema>;

export const createConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  mode: z.literal("typed"),
});
export type CreateConversationResponse = z.infer<
  typeof createConversationResponseSchema
>;

export const conversationTurnRequestSchema = z.object({
  message: z.string().min(1),
});
export type ConversationTurnRequest = z.infer<
  typeof conversationTurnRequestSchema
>;

export const transferPreviewSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1),
  recipient: z.string().trim().min(1),
  amount: z.string().trim().min(1),
  estimatedFee: z.string().trim().min(1),
});
export type TransferPreview = z.infer<typeof transferPreviewSchema>;

export const transactionResultSchema = z.object({
  network: z.string(),
  transactionHash: z.string(),
  explorerUrl: z.string(),
});
export type TransactionResult = z.infer<typeof transactionResultSchema>;

export const safeConversationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type SafeConversationError = z.infer<typeof safeConversationErrorSchema>;

export const conversationTurnResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answer"), message: z.string() }),
  z.object({
    status: z.literal("clarification_required"),
    message: z.string(),
    candidates: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        description: z.string(),
        version: z.number().int().positive(),
        evidence: z.string().optional(),
        score: z.number().optional(),
      }),
    ),
  }),
  z.object({
    status: z.literal("confirmation_required"),
    message: z.string(),
    preview: transferPreviewSchema,
  }),
  z.object({
    status: z.literal("sent"),
    message: z.string(),
    transaction: transactionResultSchema,
  }),
  z.object({ status: z.literal("cancelled"), message: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    code: z.string(),
  }),
]);
export type ConversationTurnResult = z.infer<
  typeof conversationTurnResultSchema
>;

export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const pendingTransferSchema = z.object({
  network: z.string(),
  token: z.string(),
  to: z.string(),
  amount: z.string(),
  wallet: z.string(),
  preview: transferPreviewSchema,
  recipientId: z.string().uuid().optional(),
  recipientVersion: z.number().int().positive().optional(),
  previewId: z.string().uuid().optional(),
});
export type PendingTransfer = z.infer<typeof pendingTransferSchema>;
const projectedPendingTransferSchema = transferPreviewSchema.extend({
  previewId: z.string().uuid(),
});

export const recipientMemoryInspectionSchema = z.object({
  selectedRecipient: z
    .object({
      recipientId: z.string().uuid(),
      version: z.number().int().positive(),
    })
    .optional(),
  clarification: z
    .array(
      z.object({
        recipientId: z.string().uuid(),
        version: z.number().int().positive(),
        name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  pendingWrite: z.object({ expiresAt: z.string() }).optional(),
});
export type RecipientMemoryInspection = z.infer<
  typeof recipientMemoryInspectionSchema
>;

export const conversationStateResponseSchema = z.object({
  id: z.string(),
  mode: z.enum(["typed", "live"]),
  revision: z.number().int().nonnegative(),
  messages: z.array(conversationMessageSchema).optional(),
  pendingTransfer: projectedPendingTransferSchema.optional(),
  recipientMemory: recipientMemoryInspectionSchema.optional(),
  lastTransactionHash: z.string().optional(),
  activity: z
    .enum([
      "idle",
      "working",
      "awaiting_confirmation",
      "verifying",
      "uncertain",
      "request_waiting",
    ])
    .optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
  transaction: transactionResultSchema.optional(),
  error: safeConversationErrorSchema.optional(),
  createdAt: z.string(),
});
export type ConversationStateResponse = z.infer<
  typeof conversationStateResponseSchema
>;

export const endLiveConversationRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  acknowledgeUnresolvedFinancialWork: z.boolean().optional(),
});

export const conversationDecisionRequestSchema = z.object({
  previewId: z.string().uuid(),
  decision: z.enum(["confirm", "cancel"]),
});
export type ConversationDecisionRequest = z.infer<
  typeof conversationDecisionRequestSchema
>;

export const errorResponseSchema = z.object({
  status: z.literal("error"),
  message: z.string(),
  code: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const voiceRoomTokenRequestSchema = z.object({
  conversationId: z.string().uuid(),
  agentName: z.string().trim().min(1).optional(),
});
export type VoiceRoomTokenRequest = z.infer<typeof voiceRoomTokenRequestSchema>;

export const voiceRoomTokenResponseSchema = z.object({
  serverUrl: z.string().min(1),
  participantToken: z.string().min(1),
  roomName: z.string().min(1),
});
export type VoiceRoomTokenResponse = z.infer<
  typeof voiceRoomTokenResponseSchema
>;

export const meResponseSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Design §9.1: the readiness state of a trusted recipient's remote policy.
 * Shared verbatim with the mirrored frontend contract
 * (`apps/nana-wallet/src/lib/api-types.ts`, `PolicyReadiness`) — both sides move
 * together, `AGENTS.md`.
 */
export const policyReadinessSchema = z.enum([
  "saved_not_configured",
  "pending",
  "syncing",
  "applied",
  "retryable_failure",
  "blocked_conflict",
  "blocked_configuration",
]);
export type PolicyReadiness = z.infer<typeof policyReadinessSchema>;

/**
 * Design §9.2: the six new business codes for the recipient-policy surface.
 * `DATOS_INVALIDOS`, `VERSION_OBSOLETA`, `CONTACTO_NO_ENCONTRADO` and
 * `ERROR_INTERNO` stay valid verbatim, so no current client breaks.
 */
export const RECIPIENT_POLICY_ERROR_CODES = [
  "CONFLICTO_POLITICA",
  "REVISION_POLITICA_OBSOLETA",
  "COBERTURA_DESCONOCIDA",
  "PERMISO_CONFIGURACION_BLOQUEADA",
  "COMPOSICION_VACIA_NO_SOPORTADA",
  "PROPUESTA_OBSOLETA",
] as const;
export const recipientPolicyErrorCodeSchema = z.enum(
  RECIPIENT_POLICY_ERROR_CODES,
);
export type RecipientPolicyErrorCode = z.infer<
  typeof recipientPolicyErrorCodeSchema
>;

export const contactPermissionSchema = z.object({
  state: policyReadinessSchema,
  desiredRevision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative(),
  retryable: z.boolean(),
  reason: z.string().optional(),
});
export type ContactPermission = z.infer<typeof contactPermissionSchema>;

export const contactSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  address: z.string().min(1),
  network: z.literal("solana-devnet").optional(),
  version: z.number().int().positive(),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  permission: contactPermissionSchema,
});
export type Contact = z.infer<typeof contactSchema>;

export const createContactInputSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().default(""),
    address: z.string().trim().min(1),
    network: z.literal("solana-devnet").optional(),
  })
  .strict();
export type CreateContactInput = z.infer<typeof createContactInputSchema>;

export const updateContactInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    address: z.string().trim().min(1).optional(),
    network: z.literal("solana-devnet").nullable().optional(),
    expectedVersion: z.number().int().positive(),
    expectedPolicyRevision: z.number().int().nonnegative().optional(),
    /**
     * The address-change disclosure (design §1.6): the automatic-payment grants
     * the user was told this replacement retires, as read from
     * `GET /v1/contacts/:id/removal-preview?action=address_change`.
     * The service re-derives the set under lock and REFUSES the mutation with
     * `409 CONFLICTO_POLITICA` when the disclosed set is not the set it affects —
     * the field is never merely tolerated, and an absent one discloses nothing.
     */
    expectedRevokedGrantIds: z.array(z.string().uuid()).optional(),
  })
  .strict();
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

export const contactRemovalPreviewQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
});
export type ContactRemovalPreviewQuery = z.infer<
  typeof contactRemovalPreviewQuerySchema
>;

export const contactRemovalPreviewSchema = z.object({
  contactId: z.string().uuid(),
  contactVersion: z.number().int().positive(),
  revokedGrantIds: z.array(z.string().uuid()),
  lastAlias: z.boolean(),
});
export type ContactRemovalPreview = z.infer<typeof contactRemovalPreviewSchema>;

export const deleteContactBodySchema = z
  .object({
    expectedRevokedGrantIds: z.array(z.string().uuid()),
  })
  .strict();
export type DeleteContactBody = z.infer<typeof deleteContactBodySchema>;

export const contactRevocationSchema = z.object({
  grantIds: z.array(z.string().uuid()),
  state: z.enum(["pending", "applied", "retryable_failure"]),
});
export type ContactRevocation = z.infer<typeof contactRevocationSchema>;

export const deleteContactResponseSchema = z.object({
  contact: contactSchema,
  revocation: contactRevocationSchema,
});
export type DeleteContactResponse = z.infer<typeof deleteContactResponseSchema>;

export const revealedCbuSchema = z.object({
  id: z.string().uuid(),
  address: z.string().min(1),
});
export type RevealedCbu = z.infer<typeof revealedCbuSchema>;

/**
 * Design §9.2 endpoint schemas. Every one of them keeps the existing
 * `{ ok: true, data }` envelope and adds no wrapper object; the payload shapes
 * below are exactly what each route emits today.
 */
export const contactsResponseSchema = z.array(contactSchema);

export const createContactResponseSchema = contactSchema;

export const updateContactResponseSchema = contactSchema;

/**
 * `GET /v1/recipient-policy`. It carries the readiness snapshot verbatim: the
 * closed field set of design §9.1 is what a client may rely on, and design
 * §9.2's optional `appliedPolicyId` is deliberately NOT exposed here because it
 * is a provider policy identifier that no current read path resolves — see the
 * apply-progress deviation note for task 3.1.
 */
export const recipientPolicyResponseSchema = contactPermissionSchema;
export type RecipientPolicyResponse = z.infer<
  typeof recipientPolicyResponseSchema
>;

/** `POST /v1/recipient-policy/retry` (202): the post-retry readiness snapshot. */
export const recipientPolicyRetryResponseSchema = contactPermissionSchema;
export type RecipientPolicyRetryResponse = z.infer<
  typeof recipientPolicyRetryResponseSchema
>;

/** `GET /v1/contact-actions/:proposalId` — the review card's canonical row. */
export const contactActionProposalSchema = z.object({
  proposalId: z.string().uuid(),
  proposalVersion: z.number().int().positive(),
  action: z.enum(["create", "edit", "remove"]),
  contactId: z.string().uuid().nullable().optional(),
  contactVersion: z.number().int().positive().nullable().optional(),
  address: z.string().min(1),
  previousAddress: z.string().nullable().optional(),
  revokedGrantIds: z.array(z.string().uuid()),
  revocationDisclosure: z.string().nullable().optional(),
  expiresAt: z.string(),
  status: z.enum(["open", "consumed", "superseded", "expired"]),
});
export type ContactActionProposal = z.infer<typeof contactActionProposalSchema>;

/** `POST /v1/contact-actions/:proposalId/address` — the strict replacement body. */
export const replaceContactActionAddressInputSchema = z
  .object({
    address: z.string().trim().min(1),
    expectedProposalVersion: z.number().int().positive(),
  })
  .strict();
export type ReplaceContactActionAddressInput = z.infer<
  typeof replaceContactActionAddressInputSchema
>;

export const contactActionAddressResponseSchema = z.object({
  proposalId: z.string().uuid(),
  proposalVersion: z.number().int().positive(),
  address: z.string().min(1),
});
export type ContactActionAddressResponse = z.infer<
  typeof contactActionAddressResponseSchema
>;

/** PEW-005: identity != wallet readiness. These are the possible per-wallet states. */
export const walletReadinessStateSchema = z.enum([
  "unprovisioned",
  "provisioning",
  "ready",
  "recovery_required",
  "conflict",
  "unavailable",
]);

// WP-007: stable business error codes for the personal balance surface.
export const BALANCE_DATA_INVALID_CODE = "WALLET_DATOS_INVALIDOS";
export const BALANCE_UNAVAILABLE_CODE = "BALANCE_NO_DISPONIBLE";
export type WalletReadinessState = z.infer<typeof walletReadinessStateSchema>;

export const currentWalletResponseSchema = z.object({
  userId: z.string().uuid(),
  state: walletReadinessStateSchema,
  address: z.string(),
  chainFamily: z.string(),
  provider: z.string(),
});
export type CurrentWalletResponse = z.infer<typeof currentWalletResponseSchema>;

export const walletSyncResponseSchema = z.object({
  userId: z.string().uuid(),
  state: walletReadinessStateSchema,
  address: z.string(),
  created: z.boolean(),
});
export type WalletSyncResponse = z.infer<typeof walletSyncResponseSchema>;

/** PEW-013: permission lifecycle is separate from login and payment confirmation. */
export const permissionStateSchema = z.enum([
  "pending",
  "active",
  "revoking",
  "revoked",
  "unavailable",
]);
export type PermissionState = z.infer<typeof permissionStateSchema>;

/**
 * Chain selector for the wallet/permission surface. OPTIONAL everywhere it is
 * accepted: an absent selector preserves the legacy `arc` behaviour, and only
 * these two families are valid (anything else is a 422, never a 500).
 */
export const walletChainFamilySchema = z.enum(["arc", "solana"]);
export type WalletChainFamily = z.infer<typeof walletChainFamilySchema>;

export const walletPermissionResponseSchema = z.object({
  userId: z.string().uuid(),
  state: permissionStateSchema,
  perTransferUsdc: z.string(),
  perTransferSol: z.string(),
  rollingTotalUsdc: z.string(),
  rollingWindowSeconds: z.number().int(),
  gasCeiling: z.string(),
  recipients: z.array(z.string()),
  aggregateOvershootCaveat: z.boolean(),
  // PEW-014: rolling-window aggregation remains provider-unproven (parent gate)
  // and is surfaced as a hard block on payments, never silently hidden.
  aggregationReady: z.boolean().optional(),
  aggregateBlockReason: z.string().optional(),
});
export type WalletPermissionResponse = z.infer<
  typeof walletPermissionResponseSchema
>;

export const walletRevokeResponseSchema = z.object({
  userId: z.string().uuid(),
  state: permissionStateSchema,
  remote: z.enum(["revoked", "unavailable"]),
});
export type WalletRevokeResponse = z.infer<typeof walletRevokeResponseSchema>;

export const activateWalletPermissionInputSchema = z.object({
  // Explicit recipient allowlist (PEW-007/Q3): the user authorizes exactly these.
  recipients: z.array(z.string().trim().min(1)).min(1),
  // Optional chain selector; absent means the legacy `arc` wallet.
  chain: walletChainFamilySchema.optional(),
});
export type ActivateWalletPermissionInput = z.infer<
  typeof activateWalletPermissionInputSchema
>;

/** PEW-014: signer enrollment prepare posts the explicit recipient allowlist. */
export const enrollmentPrepareInputSchema = z.object({
  recipients: z.array(z.string().trim().min(1)).min(1),
});
export type EnrollmentPrepareInput = z.infer<
  typeof enrollmentPrepareInputSchema
>;

export const enrollmentPreparationResponseSchema = z.object({
  walletId: z.string().uuid(),
  walletAddress: z.string(),
  walletChainFamily: z.enum(["arc", "solana"]),
  policyId: z.string(),
  quorumId: z.string(),
  perTransferUsdc: z.string(),
  perTransferSol: z.string(),
  rollingTotalUsdc: z.string(),
  windowSeconds: z.number().int(),
  aggregationReady: z.literal(false),
  aggregateBlockReason: z.string(),
});
export type EnrollmentPreparationResponse = z.infer<
  typeof enrollmentPreparationResponseSchema
>;

export const enrollmentCompleteInputSchema = z.object({
  walletId: z.string().uuid(),
  // Optional consistency guard: when present, the wallet must belong to it.
  chain: walletChainFamilySchema.optional(),
});
export type EnrollmentCompleteInput = z.infer<
  typeof enrollmentCompleteInputSchema
>;

/**
 * Revoke input. The body is optional (existing callers post `{}` or nothing);
 * the selector scopes the revoke to one chain family, defaulting to `arc`.
 */
export const walletRevokeInputSchema = z.object({
  chain: walletChainFamilySchema.optional(),
});
export type WalletRevokeInput = z.infer<typeof walletRevokeInputSchema>;

export const enrollmentCompleteResponseSchema = z.object({
  verified: z.boolean(),
  state: permissionStateSchema,
  // Full permission summary only when read-back proof succeeded.
  permission: walletPermissionResponseSchema.optional(),
  // Observed read-back fields when proof could not be established (honest
  // evidence, never a fabricated success flag).
  observed: z
    .object({
      walletOwnerMatches: z.boolean(),
      policyAttached: z.boolean(),
      observedPolicyIds: z.array(z.string()),
      observedSignerIds: z.array(z.string()),
    })
    .optional(),
});
export type EnrollmentCompleteResponse = z.infer<
  typeof enrollmentCompleteResponseSchema
>;

// WP-004..WP-007: personal SOL balance surface. The catalog is closed on the
// server (Solana devnet, native SOL with nine decimals); the client can never
// select chain, token or owner.
//
// `chainId` is a STRING carrying the CAIP-2 chain identifier (the same constant
// the Solana devnet provider uses), not an EIP-155 numeric chain id: Solana has
// no EIP-155 chain id and CAIP-2 is the honest, standard identifier for it. The
// field NAME stays `chainId` to limit churn, and the client uses the value only
// as a cache-key value, never as display data.
export const balanceAssetSchema = z.object({
  // Solana's native asset has no token contract, so there is no contract
  // address to publish: the CAIP-2 identifier of the single chain this closed
  // surface serves identifies the asset, and `contract` says `native` instead
  // of pretending an address exists.
  tokenId: z.literal(SOLANA_DEVNET_CAIP2),
  contract: z.literal("native"),
  symbol: z.literal("SOL"),
  name: z.literal("Solana"),
  decimals: z.literal(9),
  balanceAtomic: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, "canonical decimal lamport string"),
});
export type BalanceAsset = z.infer<typeof balanceAssetSchema>;

// Base58 shape of a Solana address (same alphabet/length the provider's
// recipient guard uses); the service validates it with isValidSolanaAddress
// before any ready payload is produced.
const base58AddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const balancesReadyDataSchema = z.object({
  walletState: z.literal("ready"),
  address: base58AddressSchema,
  chainId: z.literal(SOLANA_DEVNET_CAIP2),
  networkName: z.literal("Solana devnet"),
  testnet: z.literal(true),
  source: z.enum(["fixture", "rpc"]),
  observedAt: z.string(),
  assets: z.tuple([balanceAssetSchema]),
});
export type BalancesReadyData = z.infer<typeof balancesReadyDataSchema>;

// Non-ready variants omit address/source and never report an amount
// (WP-005): assets is empty and observedAt is null.
export const balancesNotReadyDataSchema = z.object({
  walletState: walletReadinessStateSchema.exclude(["ready"]),
  chainId: z.literal(SOLANA_DEVNET_CAIP2),
  networkName: z.literal("Solana devnet"),
  testnet: z.literal(true),
  observedAt: z.literal(null),
  assets: z.tuple([]),
});
export type BalancesNotReadyData = z.infer<typeof balancesNotReadyDataSchema>;

export const balancesDataSchema = z.discriminatedUnion("walletState", [
  balancesReadyDataSchema,
  balancesNotReadyDataSchema,
]);
export type BalancesData = z.infer<typeof balancesDataSchema>;

// DGC-5: delegated grants lifecycle (Slice 1). Amounts are decimal strings in
// the grant chain's smallest unit (lamports for native SOL); never numbers.
export const delegatedGrantActionSchema = z.literal("transfer");
export type DelegatedGrantAction = z.infer<typeof delegatedGrantActionSchema>;

export const delegatedGrantStateSchema = z.enum(["active", "revoked", "expired"]);
export type DelegatedGrantState = z.infer<typeof delegatedGrantStateSchema>;

export const delegatedGrantResponseSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  action: delegatedGrantActionSchema,
  chain: z.string().min(1),
  maxPerTransfer: z.string().regex(/^\d+$/),
  maxCumulative: z.string().regex(/^\d+$/),
  windowSeconds: z.number().int().positive(),
  recipients: z.array(z.string().min(1)),
  state: delegatedGrantStateSchema,
  policyReady: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type DelegatedGrantResponse = z.infer<typeof delegatedGrantResponseSchema>;

export const createDelegatedGrantRequestSchema = z
  .object({
    action: delegatedGrantActionSchema,
    chain: z.string().min(1),
    maxPerTransfer: z.string().regex(/^\d+$/, "must be a plain decimal string"),
    maxCumulative: z.string().regex(/^\d+$/, "must be a plain decimal string"),
    windowSeconds: z.number().int().positive(),
    recipients: z.array(z.string().min(1)).max(50),
    // RFC 3339 timestamp; the grant MUST expire.
    expiresAt: z.string().datetime(),
  })
  .superRefine((grant, context) => {
    if (grant.chain !== "solana") return;
    if (BigInt(grant.maxPerTransfer) > 10_000_000n) {
      context.addIssue({
        code: "custom",
        path: ["maxPerTransfer"],
        message: "Solana maxPerTransfer cannot exceed 0.01 SOL (10,000,000 lamports).",
      });
    }
  })
  .strict();
export type CreateDelegatedGrantRequest = z.infer<typeof createDelegatedGrantRequestSchema>;

export const createDelegatedGrantResponseSchema = z.object({
  grant: delegatedGrantResponseSchema,
});
export type CreateDelegatedGrantResponse = z.infer<typeof createDelegatedGrantResponseSchema>;

export const listDelegatedGrantsResponseSchema = z.object({
  grants: z.array(delegatedGrantResponseSchema),
});
export type ListDelegatedGrantsResponse = z.infer<typeof listDelegatedGrantsResponseSchema>;

export const revokeDelegatedGrantResponseSchema = z.object({
  grant: delegatedGrantResponseSchema,
});
export type RevokeDelegatedGrantResponse = z.infer<typeof revokeDelegatedGrantResponseSchema>;

// DGC-6: the model-facing result of a Nani-initiated grant creation. `policyReady`
// is reported honestly — a created grant whose provider policy could not be
// provisioned stays non-executable, and the narration says so.
export const naniGrantCreationResultSchema = z.object({
  status: z.enum(["created", "error"]),
  message: z.string().min(1),
  code: z.string().min(1).optional(),
  grantId: z.string().uuid().optional(),
  maxPerTransfer: z.string().min(1).optional(),
  policyReady: z.boolean().optional(),
});
export type NaniGrantCreationResult = z.infer<typeof naniGrantCreationResultSchema>;
