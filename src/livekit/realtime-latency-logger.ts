import {
  AgentSession,
  AgentSessionEventTypes,
} from "@livekit/agents";

/**
 * POC-grade per-turn latency logging for the OpenAI Realtime session.
 *
 * Subscribes to the public `AgentSession` events and emits one structured
 * console line per completed turn:
 *
 * - `speechEndToFirstAudioMs`: end of user speech -> first assistant audio.
 * - When the turn called a tool, a per-call breakdown:
 *   - `speechEndToFunctionCallMs`: user speech end -> model emitted the call.
 *   - `functionCallToOutputMs`: model emitted the call -> tool output produced.
 *   - `outputToFirstAudioMs`: tool output -> first assistant audio.
 *
 * This is intentionally lightweight. It is not a full observability subsystem:
 * if the SDK withholds a timestamp for a stage, that stage is simply omitted
 * from the emitted payload rather than guessed.
 */
export function attachRealtimeLatencyLogging(session: AgentSession): void {
  // Development-only prompt inspection.
  //
  // The worker logs never show what the model actually SAID, so prompt work on
  // the opening turn was guesswork. With VOICE_PROMPT_DEBUG=1 the assistant's
  // own text is printed as one structured line per turn. It prints assistant
  // text only, never user speech, and it is off by default: an assistant turn
  // can carry a balance or a name, so it must never be enabled in a shared
  // environment. It is deliberately outside the retention trace pipeline (see
  // `src/config/privacy.ts`).
  const promptDebug = process.env.VOICE_PROMPT_DEBUG === "1";
  let turn:
    | {
        speechEndAt?: number;
        functionCalls?: Array<{ name: string; createdAt: number }>;
        functionCallOutputs?: Array<{ name: string; createdAt: number }>;
      }
    | undefined;

  session.on(AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal) return;
    turn = { speechEndAt: ev.createdAt };
  });

  session.on(AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
    if (!turn) return;
    turn.functionCalls = ev.functionCalls.map((call) => ({
      name: call.name,
      createdAt: call.createdAt,
    }));
    turn.functionCallOutputs = ev.functionCallOutputs.map((output) => ({
      name: output.name,
      createdAt: output.createdAt,
    }));
  });

  session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type !== "message" || item.role !== "assistant") return;
    if (promptDebug) {
      console.log(
        JSON.stringify({
          type: "voice_prompt_turn",
          role: item.role,
          text: item.textContent ?? "",
          createdAt: item.createdAt,
        }),
      );
    }
    const firstAudioAt = item.createdAt;
    if (typeof firstAudioAt !== "number") return;
    if (!turn || turn.speechEndAt === undefined) return;
    const speechEndAt = turn.speechEndAt;
    const calls = turn.functionCalls;
    const outputs = turn.functionCallOutputs ?? [];

    const payload: Record<string, unknown> = {
      type: "realtime_turn_latency",
      speechEndToFirstAudioMs: firstAudioAt - speechEndAt,
    };

    if (calls && calls.length > 0) {
      payload.toolBreakdown = calls.map((call, index) => {
        const output = outputs[index];
        const functionCallAt = call.createdAt;
        const outputAt = output?.createdAt ?? functionCallAt;
        return {
          name: call.name,
          speechEndToFunctionCallMs: functionCallAt - speechEndAt,
          functionCallToOutputMs: outputAt - functionCallAt,
          outputToFirstAudioMs: firstAudioAt - outputAt,
        };
      });
    }

    console.log(JSON.stringify(payload));
    turn = undefined;
  });
}
