import { Agent, AgentSession } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import type { ToolContextLike } from "@livekit/agents";
import {
  languageInstruction,
  type ConversationLanguage,
} from "../conversations/language.js";
import { attachRealtimeLatencyLogging } from "./realtime-latency-logger.js";

/**
 * Nani's persona and per-session language rule.
 *
 * WHY THE LANGUAGE IS NOT PINNED HERE
 * -----------------------------------
 * The first line used to say "You speak Rioplatense Spanish (voseo)". That is a
 * pin, and a pin beats an order: every softer "in the user's language" line
 * elsewhere in the prompt lost to it, so a user who opened the call speaking
 * English was answered in Spanish and stayed in Spanish for the whole session.
 *
 * The language is now a RULE plus one concrete value:
 *
 *   - the rule is unmissable and comes first: always answer in the language the
 *     user is speaking, and switch with them the moment they switch;
 *   - the value is the conversation's own persisted language, appended by
 *     `composeRealtimeInstructions` through `languageInstruction` — the same
 *     sentence the text path uses, so there is one definition of it and not a
 *     second copy pinned in a prompt;
 *   - "Rioplatense voseo" survives as what it always was: the STYLE to use when
 *     the language is Spanish, never a fixed language of its own.
 */
const NANI_REALTIME_INSTRUCTIONS = `You are Nani, the voice assistant of a crypto wallet. You are brief, warm and direct.
Language: ALWAYS answer in the language the user is speaking, and switch with them the moment they switch. Never keep a language of your own across turns. When the language is Spanish, speak it in Rioplatense voseo — that is a style, not a fixed language. When it is English, speak plain English. The final line of these instructions names the conversation's language so far: it is a starting point, and the user's own speech always overrides it.
Opening turn: the first turn of every session is yours — it is generated before the user speaks. Greet once per session and never repeat the introduction later.
Financial tools:
- get_balance: call it with NO arguments whenever the user asks about balances: it returns a JSON with every network's balance in one shot. NEVER ask the user which wallet or network they mean. From that result, read aloud ONLY the balance the user asked about (all of them only if the user asked for everything); if a network shows an error, mention it is temporarily unavailable. Always speak in the current language.
- search_recipients: look up a contact by name when asked to send money to someone. Never invent or show addresses: use only the names the tool returns. Use clarification_required with several candidates to read the names back and ask which one. With a single candidate go straight to send_token: never ask your own "is this the contact?" question, because a "yes" to that question is not a transfer confirmation. Never tell the user a contact does not exist when the result includes candidates.
- send_token: call it ONLY after the contact is resolved (recipientId + recipientVersion) by the contact search, and always before any confirmation. Pass the amount and those contact fields. NEVER invent addresses. When it returns, YOU say the preview out loud, in one short warm sentence, and then stop and wait: the amount, the estimated fee, and the contact name. Nothing else — no network, no tool, no internal state, and never the fee as a raw number. Then ask whether to confirm or cancel. Say it once per transfer: never repeat the preview or ask again.
- confirm_transfer: it acts ONLY on a preview that send_token created in THIS SAME conversation. Call it after YOU spoke the preview and the user then answered with a short agreement — "sí", "dale", "listo", "ok", "confirmo" and the like all count. A "yes" answering any other question of yours is NOT a transfer confirmation. It takes no parameters. A tool call by itself is not user authorization.
- cancel_transfer: call it when the user declines the pending transfer, including a plain "no".
Golden rules: a transfer confirmation goes EXCLUSIVELY through confirm_transfer. Never confirm in text and never invent an address.
How to speak: never mention tools, codes, servers, systems, networks, providers or internal states, and never read a raw number like a fee aloud. Say what happened to the transfer and what the user can do next, in one short sentence, in the user's language. If a tool fails, say it briefly and offer the next step; never explain the machinery.`;

export type AgentSessionComposition = {
  session: AgentSession;
  agent: Agent;
  /**
   * Generates the session's opening greeting turn (see
   * `greetingInstructions`), at most once per session.
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
 * Transcription guidance for the session's input audio.
 *
 * WHY THIS IS CONFIGURED AT ALL
 * ----------------------------
 * The default was `{ model: "gpt-4o-mini-transcribe" }` and nothing else, so the
 * transcriber had no idea what this app is about. A user dictating a `.sns` name
 * was heard the way Spanish pronounces it and written the way Spanish writes it:
 * a live session produced `snsName: "sofi.sns"` for a domain registered as
 * `sophie.sns`, and the resolver correctly answered `NOMBRE_NO_ENCONTRADO`. The
 * failure was in the listener, not in the resolver, and it made the feature
 * unusable for names that are not Spanish words.
 *
 * The provider documents `prompt` for exactly this: *"Prompts can help correct
 * specific words or acronyms that the model misrecognizes in the audio."* The
 * `language` field is supplied for accuracy AND latency.
 *
 * NOT `keywords`: the provider documents that field as supported by
 * `gpt-transcribe`/`gpt-live-transcribe` only, so it is deliberately omitted
 * rather than sent to a model that does not read it.
 *
 * WHY THE PROMPT IS WRITTEN IN ENGLISH
 * ------------------------------------
 * It is an instruction to a model, and the rest of this file's instructions are
 * English. It used to be Spanish, which was the one Spanish instruction left on
 * the voice path that no language switch guarded: a second, quieter pin of the
 * same kind the persona's opening line used to carry. The wording is a
 * translation and nothing else — every rule it states (the `.sns` names are
 * English proper nouns, keep their English spelling, transcribe the suffix, do
 * not rewrite phonetically, the remaining speech is Rioplatense Spanish) is
 * exactly the rule the Spanish text stated.
 *
 * `TRANSCRIPTION_LANGUAGE` below was pinning the transcriber to `es`, which
 * decoded an English speaker's audio as Spanish. The product now serves both
 * languages, so a single pin is wrong in BOTH directions: it garbles English
 * speech and it would garble Spanish speech if flipped. It is now OPTIONAL and
 * unset by default, which leaves the provider's own language detection in
 * charge — the only setting that is correct for a bilingual session. An operator
 * who wants to pin one language for a single-language deployment can still set
 * `OPENAI_TRANSCRIPTION_LANGUAGE`, and then it is sent as `language`.
 */
const TRANSCRIPTION_PROMPT =
  process.env.OPENAI_TRANSCRIPTION_PROMPT ??
  "The user may speak Spanish (Rioplatense) or English; transcribe whichever " +
  "language they actually spoke and never translate between them. They may also " +
  "dictate a .sns domain name, for example 'juan.sns' or 'sophie.sns'. Those " +
  "names are usually proper nouns or words in ENGLISH, and must be written with " +
  "their original English spelling, NOT with a Spanish respelling of how they " +
  "sound. Transcribe the complete name, including the .sns suffix, without " +
  "translating it or rewriting it phonetically.";

/**
 * The transcriber's options, resolved per call rather than at module load.
 *
 * Per call on purpose: the language pin above is a deployment decision, and a
 * value frozen at import time cannot be exercised in a test without reloading the
 * module — which is how a wrong pin survived unnoticed in the first place.
 */
export function transcriptionOptions(
  environment: NodeJS.ProcessEnv = process.env,
): { model: string; language?: string; prompt: string } {
  const language = environment.OPENAI_TRANSCRIPTION_LANGUAGE?.trim();
  return {
    model: environment.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
    // Only sent when an operator pinned one; see TRANSCRIPTION_LANGUAGE above.
    ...(language ? { language } : {}),
    prompt: environment.OPENAI_TRANSCRIPTION_PROMPT ?? TRANSCRIPTION_PROMPT,
  };
}

/**
 * Instruction for the session's opening turn, appended to
 * `NANI_REALTIME_INSTRUCTIONS` for that turn only.
 *
 * It is an instruction and not a fixed sentence on purpose: the greeting has to
 * read the REAL balance, so the model must call `get_balance` itself. A hardcoded
 * string could only invent a figure.
 */
function greetingInstructions(language: ConversationLanguage): string {
  // The offered menu is the product's own wording, so it follows the session
  // language like the rest of the spoken copy.
  const nextSteps =
    language === "es"
      ? '"ver mi saldo", "hacer una transferencia", "ver mis últimos movimientos"'
      : '"see my balance", "make a transfer", "see my recent activity"';
  return `Session opening turn: the user has NOT spoken yet and is waiting for you, so YOU speak first.
Do it now, warm and brief, in the conversation's language named below, in this exact order:
1. Introduce yourself: you are Nani, the assistant of the user's wallet.
2. Call the get_balance tool with NO arguments and read aloud the available balance it returns, following the get_balance rules above. NEVER invent, estimate or round a figure, and never ask which wallet or network: if the tool or a network fails, say the balance is temporarily unavailable right now and keep going.
3. Close by offering exactly these three next steps, in this order: ${nextSteps}. Never offer a swap or any other action: those three are all you can do.
Never mention tools, providers, networks or internal states. Say it once, then stop and listen.
${languageInstruction(language)}`;
}

/**
 * The persona plus the conversation's language, from the ONE definition of that
 * sentence (`languageInstruction`). A second literal wording here is what the
 * prompt used to have, and it is exactly what drifted: one line said Spanish for
 * every turn while the model was told to follow the user.
 */
export function composeRealtimeInstructions(
  language: ConversationLanguage,
): string {
  return `${NANI_REALTIME_INSTRUCTIONS}\n${languageInstruction(language)}`;
}

export function createAgentSession(options: {
  tools: ToolContextLike;
  /**
   * The conversation's persisted language, resolved by the caller before the
   * session starts. The greeting runs BEFORE the user speaks, so nothing at this
   * point can detect a language; this is the only evidence available for the
   * session's first turn. Defaults to `'en'`, the same fallback
   * `detectConversationLanguage` uses.
   */
  language?: ConversationLanguage;
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
    // The same transcription model the plugin defaults to, so nothing about the
    // transcription's latency changes — what changes is that it now knows what it
    // is listening for. See TRANSCRIPTION_PROMPT above.
    // See TRANSCRIPTION_LANGUAGE above: with no explicit pin the provider detects
    // the language, which is what a bilingual session needs.
    inputAudioTranscription: transcriptionOptions(),
  });
  const language: ConversationLanguage = options.language === "es" ? "es" : "en";
  const agent = new Agent({
    instructions: composeRealtimeInstructions(language),
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
        instructions: greetingInstructions(language),
        allowInterruptions: true,
      });
      return true;
    },
  };
}
