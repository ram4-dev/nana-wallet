import type { ConversationRepository } from "../conversations/repository.js";
import type {
  ConversationEvent,
  WalletConversationService,
} from "../conversations/service.js";
import {
  verifyLiveVoiceBinding,
  type LiveVoiceBindingClaims,
} from "../auth/live-binding.js";
import { DeferredTurnQueue } from './deferred-turn.js';
import { isCancellation, isConfirmation } from './resolution-phrases.js';

export type RoomConversationResult =
  | { ok: true; conversationId: string; revision: number }
  | {
      ok: false;
      code:
        | "invalid_binding"
        | "expired_binding"
        | "conversation_not_found"
        | "conversation_forbidden"
        | "conversation_already_live"
        | "not_bound";
    };

export type RoomConversationGate = {
  bind(
    input: Parameters<RoomConversation["bind"]>[0],
  ): Promise<RoomConversationResult>;
  handleFinalTranscript(
    text: string,
  ): AsyncIterable<ConversationEvent | { ok: false; code: "not_bound" }>;
};

export class RoomConversation {
  private binding: LiveVoiceBindingClaims | undefined;
  private lease:
    | {
        conversationId: string;
        userId: string;
        bindingJti: string;
        participantIdentity: string;
        workerId: string;
      }
    | undefined;
  private readonly deferredTurns: DeferredTurnQueue;
  private activeWork = false;
  public constructor(
    private readonly dependencies: {
      publicKey: string;
      conversations: ConversationRepository;
      service: WalletConversationService;
      leaseDurationMs?: number;
      deferredTurns?: DeferredTurnQueue;
    },
  ) {
    this.deferredTurns = dependencies.deferredTurns ?? new DeferredTurnQueue();
  }

  public async bind(input: {
    token: string;
    participantIdentity?: string;
    participantUserId?: string;
    workerId?: string;
  }): Promise<RoomConversationResult> {
    try {
      const binding = await verifyLiveVoiceBinding({
        token: input.token,
        publicKey: this.dependencies.publicKey,
      });
      const participantIdentity =
        input.participantIdentity ?? input.participantUserId;
      if (participantIdentity && participantIdentity !== binding.sub)
        return { ok: false, code: "conversation_forbidden" };
      const snapshot = await this.dependencies.conversations.get(
        binding.sub,
        binding.conversationId,
      );
      if (!snapshot) return { ok: false, code: "conversation_not_found" };
      this.binding = binding;
      if (
        input.workerId &&
        participantIdentity &&
        this.dependencies.conversations.acquireLiveLease
      ) {
        const expiresAt = new Date(
          Date.now() + (this.dependencies.leaseDurationMs ?? 30_000),
        ).toISOString();
        const leaseResult =
          await this.dependencies.conversations.acquireLiveLease({
            conversationId: binding.conversationId,
            userId: binding.sub,
            bindingJti: binding.jti,
            participantIdentity,
            workerId: input.workerId,
            expiresAt,
          });
        if (leaseResult.status === "already_live") {
          this.binding = undefined;
          return { ok: false, code: "conversation_already_live" };
        }
        if (leaseResult.status !== "acquired") {
          this.binding = undefined;
          return { ok: false, code: "conversation_forbidden" };
        }
        this.lease = {
          conversationId: binding.conversationId,
          userId: binding.sub,
          bindingJti: binding.jti,
          participantIdentity,
          workerId: input.workerId,
        };
        return {
          ok: true,
          conversationId: snapshot.id,
          revision: leaseResult.revision,
        };
      }
      return {
        ok: true,
        conversationId: snapshot.id,
        revision: snapshot.revision,
      };
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof Error && error.message === "expired_binding"
            ? "expired_binding"
            : "invalid_binding",
      };
    }
  }

  public async *handleFinalTranscript(text: string) {
    if (!this.binding) {
      yield { ok: false as const, code: "not_bound" as const };
      return;
    }
    if (this.activeWork) {
      if (this.deferredTurns.enqueue(text)) {
        yield {
          type: 'state-revision' as const,
          revision: await this.currentRevision(),
          activity: 'request_waiting' as const,
        };
      }
      return;
    }
    yield* this.processTranscript(text);
  }

  public async release(): Promise<void> {
    this.deferredTurns.clear();
    this.activeWork = false;
    if (this.lease && this.dependencies.conversations.releaseLiveLease) {
      await this.dependencies.conversations.releaseLiveLease(this.lease);
    }
    this.lease = undefined;
    this.binding = undefined;
  }

  public async renew(): Promise<boolean> {
    if (!this.lease || !this.dependencies.conversations.renewLiveLease)
      return false;
    const expiresAt = new Date(
      Date.now() + (this.dependencies.leaseDurationMs ?? 30_000),
    ).toISOString();
    return this.dependencies.conversations.renewLiveLease({
      ...this.lease,
      expiresAt,
    });
  }

  public get boundIdentity():
    { conversationId: string; userId: string } | undefined {
    return this.binding
      ? {
          conversationId: this.binding.conversationId,
          userId: this.binding.sub,
        }
      : undefined;
  }

  public get deferredTurn(): string | undefined {
    return this.deferredTurns.peek();
  }

  public async resolvePendingDecision(
    text: string,
  ): Promise<AsyncIterable<ConversationEvent> | undefined> {
    if (!this.binding) return undefined;
    const decision = isConfirmation(text)
      ? 'confirm'
      : isCancellation(text)
        ? 'cancel'
        : undefined;
    if (!decision) return undefined;
    const snapshot = await this.dependencies.conversations.get(
      this.binding.sub,
      this.binding.conversationId,
    );
    const previewId = snapshot?.pendingTransfer?.previewId;
    if (!previewId) return undefined;
    return this.dependencies.service.resolveDecision({
      conversationId: this.binding.conversationId,
      userId: this.binding.sub,
      previewId,
      decision,
    });
  }

  private async currentRevision(): Promise<number> {
    if (!this.binding) return 0;
    const snapshot = await this.dependencies.conversations.get(
      this.binding.sub,
      this.binding.conversationId,
    );
    return snapshot?.revision ?? 0;
  }

  private async *processTranscript(text: string): AsyncIterable<ConversationEvent> {
    if (!this.binding) return;
    this.activeWork = true;
    let completedResult:
      | Extract<ConversationEvent, { type: 'turn-completed' }>['result']
      | undefined;
    let failed = true;
    try {
      const decisionEvents = await this.resolvePendingDecision(text);
      const events = decisionEvents ?? this.dependencies.service.handleTurnStream({
        conversationId: this.binding.conversationId,
        userId: this.binding.sub,
        text,
      });
      for await (const event of events) {
        if (event.type === 'turn-completed') completedResult = event.result;
        yield event;
      }
      failed = false;
    } finally {
      this.activeWork = false;
      if (failed) {
        // A crashed/reassigned worker must never replay ephemeral speech.
        this.deferredTurns.clear();
      }
    }

    const deferred = this.deferredTurns.take();
    if (!deferred || !this.binding) return;
    if (completedResult?.status === 'confirmation_required' &&
      !isConfirmation(deferred) && !isCancellation(deferred)) {
      // The service will return pending_confirmation. Consuming the item here
      // keeps the preview a hard gate and prevents a second wallet action.
    }
    yield* this.processTranscript(deferred);
  }
}

/**
 * Keeps room transcript delivery behind the binding and session-start barrier.
 * The same gate is used by the worker and by deterministic room tests.
 */
export function createRoomConversationGate(input: {
  conversation: RoomConversation;
  startSession: (binding: {
    conversationId: string;
    userId: string;
  }) => Promise<void>;
}): RoomConversationGate {
  let ready = false;
  return {
    async bind(bindingInput) {
      const result = await input.conversation.bind(bindingInput);
      if (!result.ok) return result;
      const binding = input.conversation.boundIdentity;
      if (!binding) return { ok: false, code: "invalid_binding" };
      try {
        await input.startSession(binding);
        ready = true;
        return result;
      } catch {
        await input.conversation.release();
        return { ok: false, code: "invalid_binding" };
      }
    },
    async *handleFinalTranscript(text) {
      if (!ready) {
        yield { ok: false as const, code: "not_bound" as const };
        return;
      }
      yield* input.conversation.handleFinalTranscript(text);
    },
  };
}

export function createBindingRpcHandler(input: {
  gate: RoomConversationGate;
  workerId: string;
  onResult?: (result: RoomConversationResult) => void;
}) {
  return async (data: {
    payload: string;
    callerIdentity: string;
  }): Promise<string> => {
    let payload: { bindingToken?: unknown };
    try {
      payload = JSON.parse(data.payload) as { bindingToken?: unknown };
    } catch {
      const result = { ok: false as const, code: "invalid_binding" as const };
      input.onResult?.(result);
      return JSON.stringify(result);
    }
    if (typeof payload.bindingToken !== "string") {
      const result = { ok: false as const, code: "invalid_binding" as const };
      input.onResult?.(result);
      return JSON.stringify(result);
    }
    const result = await input.gate.bind({
      token: payload.bindingToken,
      participantIdentity: data.callerIdentity,
      workerId: input.workerId,
    });
    input.onResult?.(result);
    return JSON.stringify(result);
  };
}
