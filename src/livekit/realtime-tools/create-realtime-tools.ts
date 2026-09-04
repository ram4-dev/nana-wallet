import { tool } from "@livekit/agents";
import { z } from "zod";
import { getWalletAgentConfig } from "../../agent/instructions.js";
import type { RecipientMemoryService, RecipientSearchResult } from "../../memory/service.js";
import type { RecipientCandidate } from "../../memory/types.js";
import type { WalletProvider } from "../../wallet/provider.js";
import type { ConversationRepository } from "../../conversations/repository.js";
import type { WalletConversationService } from "../../conversations/service.js";
import type { ConversationTurnResult } from "../../contracts/http.js";

/**
 * Dependencies used to build the realtime voice tools for a single conversation.
 *
 * `userId` is the binding user (`binding.sub`) — NEVER the demo-tenant singleton.
 * `recipientMemory` is a shared tenant-agnostic service; the tenant is scoped per
 * call by passing `userId` to `searchRecipients`. When memory is unavailable the
 * `search_contacts` tool fails closed to `unavailable` rather than inventing data.
 *
 * `service` is the per-binding conversation service built in the worker with the
 * binding user's memory runtime. The financial tools (`send_token`, `confirm_transfer`,
 * `cancel_transfer`) are a door to that service — they never reimplement guards. The
 * service emits state revisions through the shared `financialTasks`/progress publish
 * path, so the frontend card appears without any publish logic living in livekit.
 */
export type RealtimeToolsDependencies = {
  conversationId: string;
  userId: string;
  wallet: WalletProvider;
  recipientMemory?: RecipientMemoryService;
  service?: WalletConversationService;
  conversations?: ConversationRepository;
  /** Retained for seam stability; the service publishes revisions via financialTasks. */
  publishRevision?: (revision: number) => void;
};

/** A contact candidate exposed to the model — never contains address or userId. */
export type RealtimeContactCandidate = {
  id: string;
  name: string;
  normalizedName: string;
  description: string;
  version: number;
  status: "active" | "inactive";
  evidence: string;
  score: number;
};

export type RealtimeSearchContactsResult = {
  query: string;
  count: number;
  ambiguous: boolean;
  status: RecipientSearchResult["status"];
  contacts: RealtimeContactCandidate[];
};

export type RealtimeBalanceResult = {
  network: string;
  token: string;
  address: string;
  balance: string;
};

/**
 * A model-facing (address-free) financial tool result. The recipient address only ever
 * travels inside the service machinery; the model receives amount/token/status/message
 * plus typed errors it can narrate in plain Spanish.
 */
export type RealtimeVoiceToolResult = {
  status: "confirmation_required" | "sent" | "cancelled" | "error";
  message: string;
  code?: string;
  amount?: string;
  token?: string;
  transactionHash?: string;
};

/**
 * REVIEW FIX V6: the voice `send_token` schema is preview-only and enforced by zod.
 * It accepts ONLY `{ amount, recipientId, recipientVersion, memo? }` — no `dryRun`,
 * no free-form `to` address, no network/token/wallet (the configured wallet is used
 * internally). `.strict()` rejects any unknown field so a model inventing a `to` or
 * a `dryRun` flag fails closed at the schema boundary, never reaching the service.
 */
const sendTokenSchema = z
  .object({
    amount: z.string().trim().min(1),
    recipientId: z.string().trim().min(1),
    recipientVersion: z.number().int().positive(),
    memo: z.string().trim().max(200).optional(),
  })
  .strict();
type SendTokenInput = z.infer<typeof sendTokenSchema>;

const confirmationSchema = z.object({}).strict();
const cancelSchema = z.object({}).strict();

/**
 * Deliberately strips every field that could leak a payee address or another user's
 * identity. `RecipientCandidate` already omits `address`/`userId`, but rebuilding the
 * object here keeps the model-facing payload contract explicit and future-proof: if a
 * candidate ever grows a sensitive field it will not leak unless added here on purpose.
 */
function stripCandidate(candidate: RecipientCandidate): RealtimeContactCandidate {
  return {
    id: candidate.id,
    name: candidate.name,
    normalizedName: candidate.normalizedName,
    description: candidate.description,
    version: candidate.version,
    status: candidate.status,
    evidence: candidate.evidence,
    score: candidate.score,
  };
}

/** Map the service classification faithfully onto the model-facing result shape. */
function toSearchContactsResult(
  query: string,
  result: RecipientSearchResult,
): RealtimeSearchContactsResult {
  if (result.status === "unavailable") {
    return { query, count: 0, ambiguous: false, status: "unavailable", contacts: [] };
  }
  const contacts = result.candidates.map(stripCandidate);
  return {
    query,
    count: contacts.length,
    ambiguous: result.status === "clarification_required",
    status: result.status,
    contacts,
  };
}

/**
 * Map a service `ConversationTurnResult` onto an address-free tool result. The
 * `preview.recipient` address is deliberately dropped: the model never needs it and
 * the privacy invariant keeps the address book inside the machinery.
 */
function toVoiceToolResult(result: ConversationTurnResult): RealtimeVoiceToolResult {
  switch (result.status) {
    case "confirmation_required":
      return {
        status: "confirmation_required",
        message: result.message,
        amount: result.preview.amount,
        token: result.preview.token,
      };
    case "sent":
      return {
        status: "sent",
        message: result.message,
        transactionHash: result.transaction.transactionHash,
      };
    case "cancelled":
      return { status: "cancelled", message: result.message };
    case "error":
      return { status: "error", code: result.code, message: result.message };
    default:
      return {
        status: "error",
        code: "internal_error",
        message: result.message,
      };
  }
}

/**
 * Builds the realtime voice tools bound to one conversation. Tools are closures over
 * the deps so each room gets the correct wallet/tenant/service without global lookups.
 */
export function createRealtimeTools(dependencies: RealtimeToolsDependencies) {
  const config = getWalletAgentConfig();

  const getBalanceTool = tool({
    name: "get_balance",
    description:
      "Returns the current balance of the connected wallet for the default token. Takes no input.",
    parameters: z.object({}),
    execute: async (): Promise<RealtimeBalanceResult> => {
      const balance = await dependencies.wallet.getBalance({
        network: config.network,
        token: config.token,
        wallet: config.wallet,
      });
      return {
        network: balance.network,
        token: balance.token ?? config.token,
        address: balance.address,
        balance: balance.balance,
      };
    },
  });

  const searchContactsTool = tool({
    name: "search_contacts",
    description:
      "Searches saved contacts by name. Returns matching candidates (never addresses), a count, and a status. Ask for clarification when ambiguous.",
    parameters: z.object({ query: z.string().trim().min(1) }),
    execute: async ({ query }): Promise<RealtimeSearchContactsResult> => {
      if (!dependencies.recipientMemory) {
        return {
          query,
          count: 0,
          ambiguous: false,
          status: "unavailable",
          contacts: [],
        };
      }
      const result = await dependencies.recipientMemory.searchRecipients(
        dependencies.userId,
        query,
      );
      return toSearchContactsResult(query, result);
    },
  });

  const sendTokenTool = tool({
    name: "send_token",
    description:
      "Prepares a transfer for explicit user confirmation. Takes the amount and the already-resolved recipient (recipientId + recipientVersion). Never takes an address, network, token, or dryRun. After the user agrees, call confirm_transfer.",
    parameters: sendTokenSchema,
    execute: async (input: SendTokenInput): Promise<RealtimeVoiceToolResult> => {
      if (!dependencies.service) {
        return {
          status: "error",
          code: "wallet_unavailable",
          message: "The wallet service is unavailable.",
        };
      }
      const result = await dependencies.service.previewTransfer({
        conversationId: dependencies.conversationId,
        userId: dependencies.userId,
        amount: input.amount,
        recipientId: input.recipientId,
        recipientVersion: input.recipientVersion,
      });
      return toVoiceToolResult(result);
    },
  });

  async function decideTransfer(
    decision: "confirm" | "cancel",
  ): Promise<RealtimeVoiceToolResult> {
    if (!dependencies.service || !dependencies.conversations) {
      return {
        status: "error",
        code: "wallet_unavailable",
        message: "The wallet service is unavailable.",
      };
    }
    // REVIEW FIX V1: read the CURRENT persisted preview each call — never capture it
    // at bind time, so a superseded/cancelled preview fails closed to stale_preview.
    const snapshot = await dependencies.conversations.get(
      dependencies.userId,
      dependencies.conversationId,
    );
    const previewId = snapshot?.pendingTransfer?.previewId;
    if (!previewId) {
      return {
        status: "error",
        code: "stale_preview",
        message: "There is no pending transfer to confirm or cancel.",
      };
    }
    let result: ConversationTurnResult | undefined;
    const iterable = dependencies.service.resolveDecision({
      conversationId: dependencies.conversationId,
      userId: dependencies.userId,
      previewId,
      decision,
      waitForFinancialTask: decision === "confirm",
    });
    for await (const event of iterable) {
      if (event.type === "turn-completed") result = event.result;
    }
    if (!result) {
      return {
        status: "error",
        code: "internal_error",
        message: "The transfer could not be resolved.",
      };
    }
    return toVoiceToolResult(result);
  }

  const confirmTransferTool = tool({
    name: "confirm_transfer",
    description:
      "Confirms the transfer currently awaiting the user's decision. Takes no parameters. Call ONLY after the user explicitly agrees.",
    parameters: confirmationSchema,
    execute: async (): Promise<RealtimeVoiceToolResult> => decideTransfer("confirm"),
  });

  const cancelTransferTool = tool({
    name: "cancel_transfer",
    description:
      "Cancels the transfer currently awaiting the user's decision. Takes no parameters. Call when the user wants to cancel.",
    parameters: cancelSchema,
    execute: async (): Promise<RealtimeVoiceToolResult> => decideTransfer("cancel"),
  });

  return [getBalanceTool, searchContactsTool, sendTokenTool, confirmTransferTool, cancelTransferTool] as const;
}
