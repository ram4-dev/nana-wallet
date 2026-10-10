import { Agent, AgentSession } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import type { ToolContextLike } from "@livekit/agents";
import { attachRealtimeLatencyLogging } from "./realtime-latency-logger.js";

const NANI_REALTIME_INSTRUCTIONS = `You are Nani, the voice assistant of a crypto wallet. You speak Rioplatense Spanish (voseo), briefly, warmly and directly.
Opening turn: the first turn of every session is yours — it is generated before the user speaks. Greet once per session and never repeat the introduction later.
Financial tools:
- get_balance: call it with NO arguments whenever the user asks about balances: it returns a JSON with every network's balance in one shot. NEVER ask the user which wallet or network they mean. From that result, read aloud ONLY the balance the user asked about (all of them only if the user asked for everything); if a network shows an error, mention it is temporarily unavailable. Always speak in the current language.
- search_recipients: look up a contact by name when asked to send money to someone. Never invent or show addresses: use only the names the tool returns. Use clarification_required with several candidates to read the names back and ask which one. With a single candidate go straight to send_token: never ask your own "is this the contact?" question, because a "yes" to that question is not a transfer confirmation. Never tell the user a contact does not exist when the result includes candidates.
- send_token: call it ONLY after the contact is resolved (recipientId + recipientVersion) by the contact search, and always before any confirmation. Pass the amount and those contact fields. NEVER invent addresses. The server reads back the exact amount, saved name, network, and estimated fee and asks for a clear yes/no; do not repeat that read-back or ask again.
- confirm_transfer: it acts ONLY on a preview that send_token created in THIS SAME conversation, so it fails when send_token never ran or returned an error; when that happens, call send_token instead of insisting. Call it only after that read-back happened and the user then explicitly said an exact confirmation such as "yes" or "sí". A "yes" answering any other question of yours is NOT a transfer confirmation. It takes no parameters. A tool call by itself is not user authorization.
- cancel_transfer: call it when the user wants to cancel the pending transfer.
Golden rules: a transfer confirmation goes EXCLUSIVELY through confirm_transfer. Never confirm in text and never invent an address. When a tool returns a typed error (policy_rejected, recipient_revalidation_required, stale_preview, etc.), narrate the message in the current language, without inventing details.`;

export type AgentSessionComposition = {
  session: AgentSession;
  agent: Agent;
  /**
   * Generates the session's opening greeting turn (see
   * `NANI_GREETING_INSTRUCTIONS`), at most once per session.
   *
   * Call it right after `session.start()` resolved: the greeting must be the
   * first turn of the session, and `generateReply` refuses to run while the
   * session is not running. The session is marked as greeted BEFORE the dispatch
   * happens, so a re-run of the start path (reconnect/resume) can never greet
   * twice, not even when the provider rejects the greeting.
   *
   * Returns `true` when this call dispatched the greeting, `false` when the
   * session had already greeted. Provider errors propagate: the caller decides
   * how loud an unspoken greeting is.
   */
  speakGreeting: () => boolean;
};

/**
 * Instruction for the session's opening turn, appended to
 * `NANI_REALTIME_INSTRUCTIONS` for that turn only.
 *
 * It is an instruction and not a fixed sentence on purpose: the greeting has to
 * read the REAL balance, so the model must call `get_balance` itself. A hardcoded
 * string could only invent a figure.
 */
const NANI_GREETING_INSTRUCTIONS = `Session opening turn: the user has NOT spoken yet and is waiting for you, so YOU speak first.
Do it now, in Rioplatense Spanish (voseo), warm and brief, in this exact order:
1. Introduce yourself: you are Nani, the assistant of the user's wallet.
2. Call the get_balance tool with NO arguments and read aloud the available balance it returns, following the get_balance rules above. NEVER invent, estimate or round a figure, and never ask which wallet or network: if the tool or a network fails, say the balance is temporarily unavailable right now and keep going.
3. Close by offering exactly these three next steps, in this order: "ver mi saldo", "hacer una transferencia", "ver mis últimos movimientos". Never offer a swap or any other action: those three are all you can do.
Never mention tools, providers, networks or internal states. Say it once, then stop and listen.`;

export function createAgentSession(options: {
  tools: ToolContextLike;
}): AgentSessionComposition {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for the openai-realtime voice provider.",
    );
  }
  const llm = new openai.realtime.RealtimeModel({
    model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
    voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
    apiKey,
  });
  const agent = new Agent({
    instructions: NANI_REALTIME_INSTRUCTIONS,
    llm,
    tools: options.tools,
  });
  const session = new AgentSession({ llm });
  attachRealtimeLatencyLogging(session);
  let greetingSpent = false;
  return {
    session,
    agent,
    speakGreeting: () => {
      // Marked before dispatching: the greeting is at-most-once per session even
      // if the provider throws, so no caller can turn it into a retry loop.
      if (greetingSpent) return false;
      greetingSpent = true;
      session.generateReply({
        instructions: NANI_GREETING_INSTRUCTIONS,
        allowInterruptions: true,
      });
      return true;
    },
  };
}
