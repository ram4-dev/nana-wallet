/**
 * Speaking a FIXED sentence and reporting whether it played out in full.
 *
 * The transfer read-back is the evidence the confirmation gate binds to, so
 * "did the user actually hear it" is answered by the speech call itself.
 *
 * ## Why this is not just `session.say()`
 *
 * A realtime session (OpenAI Realtime, and every other speech-to-speech model)
 * has NO TTS model: the model owns the audio. `AgentSession.say()` refuses that
 * configuration outright —
 *
 *     if (!audio && !this.tts && output.audio && output.audioEnabled) {
 *       throw new Error("trying to generate speech from text without a TTS model");
 *     }
 *
 * — so on a realtime session `say()` throws on EVERY call. The only way to
 * speak there is `generateReply()`, which is what the proactive greeting
 * already uses.
 *
 * The SDK explicitly blesses awaiting `generateReply().waitForPlayout()` from
 * inside a function tool: the speech-queue loop frees the owning handle's
 * generation slot before awaiting tool execution, so the circular wait it
 * guards against does not apply.
 *
 * ## Why the mode is chosen and not tried
 *
 * Calling `say()` first and falling back on throw would work, but it would make
 * the throw part of the normal path and hide it again behind a catch. The TTS
 * presence is knowable up front, so the branch is explicit.
 *
 * Failures PROPAGATE. A caller that wants to degrade must say so itself: the
 * previous version swallowed the throw and reported `interrupted: true`, which
 * turned a deterministic "this can never be spoken" into a plausible
 * "the user talked over it" — and every confirmation was refused forever.
 */

type SpeechHandleLike = {
  waitForPlayout(): Promise<void>;
  interrupted: boolean;
};

export type SpeechSessionLike = {
  readonly tts?: unknown;
  say?: (text: string, options?: { allowInterruptions?: boolean }) => SpeechHandleLike;
  generateReply?: (options?: {
    instructions?: string;
    allowInterruptions?: boolean;
  }) => SpeechHandleLike;
};

export type SpeechPlayout = { interrupted: boolean };

/**
 * Instructions wrapped around the sentence for a realtime model.
 *
 * A realtime model GENERATES its words, so exactness is asked for explicitly.
 * The read-back carries an amount, a saved name and a fee, and a paraphrase
 * could change what the user believes they are authorizing.
 */
function exactSpeechInstruction(text: string): string {
  return `Say this sentence out loud now, word for word, and nothing else: ${JSON.stringify(text)}`;
}

export async function speakExactText(
  session: SpeechSessionLike | undefined,
  text: string,
): Promise<SpeechPlayout> {
  if (!session) return { interrupted: true };

  let handle: SpeechHandleLike | undefined;
  if (session.tts !== undefined && session.tts !== null && session.say) {
    handle = session.say(text, { allowInterruptions: true });
  } else if (session.generateReply) {
    handle = session.generateReply({
      instructions: exactSpeechInstruction(text),
      allowInterruptions: true,
    });
  }

  if (!handle) {
    // No path to speech at all. Report it as not-heard rather than pretending
    // the user missed something, and let the caller decide what to say.
    return { interrupted: true };
  }

  await handle.waitForPlayout();
  return { interrupted: handle.interrupted };
}
