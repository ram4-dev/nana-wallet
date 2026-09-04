import type { AgentSession } from "@livekit/agents";
import type { ConversationEvent } from "../conversations/service.js";

export type NativeDecisionRouter = (
  text: string,
) => Promise<AsyncIterable<ConversationEvent> | undefined>;

export async function routeNativeTextTurn(input: {
  session: Pick<AgentSession, "interrupt" | "generateReply">;
  text: string;
  resolvePendingDecision: NativeDecisionRouter;
  onDecisionRouted?: () => void;
}): Promise<void> {
  const events = await input.resolvePendingDecision(input.text);
  if (!events) {
    await input.session.interrupt({ force: true });
    input.session.generateReply({ userInput: input.text });
    return;
  }

  input.onDecisionRouted?.();
  await input.session.interrupt({ force: true });
  for await (const _event of events) {
    // Consuming the durable stream applies cancellation or claim state before
    // RoomIO can schedule another model reply.
  }
}
