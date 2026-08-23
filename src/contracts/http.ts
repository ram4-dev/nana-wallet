import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  mcp: z.enum(['connected', 'disconnected', 'unknown']),
  wallet: z.enum(['unlocked', 'locked', 'unknown']),
  network: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const walletAddressResponseSchema = z.object({
  network: z.string(),
  address: z.string(),
});
export type WalletAddressResponse = z.infer<typeof walletAddressResponseSchema>;

export const walletBalanceQuerySchema = z.object({
  network: z.string(),
  token: z.string().optional(),
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
  network: z.string(),
  token: z.string().optional(),
});
export type WalletHistoryQuery = z.infer<typeof walletHistoryQuerySchema>;

export const walletTransactionSchema = z.object({
  hash: z.string(),
  direction: z.enum(['in', 'out']),
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

export const createSessionResponseSchema = z.object({
  sessionId: z.string(),
  status: z.literal('active'),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sessionMessageRequestSchema = z.object({
  message: z.string().min(1),
});
export type SessionMessageRequest = z.infer<typeof sessionMessageRequestSchema>;

export const transferPreviewSchema = z.object({
  network: z.string(),
  token: z.string(),
  recipient: z.string(),
  amount: z.string(),
  estimatedFee: z.string(),
});
export type TransferPreview = z.infer<typeof transferPreviewSchema>;

export const transactionResultSchema = z.object({
  network: z.string(),
  transactionHash: z.string(),
  explorerUrl: z.string(),
});
export type TransactionResult = z.infer<typeof transactionResultSchema>;

export const sessionMessageResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('answer'), message: z.string() }),
  z.object({
    status: z.literal('clarification_required'),
    message: z.string(),
    candidates: z.array(z.object({
      id: z.string().uuid(),
      name: z.string(),
      description: z.string(),
      version: z.number().int().positive(),
      evidence: z.string().optional(),
      score: z.number().optional(),
    })),
  }),
  z.object({
    status: z.literal('confirmation_required'),
    message: z.string(),
    preview: transferPreviewSchema,
  }),
  z.object({
    status: z.literal('sent'),
    message: z.string(),
    transaction: transactionResultSchema,
  }),
  z.object({ status: z.literal('cancelled'), message: z.string() }),
  z.object({ status: z.literal('error'), message: z.string(), code: z.string() }),
]);
export type SessionMessageResponse = z.infer<typeof sessionMessageResponseSchema>;

export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
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
});
export type PendingTransfer = z.infer<typeof pendingTransferSchema>;

export const recipientMemoryInspectionSchema = z.object({
  selectedRecipient: z.object({
    recipientId: z.string().uuid(),
    version: z.number().int().positive(),
  }).optional(),
  clarification: z.array(z.object({
    recipientId: z.string().uuid(),
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
  })).optional(),
  pendingWrite: z.object({ expiresAt: z.string() }).optional(),
});
export type RecipientMemoryInspection = z.infer<typeof recipientMemoryInspectionSchema>;

export const sessionInspectResponseSchema = z.object({
  id: z.string(),
  messages: z.array(conversationMessageSchema),
  pendingTransfer: pendingTransferSchema.optional(),
  recipientMemory: recipientMemoryInspectionSchema.optional(),
  lastTransactionHash: z.string().optional(),
  createdAt: z.string(),
});
export type SessionInspectResponse = z.infer<typeof sessionInspectResponseSchema>;

export const errorResponseSchema = z.object({
  status: z.literal('error'),
  message: z.string(),
  code: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
