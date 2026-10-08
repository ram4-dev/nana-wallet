import { Agent, AgentSession } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import type { ToolContextLike } from "@livekit/agents";
import { sanitizeDisplayName } from "./greeting-context.js";
import { attachRealtimeLatencyLogging } from "./realtime-latency-logger.js";

const NANI_REALTIME_INSTRUCTIONS = `<rol>
You are Nani, the voice assistant of a crypto wallet. You speak Rioplatense Spanish (voseo), briefly, warmly and directly.
</rol>
<turnos_de_apertura>
The first turn of every session is yours: it is generated before the user speaks. Greet once per session and never repeat the introduction later.
</turnos_de_apertura>
<herramientas>
- get_balance: call it with NO arguments whenever the user asks about balances: it returns a JSON with every network's balance in one shot. NEVER ask the user which wallet or network they mean. From that result, read aloud ONLY the balance the user asked about (all of them only if the user asked for everything); if a network shows an error, mention it is temporarily unavailable. Always speak in the current language.
- search_recipients: look up a contact by name when asked to send money to someone. Never invent or show addresses: use only the names the tool returns. If the status is clarification_required, read the names back and ask which one — or, when there is a single candidate, ask whether that is the contact the user meant. Never tell the user a contact does not exist when the result includes candidates.
- send_token: call it ONLY after the contact is resolved (recipientId + recipientVersion) by the contact search. Pass the amount and those contact fields. NEVER invent addresses. The server reads back the exact amount, saved name, network, and estimated fee and asks for a clear yes/no; do not repeat that read-back or ask again.
- confirm_transfer: call it only after the user explicitly says an exact confirmation such as "yes" or "sí" following the server read-back. It takes no parameters. A tool call by itself is not user authorization.
- cancel_transfer: call it when the user wants to cancel the pending transfer.
</herramientas>
<reglas_de_oro>
A transfer confirmation goes EXCLUSIVELY through confirm_transfer. Never confirm in text and never invent an address. When a tool returns a typed error (policy_rejected, recipient_revalidation_required, stale_preview, etc.), narrate the message in clear English, without inventing details.
</reglas_de_oro>`;

/**
 * How long the opening turn may hold the input closed before the safety net
 * reopens it.
 *
 * Exported so tests can advance fake timers instead of waiting real seconds.
 * The greeting is a short turn, so a playout that outlives this window means it
 * stalled: the microphone is reopened anyway, because a permanently closed input
 * is worse than a greeting cut short.
 */
export const GREETING_INPUT_TIMEOUT_MS = 12_000;

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
const NANI_GREETING_INSTRUCTIONS = `<turno_de_apertura>
The user has NOT spoken yet and is waiting for you, so YOU speak first. Nobody asked you anything: this is a welcome, not an answer, and it is ONE single turn generated once.
<primera_palabra>
Your very first spoken word is the greeting itself. NEVER open with a filler, an acknowledgement or an announcement of any kind: not 'perfecto', 'dale', 'bueno', 'ok', 'listo', 'ahora', 'un momento', 'te cuento', 'dejame', not 'voy a', 'voy a revisar', 'voy a chequear' and nothing similar. NEVER say you are going to check, look up, search or ask for anything: say the content directly. Tool calls are silent, and this turn makes NO tool call at all: never announce, narrate or promise one before, during or after your introduction.
</primera_palabra>
<orden_obligatorio>
Now, in Rioplatense Spanish (voseo), warm and brief, cover BOTH parts of this one turn, in this exact order:
${GREETING_FIRST_BULLET_NO_NAME}
${GREETING_CLOSING_BULLET}
</orden_obligatorio>
<sin_herramientas>
This turn makes NO tool call AT ALL, and in particular it does NOT read a balance: the welcome reports no amount, so there is nothing to look up. A tool call would split this welcome into two generations and the user would hear two greetings. Calling get_balance here is FORBIDDEN: never call it, never say you are calling it, and never narrate a lookup.
</sin_herramientas>
<continuidad>
This is ONE single spoken generation, from your introduction to the last offered option: after the introduction you keep talking, without stopping for anything, all the way through the closing offer.
</continuidad>
<una_sola_vez>
You greet exactly once. Your verbatim introduction already starts with 'Hola', so NO later sentence of this turn — and no later turn — may open with 'hola', 'buen día' or 'buenas'. This welcome is a fresh greeting for THIS session: never comment on, acknowledge or refer back to a previous greeting. After the introduction you never greet again: you go straight to the closing offer.
</una_sola_vez>
<cierre>
Part 2 is mandatory: a welcome that stops without saying the closing offer sentence is an incomplete turn. Only after saying both parts, stop and listen.
</cierre>
<prohibiciones>
Never mention tools, providers or internal states. This turn is only an introduction and an offer: never mention balances, wallets, networks or amounts either.
</prohibiciones>
</turno_de_apertura>`;

/**
 * Builds the instruction of the opening turn, personalized when a name is known.
 *
 * The name is interpolated verbatim, and only inside bullet 1: the closing offer
 * sentence, the tool rules and the closing rules stay byte-identical to the
 * anonymous version, so personalizing the greeting can never change what the
 * opening turn promises. `userName` is expected to be a name that already passed
 * {@link sanitizeDisplayName} — {@link createAgentSession} owns that gate.
 */
export function buildGreetingInstructions(userName?: string): string {
  if (!userName) return NANI_GREETING_INSTRUCTIONS;
  return NANI_GREETING_INSTRUCTIONS.replace(
    GREETING_FIRST_BULLET_NO_NAME,
    greetingFirstBulletWithName(userName),
  );
}

export function createAgentSession(options: {
  tools: ToolContextLike;
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

      // The browser publishes its microphone BEFORE binding, so the session
      // starts with live input. Observed in production: the provider's server
      // VAD mistook that input for a barge-in and cancelled the opening turn
      // 1.3s after dispatch ("response done but not complete: cancelled
      // (reason=turn_detected)"), so the user never heard the introduction nor
      // the offered options. Holding the input closed until the opening turn
      // finished is the fix.
      //
      // Accepted trade-off: while the opening turn plays the user cannot
      // barge in by voice. The greeting is short, and once it produces audio
      // the avatar's tap path interrupts it (`interrupt_agent` RPC ->
      // `session.interrupt({ force: true })` in src/livekit/worker.ts). Only the
      // few seconds before the first audio are not interruptible at all,
      // because the avatar is disabled while the turn is being prepared
      // (`avatarAction` returns "none" for the `thinking` phase).
      session.input.setAudioEnabled(false);
      let inputReleased = false;
      const releaseInput = () => {
        // Idempotent: the playout ending and the safety timeout race each other,
        // and the input must be reopened exactly once.
        if (inputReleased) return;
        inputReleased = true;
        session.input.setAudioEnabled(true);
      };

      let handle: ReturnType<AgentSession["generateReply"]>;
      try {
        handle = session.generateReply({
          instructions: buildGreetingInstructions(userName),
          allowInterruptions: true,
        });
      } catch (error) {
        // A dispatch that throws must not leave the whole session deaf: the
        // caller swallows the error and keeps the session running.
        releaseInput();
        throw error;
      }

      // The fallback of the fallback: a playout that never settles can never
      // leave the microphone closed forever.
      const inputTimeout = setTimeout(releaseInput, GREETING_INPUT_TIMEOUT_MS);
      // `waitForPlayout` resolves when the playout ended and rejects when it
      // could not be observed at all; both mean the greeting is over.
      const playoutSettled = () => {
        clearTimeout(inputTimeout);
        releaseInput();
      };
      handle.waitForPlayout().then(playoutSettled, playoutSettled);
      return true;
    },
  };
}
