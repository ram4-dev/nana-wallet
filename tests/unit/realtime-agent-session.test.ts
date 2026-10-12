import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type MockGenerateReplyOptions = {
    instructions?: unknown;
    allowInterruptions?: unknown;
  };

  class MockAgentSession {
    options: Record<string, unknown>;
    generateReplyCalls: MockGenerateReplyOptions[] = [];
    sayCalls: string[] = [];
    static instances: MockAgentSession[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockAgentSession.instances.push(this);
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    start() {}
    interrupt() {}
    close() {}
    say(text: string) {
      this.sayCalls.push(text);
      return { waitForPlayout: async () => undefined, interrupted: false };
    }
    generateReply(options?: MockGenerateReplyOptions) {
      this.generateReplyCalls.push(options ?? {});
      // Mirrors the real SpeechHandle: `waitForPlayout` resolves even on error
      // (the failure is exposed through `exception()`), so it never rejects.
      return { waitForPlayout: async () => undefined, interrupted: false };
    }
  }

  class MockAgent {
    options: Record<string, unknown>;
    static instances: MockAgent[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockAgent.instances.push(this);
    }
  }

  class MockLLM {
    constructor(..._args: unknown[]) {}
  }

  class MockLLMStream {
    constructor(..._args: unknown[]) {}
  }

  class MockChatContext {
    constructor(..._args: unknown[]) {}
  }

  class MockRealtimeModel {
    options: Record<string, unknown>;
    static instances: MockRealtimeModel[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockRealtimeModel.instances.push(this);
    }
    session() {
      return {};
    }
    close() {}
  }

  return {
    MockAgentSession,
    MockAgent,
    MockLLM,
    MockLLMStream,
    MockChatContext,
    MockRealtimeModel,
  };
});

vi.mock("@livekit/agents", () => ({
  AgentSession: h.MockAgentSession,
  Agent: h.MockAgent,
  llm: { LLM: h.MockLLM, LLMStream: h.MockLLMStream },
  ChatContext: h.MockChatContext,
  initializeLogger: () => {},
  tool: (def: Record<string, unknown>) => ({ type: "function", ...def }),
  AgentSessionEventTypes: {
    UserInputTranscribed: "user_input_transcribed",
    FunctionToolsExecuted: "function_tools_executed",
    ConversationItemAdded: "conversation_item_added",
  },
}));

vi.mock("@livekit/agents-plugin-openai", () => ({
  realtime: { RealtimeModel: h.MockRealtimeModel },
}));

import { createAgentSession } from "../../src/livekit/create-agent-session.js";
import {
  detectConversationLanguage,
  languageInstruction,
} from "../../src/conversations/language.js";

/**
 * The defect this suite pins: the voice prompt PINNED Rioplatense Spanish
 * ("You speak Rioplatense Spanish (voseo)"), so every softer "in the user's
 * language" line lost to it and a user who opened the call speaking English was
 * answered in Spanish. A pin is not a default; it is an order, and it has to be
 * gone.
 */
describe("the voice session answers in the user's language", () => {
  beforeEach(() => {
    h.MockAgentSession.instances = [];
    h.MockAgent.instances = [];
    h.MockRealtimeModel.instances = [];
    vi.clearAllMocks();
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_VOICE;
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("tells the model to follow the user's language and pins none of its own", () => {
    createAgentSession({ tools: [], language: "en" });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    // The rule, said plainly and first.
    expect(persona).toMatch(
      /ALWAYS answer in the language the user is speaking, and switch with them the moment they switch/iu,
    );
    // Rioplatense survives as the STYLE for Spanish, never as a fixed language.
    expect(persona).toMatch(/Rioplatense voseo — that is a style, not a fixed language/iu);
    // The pin that caused the defect, named and forbidden.
    expect(persona).not.toMatch(/You speak Rioplatense Spanish/iu);
  });

  it("names English for an English conversation", () => {
    createAgentSession({ tools: [], language: "en" });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    expect(persona).toContain(languageInstruction("en"));
    expect(persona).toMatch(/Respond in English/iu);
    expect(persona).not.toMatch(/Respond in Spanish/iu);
  });

  it("names Spanish for a Spanish conversation", () => {
    createAgentSession({ tools: [], language: "es" });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    expect(persona).toContain(languageInstruction("es"));
    expect(persona).toMatch(/Respond in Spanish/iu);
  });

  it("sends the transcriber its guidance in English, with the .sns rule intact", () => {
    // The transcriber prompt was the one Spanish instruction left on the voice
    // path that no language switch guarded: an instruction to a model, written
    // in a language nobody had chosen for the session. It is English now, and
    // the rule that fixed the observed `sofi.sns` / `sophie.sns` mishearing is
    // exactly the same rule, translated.
    createAgentSession({ tools: [], language: "en" });
    const transcription = h.MockRealtimeModel.instances[0].options
      .inputAudioTranscription as { language?: string; prompt?: string };

    expect(transcription.prompt).toContain("must be written with their original English spelling");
    expect(transcription.prompt).toContain(".sns suffix");
    expect(transcription.prompt).toContain("Rioplatense Spanish");
    // No Spanish instruction text survives anywhere in it.
    for (const spanish of ["ortografia", "pronunciacion espanola", "Transcribi", "El usuario dicta"]) {
      expect(transcription.prompt, spanish).not.toContain(spanish);
    }
    // The transcription LANGUAGE is a separate, deliberately pinned setting and
    // this change does not touch it: it is reported for its own change.
    expect(transcription.language).toBe("es");
  });

  it("defaults to the language detector's own default when the caller names none", () => {
    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    // Same fallback as `detectConversationLanguage` for a turn with no lexical
    // evidence: a conversation nobody described is served in English.
    expect(detectConversationLanguage("")).toBe("en");
    expect(persona).toContain(languageInstruction("en"));
  });

  it("reads the language the user is ACTUALLY speaking, from their own words", () => {
    // The voice path never detected a language; it now shares the text path's
    // detector, so the one rule covers both surfaces instead of a Spanish pin
    // covering the voice one.
    expect(detectConversationLanguage("hello, can you send 5 SOL to Lucas?", "es")).toBe("en");
    expect(detectConversationLanguage("hola, ¿me podés mandar el saldo?", "en")).toBe("es");
  });

  it("offers the greeting's next steps in the conversation's language", () => {
    const english = createAgentSession({ tools: [], language: "en" });
    expect(english.speakGreeting()).toBe(true);
    const englishOpening = String(
      h.MockAgentSession.instances[0].generateReplyCalls[0]!.instructions,
    );

    const spanish = createAgentSession({ tools: [], language: "es" });
    expect(spanish.speakGreeting()).toBe(true);
    const spanishOpening = String(
      h.MockAgentSession.instances[1].generateReplyCalls[0]!.instructions,
    );

    // The menu the user is invited to say follows the language they are in, and
    // the three options stay exactly three in both languages.
    expect(englishOpening.match(/"[^"]+"/gu)).toEqual([
      '"see my balance"',
      '"make a transfer"',
      '"see my recent activity"',
    ]);
    expect(spanishOpening.match(/"[^"]+"/gu)).toEqual([
      '"ver mi saldo"',
      '"hacer una transferencia"',
      '"ver mis últimos movimientos"',
    ]);
    expect(englishOpening).not.toMatch(/ver mi saldo/iu);
    expect(spanishOpening).not.toMatch(/see my balance/iu);
  });
});

describe("OpenAI realtime agent session composition", () => {
  beforeEach(() => {
    h.MockAgentSession.instances = [];
    h.MockAgent.instances = [];
    h.MockRealtimeModel.instances = [];
    vi.clearAllMocks();
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_VOICE;
    delete process.env.OPENAI_API_KEY;
  });

  it("composes a realtime session without STT/TTS and injects the provided tools", () => {
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-custom";
    process.env.OPENAI_REALTIME_VOICE = "cedar";
    process.env.OPENAI_API_KEY = "test-openai-key";

    const tools = [
      { type: "function", name: "get_balance", execute: async () => ({}) },
      { type: "function", name: "search_contacts", execute: async () => ({}) },
    ] as never;

    createAgentSession({ tools });

    const realtimeModel = h.MockRealtimeModel.instances[0];
    expect(realtimeModel.options).toMatchObject({
      model: "gpt-realtime-custom",
      voice: "cedar",
      apiKey: "test-openai-key",
    });

    const sessionOptions = h.MockAgentSession.instances[0].options;
    expect(sessionOptions.llm).toBe(realtimeModel);
    expect(sessionOptions.stt).toBeUndefined();
    expect(sessionOptions.tts).toBeUndefined();
    expect(sessionOptions.vad).toBeUndefined();
    expect(sessionOptions.turnHandling).toBeUndefined();

    const agentOptions = h.MockAgent.instances[0].options;
    expect(agentOptions.llm).toBe(realtimeModel);
    const toolNames = (agentOptions.tools as Array<{ name: string }>)
      .map((toolItem) => toolItem.name)
      .sort();
    expect(toolNames).toEqual(["get_balance", "search_contacts"]);
    expect(String(agentOptions.instructions)).toContain("Nani");
  });

  it("uses the default realtime model and voice when env is unset", () => {
    process.env.OPENAI_API_KEY = "test-key";
    createAgentSession({ tools: [] });

    expect(h.MockRealtimeModel.instances[0].options).toMatchObject({
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      apiKey: "test-key",
    });
  });

  it("requires an api key", () => {
    expect(() => createAgentSession({ tools: [] })).toThrow(
      "OPENAI_API_KEY is required",
    );
  });

  it("opens the session with ONE proactive turn that reads the real balance in the conversation's language", () => {
    process.env.OPENAI_API_KEY = "test-key";

    const { speakGreeting } = createAgentSession({ tools: [], language: "es" });
    const composed = h.MockAgentSession.instances[0];
    expect(composed.generateReplyCalls).toHaveLength(0);

    expect(speakGreeting()).toBe(true);

    const calls = composed.generateReplyCalls;
    expect(calls).toHaveLength(1);
    const opening = String(calls[0].instructions);
    // She introduces herself without waiting for the user to speak.
    expect(opening).toContain("Nani");
    // The balance is read through the tool, never asserted as a literal:
    // a fixed figure would be an invented one.
    expect(opening).toContain("get_balance");
    expect(opening).not.toMatch(/\$\s*\d/u);
    expect(opening).not.toMatch(/(?:USDC|USDT|USD|dólares|dolares)/iu);
    // Concrete next steps in the product's own words. The quoted strings ARE the
    // offered menu, so exactly those three — no fourth option can sneak in.
    expect(opening.match(/"[^"]+"/gu)).toEqual([
      '"ver mi saldo"',
      '"hacer una transferencia"',
      '"ver mis últimos movimientos"',
    ]);
    // No swap: offering one would promise an action the agent has no tool for.
    expect(opening).toMatch(/never offer a swap/iu);
    // Interruptible: the opening turn must never trap the user.
    expect(calls[0].allowInterruptions).toBe(true);
    // Generated by the agent, never a fixed sentence: a fixed string could only
    // invent the balance the greeting is supposed to read.
    expect(composed.sayCalls).toHaveLength(0);
    // The greeting carries the conversation's language, through the ONE
    // definition of that sentence.
    expect(opening).toContain(languageInstruction("es"));
    // ...while the existing get_balance rules stay intact.
    const persona = String(h.MockAgent.instances[0].options.instructions);
    expect(persona).toContain("get_balance: call it with NO arguments");
  });

  it("greets exactly once per session, and again for a new session", () => {
    process.env.OPENAI_API_KEY = "test-key";

    const first = createAgentSession({ tools: [] });
    expect(first.speakGreeting()).toBe(true);
    // A repeated trigger (reconnect/resume of the same started session) must not
    // re-greet the user.
    expect(first.speakGreeting()).toBe(false);
    expect(h.MockAgentSession.instances[0].generateReplyCalls).toHaveLength(1);

    const second = createAgentSession({ tools: [] });
    expect(second.speakGreeting()).toBe(true);
    expect(h.MockAgentSession.instances[1].generateReplyCalls).toHaveLength(1);
    // The new session greets too — it never inherits the first session's state.
    expect(h.MockAgentSession.instances[0].generateReplyCalls).toHaveLength(1);
  });

  it("sends a single resolved candidate to the read-back instead of asking its own yes/no", () => {
    process.env.OPENAI_API_KEY = "test-key";

    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    // The single-candidate branch used to tell the model to ask "is this the
    // contact you meant?". confirm_transfer told it to fire on a user "yes".
    // The model asked, the user said "sí", and it read that as the transfer
    // confirmation: confirm_transfer ran with no preview in the conversation
    // and the user heard "no pending transfer to confirm or cancel".
    //
    // A single candidate now goes straight to send_token, whose read-back
    // already names the recipient and is the only thing a decision binds to.
    // Asking twice is not extra safety, it is a second question the model can
    // mistake for the one confirmation is allowed to answer.
    expect(persona).not.toMatch(/ask whether that is the contact/iu);
  });

  it("only lets a send_token read-back authorize confirm_transfer", () => {
    process.env.OPENAI_API_KEY = "test-key";

    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    // The preview is scoped to the conversation, so the contract has to say so:
    // otherwise the model cannot know that a preview from another session, or
    // no preview at all, is a dead end.
    expect(persona).toContain(
      "confirm_transfer: it acts ONLY on a preview that send_token created in THIS SAME conversation",
    );
    // The exact conflation that broke the flow, named and forbidden.
    expect(persona).toContain(
      'A "yes" answering any other question of yours is NOT a transfer confirmation',
    );
  });

  /**
   * The user's own words: "la confirmacion no tendria que ser tan exacta".
   * The prompt used to demand "an exact confirmation such as yes or sí", and
   * the classifier behind it demanded an exact sentence, so an ordinary "dale"
   * was refused with no way to find out why. The prompt now names the ordinary
   * answers, and the classifier accepts them.
   */
  it("tells the model that ordinary short agreements count as confirmation", () => {
    process.env.OPENAI_API_KEY = "test-key";

    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    expect(persona).toContain('"sí", "dale", "listo", "ok", "confirmo" and the like all count');
    expect(persona).not.toMatch(/exact confirmation such as/iu);
    // A plain "no" cancels: it did not, because it was not in any list.
    expect(persona).toMatch(/cancel_transfer: call it when the user declines the pending transfer, including a plain "no"/iu);
  });

  /**
   * The user's other complaint: "Nani esta dando de mas informacion sobre las
   * tools y demas". The prompt used to enumerate internal error codes and tell
   * the model to narrate them, which is an invitation to talk about the
   * machinery to someone who only asked to move money.
   */
  it("forbids the model from talking about tools, codes and internal states", () => {
    process.env.OPENAI_API_KEY = "test-key";

    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    expect(persona).toMatch(
      /never mention tools, codes, servers, systems, networks, providers or internal states/iu,
    );
    // No internal error vocabulary in a prompt that is spoken to the user.
    for (const internal of ['policy_rejected', 'recipient_revalidation_required', 'stale_preview', 'wallet_unavailable']) {
      expect(persona, internal).not.toContain(internal);
    }
  });

  /**
   * The recovery the interrupted read-back needs. Without it the user hits a
   * loop: the read-back is interrupted, the decision can never be consumed, and
   * the model is forbidden from reading the preview again.
   */
  it("allows one re-read when a confirmation is refused for an incomplete read-back", () => {
    process.env.OPENAI_API_KEY = "test-key";

    createAgentSession({ tools: [] });
    const persona = String(h.MockAgent.instances[0].options.instructions);

    expect(persona).toMatch(
      /except when a confirmation is refused because the transfer was not read out in full, in which case call send_token again to read it/iu,
    );
  });

  it("spends the greeting even when the provider rejects it, so it cannot loop", () => {
    process.env.OPENAI_API_KEY = "test-key";

    const { speakGreeting } = createAgentSession({ tools: [] });
    h.MockAgentSession.instances[0].generateReply = () => {
      throw new Error("AgentSession is not running");
    };

    expect(() => speakGreeting()).toThrow("AgentSession is not running");
    expect(speakGreeting()).toBe(false);
  });
});
