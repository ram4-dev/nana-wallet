import { Agent, AgentSession } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import type { ToolContextLike } from "@livekit/agents";
import {
  languageInstruction,
  type ConversationLanguage,
} from "../conversations/language.js";
import { sanitizeDisplayName } from "./greeting-context.js";
import { attachRealtimeLatencyLogging } from "./realtime-latency-logger.js";

const NANI_REALTIME_INSTRUCTIONS = `You are Nani, the voice assistant of a crypto wallet. You are brief, warm and direct.
Language: ALWAYS answer in the language the user is speaking, and switch with them the moment they switch. Never keep a language of your own across turns. When the language is Spanish, speak it in Rioplatense voseo — that is a style, not a fixed language. When it is English, speak plain English. The final line of these instructions names the conversation's language so far: it is a starting point, and the user's own speech always overrides it.
Opening turn: the first turn of every session is yours — it is generated before the user speaks. Greet once per session and never repeat the introduction later.
Financial tools:
- get_balance: call it with NO arguments whenever the user asks about balances: it returns a JSON with every network's balance in one shot. NEVER ask the user which wallet or network they mean. From that result, read aloud ONLY the balance the user asked about (all of them only if the user asked for everything); if a network shows an error, mention it is temporarily unavailable. Always speak in the current language.
- search_recipients: look up a contact when asked to send money to someone. Pass the user's OWN words as the query: a name, or how the user described the person ("my nephew", "the electrician"). NEVER invent or guess a proper name from a description or from something you think you heard — a misheard name searches for a stranger, finds nothing, and makes the user believe their contact is gone. Never invent or show addresses: use only the names the tool returns. Use clarification_required with several candidates to read the names back and ask which one. When the result carries contacts without resolving one, read each name together with its stored description back to the user ("I found Sophie, saved as my nephew") and ask which one they meant. With a single candidate go straight to send_token: never ask your own "is this the contact?" question, because a "yes" to that question is not a transfer confirmation. Never tell the user a contact does not exist when the result includes candidates. When the result includes no candidates at all, say you could not match the name and ask the user to repeat it; never claim the user has no such contact.
- send_token: call it ONLY after the contact is resolved (recipientId + recipientVersion) by the contact search, and always before any confirmation. Pass the amount and those contact fields. NEVER invent addresses. When it returns, YOU say the preview out loud, in one short warm sentence, and then stop and wait: the amount, the estimated fee, and the contact name. Nothing else — no network, no tool, no internal state, and never the fee as a raw number. Then ask whether to confirm or cancel. Say it once per transfer: never repeat the preview or ask again.
- confirm_transfer: it acts ONLY on a preview that send_token created in THIS SAME conversation. Call it after YOU spoke the preview and the user then answered with a short agreement — "sí", "dale", "listo", "ok", "confirmo" and the like all count. A "yes" answering any other question of yours is NOT a transfer confirmation. It takes no parameters. A tool call by itself is not user authorization.
- cancel_transfer: call it when the user declines the pending transfer, including a plain "no".
Golden rules: a transfer confirmation goes EXCLUSIVELY through confirm_transfer. Never confirm in text and never invent an address.
How to speak: never mention tools, codes, servers, systems, networks, providers or internal states, and never read a raw number like a fee aloud. Say what happened to the transfer and what the user can do next, in one short sentence, in the user's language. If a tool fails, say it briefly and offer the next step; never explain the machinery.`;

/** The greeting turn has a safety timeout so it cannot leave the microphone closed. */
export const GREETING_INPUT_TIMEOUT_MS = 12_000;

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

/** The named variant of this bullet is built by {@link buildGreetingInstructions}. */
const GREETING_FIRST_BULLET_NO_NAME =
  '1. Introduce yourself: say this sentence, verbatim: \u00abHola, soy Nani, tu asistente financiera.\u00bb Do not reword it, shorten it or add a greeting before it.';

/** The same bullet when a name is known: the placeholder is never spoken. */
function greetingFirstBulletWithName(userName: string): string {
  return `1. Introduce yourself: say this sentence, verbatim: \u00abHola NOMBRE, soy Nani, tu asistente financiera.\u00bb Say the user's real name ("${userName}") in place of NOMBRE and never say the word NOMBRE. Do not reword the sentence, shorten it or add a greeting before it.`;
}

/**
 * The verbatim closing sentence of the welcome.
 *
 * The offered actions used to be a bare quoted list, and the model read them
 * out exactly that way — "ver mi saldo, hacer una transferencia, ver mis últimos
 * movimientos" — with no lead-in at all. Read live, that sounded like an
 * unfinished list rather than an offer. Fixed as a sentence, the same treatment
 * that finally made the introduction land verbatim, the lead-in stops depending
 * on how the model decides to introduce a list.
 *
 * The pronouns are the user's ("ver tu saldo"), because Nani is the one
 * speaking: the list is what SHE can do for the user, not what the user does
 * for herself.
 */
export const GREETING_OFFERS_SENTENCE =
  "Te puedo ayudar con: ver tu saldo, hacer una transferencia o ver tus últimos movimientos. ¿Qué querés hacer?";

/**
 * Bullet 2 of the opening turn: the closing offer, said as one verbatim sentence.
 */
const GREETING_CLOSING_BULLET =
  `2. Close by saying this sentence, verbatim: \u00ab${GREETING_OFFERS_SENTENCE}\u00bb Your sentence STARTS with these exact words: 'Te puedo ayudar con:'. Never paraphrase that opening: not 'Puedo ayudarte con', not 'Puedo ayudarte a', not 'Te puedo ayudar a', not 'Te ayudo con' and nothing similar. Say these three actions and no others: never offer a swap or any other action, those three are all you can do. Do not reword the sentence and do not add an action of your own.`;

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

const TURN_EAGERNESS = new Set(['auto', 'low', 'medium', 'high'] as const);
const NOISE_REDUCTION = new Set(['near_field', 'far_field'] as const);

/**
 * The realtime model's options, resolved per call.
 *
 * WHY TURN-TAKING IS CONFIGURED HERE AT ALL
 * ----------------------------------------
 * It used to be left to the plugin, and the plugin's default is
 * `{ type: 'semantic_vad', eagerness: 'medium' }` with
 * `inputAudioNoiseReduction: undefined`. That combination is deterministic but
 * SLOW: `semantic_vad` decides the end of a turn with a model rather than by
 * measuring silence, and with no noise reduction the microphone's floor keeps
 * the detector from concluding. Measured on the deployed stack, the agent sat
 * silent through speech spans of 28.4s / 15.5s / 10.1s and through gaps of
 * 8.5s / 6.8s / 5.4s between a tool finishing and the first audio. The user's
 * report was literal: "se queda mucho tiempo esperando".
 *
 * The choice, made deliberately rather than inherited:
 *   - `semantic_vad` is KEPT, because it understands that a pause mid-sentence
 *     is not the end of a turn. `server_vad` would answer a silence threshold,
 *     and on a wallet that confirms transfers by voice that means answering an
 *     instruction the user had not finished speaking.
 *   - `eagerness: 'high'` is what removes the waiting: the same model-decided
 *     mechanism, no longer biased towards patience.
 *   - noise reduction is ON because it is orthogonal help for both mechanisms.
 *
 * Both are operator-overridable, and an unrecognised value falls back to the
 * deliberate default instead of silently disabling the setting — failing open to
 * the plugin default is exactly what produced the defect.
 */
export function realtimeModelOptions(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const requestedEagerness = environment.OPENAI_REALTIME_TURN_EAGERNESS?.trim();
  const eagerness = TURN_EAGERNESS.has(requestedEagerness as 'high')
    ? requestedEagerness
    : 'high';
  const requestedNoise = environment.OPENAI_REALTIME_NOISE_REDUCTION?.trim();
  const noiseReduction = NOISE_REDUCTION.has(requestedNoise as 'far_field')
    ? requestedNoise
    : 'far_field';
  return {
    model: environment.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
    voice: environment.OPENAI_REALTIME_VOICE ?? "marin",
    // Carried here so this is the COMPLETE option set: a caller builds the
    // model from one object, and a test can hand the real vendor exactly what
    // production hands it. `createAgentSession` still guards the boot, so a
    // missing key fails with its own error before the SDK's generic one.
    apiKey: environment.OPENAI_API_KEY,
    // Keep the detector model-decided; stop it waiting like `medium` does.
    turnDetection: { type: 'semantic_vad', eagerness },
    // `far_field` is the laptop/phone-speaker case this web app runs in.
    inputAudioNoiseReduction: { type: noiseReduction },
    inputAudioTranscription: transcriptionOptions(environment),
  };
}

/**
 * Instruction for the session's opening turn, appended to
 * `NANI_REALTIME_INSTRUCTIONS` for that turn only.
 *
 * It is an instruction and not a fixed sentence on purpose: the greeting has to
 * address the user by the name the worker already read. It carries exactly two
 * things — the verbatim introduction and the verbatim closing offer — and no
 * balance: this turn never reports an amount. The turn makes NO tool call at all,
 * because a tool call in the middle of this turn splits it into two generations
 * and makes the user hear two greetings.
 */
function greetingInstructions(language: ConversationLanguage): string {
  if (language === "en") {
    return `<opening_turn>
The user has NOT spoken yet and is waiting for you, so YOU speak first. Nobody asked you anything: this is one welcome, not an answer.
Say this exact introduction first: «Hi, I'm Nani, your financial assistant.» Then say: «I can help you check your balance, make a transfer, or see your recent activity. What would you like to do?» Make NO tool calls, report no balance or amount, then stop and listen. Never add an action or greet again.
</opening_turn>
${languageInstruction(language)}`;
  }
  return `<turno_de_apertura>
The user has NOT spoken yet and is waiting for you, so YOU speak first. Nobody asked you anything: this is a welcome, not an answer, and it is ONE single turn generated once.
<primera_palabra>
Your very first spoken word is the greeting itself. NEVER open with a filler, an acknowledgement or an announcement: not 'perfecto', 'dale', 'bueno', 'ok', 'listo', 'ahora', 'un momento', 'te cuento', 'dejame', not 'voy a', 'voy a revisar', 'voy a chequear'. NEVER say you are going to check, look up, search or ask for anything. Tool calls are silent, and this turn makes NO tool call at all.
</primera_palabra>
<orden_obligatorio>
Now, in Rioplatense Spanish (voseo), warm and brief, cover BOTH parts in this exact order:
${GREETING_FIRST_BULLET_NO_NAME}
${GREETING_CLOSING_BULLET}
</orden_obligatorio>
<sin_herramientas>
This turn makes NO tool call AT ALL and does NOT read a balance. Calling get_balance here is FORBIDDEN.
</sin_herramientas>
<continuidad>
This is ONE single spoken generation, from your introduction to the last offered option.
</continuidad>
<una_sola_vez>
You greet exactly once. After the introduction go straight to the closing offer.
</una_sola_vez>
<cierre>
A welcome that stops without the closing offer is incomplete. Only after both parts, stop and listen.
</cierre>
<prohibiciones>
Never mention tools, providers or internal states. Never mention balances, wallets, networks or amounts in this welcome.
</prohibiciones>
</turno_de_apertura>
${languageInstruction(language)}`;
}

/** Build the personalized opening instruction; absent or unsafe names are omitted. */
export function buildGreetingInstructions(userName?: string, language: ConversationLanguage = "es"): string {
  const base = greetingInstructions(language);
  const safeName = sanitizeDisplayName(userName);
  if (!safeName || language !== "es") return base;
  const namedBullet = `1. Introduce yourself: say this sentence, verbatim: «Hola NOMBRE, soy Nani, tu asistente financiera.» Say the user's real name ("${safeName}") in place of NOMBRE and never say the word NOMBRE. Do not reword it, shorten it or add a greeting before it.`;
  return base.replace(GREETING_FIRST_BULLET_NO_NAME, namedBullet);
}

/** Persona plus the persisted conversation language, shared with the text path. */
export function composeRealtimeInstructions(language: ConversationLanguage): string {
  return `${NANI_REALTIME_INSTRUCTIONS}\n${languageInstruction(language)}`;
}
export function createAgentSession(options: {
  tools: ToolContextLike;
  /** Persisted conversation language, resolved before the user speaks. */
  language?: ConversationLanguage;
  userName?: string;
}): AgentSessionComposition {
  // The name lands inside the model's instructions, so it is re-sanitized here
  // even though the voice binding already sanitized it: a value that cannot be a
  // name is dropped instead of being spoken to the model.
  const userName = sanitizeDisplayName(options.userName);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for the openai-realtime voice provider.",
    );
  }
  const llm = new openai.realtime.RealtimeModel(
    // One definition of the model's options: the turn-taking settings are part
    // of the contract, not a detail this call site may quietly drop.
    realtimeModelOptions() as never,
  );
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
      // Prevent the published microphone from cancelling the proactive greeting.
      // Always release it when playout ends, fails, or exceeds the safety timeout.
      session.input.setAudioEnabled(false);
      let inputReleased = false;
      const releaseInput = () => {
        if (inputReleased) return;
        inputReleased = true;
        session.input.setAudioEnabled(true);
      };
      let handle: ReturnType<AgentSession["generateReply"]>;
      try {
        handle = session.generateReply({
          instructions: buildGreetingInstructions(userName, language),
          allowInterruptions: true,
        });
      } catch (error) {
        releaseInput();
        throw error;
      }
      const inputTimeout = setTimeout(releaseInput, GREETING_INPUT_TIMEOUT_MS);
      const playoutSettled = () => {
        clearTimeout(inputTimeout);
        releaseInput();
      };
      handle.waitForPlayout().then(playoutSettled, playoutSettled);
      return true;
    },
  };
}
