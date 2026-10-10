/**
 * Pure, silence-based end-of-turn detection for the voice-room harness.
 *
 * WHY A MODULE
 * ------------
 * The Slice 2 spike decided "the greeting is over" with `speech > 1.5 s && 2.5 s
 * of quiet since the last loud frame` inside a polling loop. That rule is the
 * whole turn-taking contract of the harness, and it is the one piece that needs
 * no room, no model and no socket — so it lives here as a pure function and is
 * covered by tests/unit/voice-room-turn-detector.test.ts instead of by eyeballing
 * a captured WAV.
 *
 * A fixed `sleep()` cannot replace it: it either truncates the agent mid-sentence
 * or wastes seconds per turn, and it can never distinguish "the agent finished"
 * from "the agent has not started yet".
 *
 * WHAT IT IS NOT
 * --------------
 * It does not re-implement the models' turn detection. The worker runs an OpenAI
 * realtime model with SERVER-side turn detection, so the agent decides for itself
 * when the user stopped talking (the worker logs it: "turnDetection is a
 * TurnDetector, but the LLM is a RealtimeModel with server-side turn detection
 * enabled, ignoring the turnDetection setting"). This function only tells the
 * CAPTURE side when to stop recording a phase.
 *
 * NOT A STREAMING STATE MACHINE
 * -----------------------------
 * It is stateless on purpose: the caller appends frames to a buffer and asks
 * again. That keeps the "is the turn over?" answer a function of the observed
 * window alone, which is what makes it testable.
 */

/** One audio frame reduced to what the decision needs. */
export type AudioFrameEnergy = {
  /** Root-mean-square amplitude, raw PCM16 scale (0-32767). */
  rms: number;
  /** Frame duration in milliseconds. */
  durationMs: number;
};

export type TurnEndOptions = {
  /** Frames with `rms >= speechRmsThreshold` count as speech. */
  speechRmsThreshold: number;
  /** Speech that must be heard before a turn may be considered over. */
  minSpeechMs: number;
  /** Uninterrupted quiet after the LAST speech frame that closes the turn. */
  trailingSilenceMs: number;
};

export type TurnEndState = {
  /** True when the window holds a finished turn: enough speech, then enough quiet. */
  ended: boolean;
  speechStarted: boolean;
  /** Total duration of the frames classified as speech. */
  speechMs: number;
  /** Quiet measured from the end of the last speech frame (the whole window when there is no speech). */
  trailingSilenceMs: number;
  totalMs: number;
};

/**
 * Measured on a real greeting over the room track: idle silence sits at RMS 0
 * (peak 2) while speech lands at RMS 600-2800, so 200 (~-44 dBFS) separates them
 * with a wide margin on both sides.
 */
export const SPEECH_RMS_THRESHOLD = 200;

/**
 * The opening greeting: one long utterance that reads a balance aloud, followed
 * by the agent waiting for an answer.
 */
export const GREETING_TURN_END: TurnEndOptions = Object.freeze({
  speechRmsThreshold: SPEECH_RMS_THRESHOLD,
  minSpeechMs: 1_500,
  trailingSilenceMs: 2_500,
});

/**
 * A spoken answer can be a single short sentence, so the speech floor is much
 * lower than the greeting's. The gap is longer than the greeting's because a
 * mid-answer pause in a generated reply is more likely than inside the greeting,
 * and closing the capture early would truncate the response.
 */
export const RESPONSE_TURN_END: TurnEndOptions = Object.freeze({
  speechRmsThreshold: SPEECH_RMS_THRESHOLD,
  minSpeechMs: 300,
  trailingSilenceMs: 3_000,
});

/**
 * Decides whether the frames observed so far hold a finished turn.
 *
 * The trailing silence is measured from the end of the LAST speech frame, so a
 * mid-sentence pause longer than the gap cannot close the turn early (that is the
 * failure mode the spike's "quiet since lastSpeechAt" rule avoided by luck, not
 * by construction).
 */
export function detectTurnEnd(
  frames: readonly AudioFrameEnergy[],
  options: TurnEndOptions,
): TurnEndState {
  let totalMs = 0;
  let speechMs = 0;
  let lastSpeechEndMs = 0;
  let speechStarted = false;

  for (const frame of frames) {
    // A negative or non-finite duration is a bug in the caller, not a signal;
    // counting it as zero keeps the decision a function of real audio only.
    const durationMs =
      Number.isFinite(frame.durationMs) && frame.durationMs > 0 ? frame.durationMs : 0;
    totalMs += durationMs;
    if (frame.rms >= options.speechRmsThreshold) {
      speechStarted = true;
      speechMs += durationMs;
      lastSpeechEndMs = totalMs;
    }
  }

  const trailingSilenceMs = totalMs - lastSpeechEndMs;
  return {
    ended:
      speechStarted &&
      speechMs >= options.minSpeechMs &&
      trailingSilenceMs >= options.trailingSilenceMs,
    speechStarted,
    speechMs,
    trailingSilenceMs,
    totalMs,
  };
}

/**
 * Root-mean-square amplitude of one PCM16 frame, on the raw sample scale.
 *
 * This is how a frame becomes an {@link AudioFrameEnergy}, so the threshold in
 * {@link TurnEndOptions} means exactly one thing across every caller. It is
 * sign-independent (a symmetric waveform has the amplitude of its samples) and
 * returns 0 for an empty buffer rather than NaN, because an empty frame must
 * never poison a comparison against the threshold.
 *
 * The accumulator is a JS number, not an integer: 1920 samples at full scale
 * sum to ~2e12, which is still inside the exact-integer range of a double.
 */
export function pcm16Rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    energy += sample * sample;
  }
  return Math.sqrt(energy / samples.length);
}
