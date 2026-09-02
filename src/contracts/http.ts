import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  mode: z.enum(["fixture", "live"]),
  mcp: z.enum(["connected", "disconnected", "unknown"]),
  wallet: z.enum(["unlocked", "locked", "unknown"]),
  network: z.string(),
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

export const agentTranscribeRequestSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().refine((value) => value.startsWith("audio/"), {
    message: "mimeType must be an audio/* type",
  }),
});
export type AgentTranscribeRequest = z.infer<
  typeof agentTranscribeRequestSchema
>;

export const agentTranscribeResponseSchema = z.object({
  transcript: z.string(),
});
export type AgentTranscribeResponse = z.infer<
  typeof agentTranscribeResponseSchema
>;

export const voiceSpeakRequestSchema = z.object({
  text: z.string().min(1),
});
export type VoiceSpeakRequest = z.infer<typeof voiceSpeakRequestSchema>;
