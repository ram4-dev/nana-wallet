import { describe, expect, it } from 'vitest';
import {
  GREETING_TURN_END,
  RESPONSE_TURN_END,
  SPEECH_RMS_THRESHOLD,
  detectTurnEnd,
  pcm16Rms,
  type AudioFrameEnergy,
} from '../e2e/voice-room/turn-detector.js';

/**
 * The end-of-turn rule is the only part of the voice-room round trip that can be
 * decided without a room, a model or a socket, so it is the part that gets a real
 * unit test instead of a captured WAV.
 *
 * It replaces the `sleep(2500)` the Slice 2 spike had to use: a fixed sleep
 * either truncates Nani mid-sentence or wastes seconds per turn, and it cannot
 * tell "the agent finished" from "the agent has not started".
 */

/** A quiet frame: below any sane speech floor. */
const quiet = (durationMs: number, rms = 0): AudioFrameEnergy => ({ rms, durationMs });

/** A loud frame: the real greeting measured RMS 600-2800 on the room track. */
const speech = (durationMs: number, rms = 900): AudioFrameEnergy => ({ rms, durationMs });

const OPTIONS = {
  speechRmsThreshold: 200,
  minSpeechMs: 1_000,
  trailingSilenceMs: 2_000,
};

describe('detectTurnEnd', () => {
  it('does not end a turn that has not started: silence alone is not a turn', () => {
    const state = detectTurnEnd([quiet(1_000), quiet(1_000), quiet(1_000)], OPTIONS);

    expect(state.ended).toBe(false);
    expect(state.speechStarted).toBe(false);
    expect(state.speechMs).toBe(0);
    expect(state.trailingSilenceMs).toBe(3_000);
    expect(state.totalMs).toBe(3_000);
  });

  it('does not end a turn when the speech is shorter than the minimum', () => {
    const state = detectTurnEnd([speech(400), quiet(5_000)], OPTIONS);

    expect(state.ended).toBe(false);
    expect(state.speechStarted).toBe(true);
    expect(state.speechMs).toBe(400);
    expect(state.trailingSilenceMs).toBe(5_000);
  });

  it('does not end a turn while the agent is still speaking', () => {
    const state = detectTurnEnd([speech(3_000)], OPTIONS);

    expect(state.ended).toBe(false);
    expect(state.speechMs).toBe(3_000);
    expect(state.trailingSilenceMs).toBe(0);
  });

  it('does not end a turn on a silence shorter than the required gap', () => {
    const state = detectTurnEnd([speech(2_000), quiet(1_900)], OPTIONS);

    expect(state.ended).toBe(false);
    expect(state.trailingSilenceMs).toBe(1_900);
  });

  it('ends a turn on enough speech followed by enough silence', () => {
    const state = detectTurnEnd([speech(2_400), quiet(2_000)], OPTIONS);

    expect(state.ended).toBe(true);
    expect(state.speechStarted).toBe(true);
    expect(state.speechMs).toBe(2_400);
    expect(state.trailingSilenceMs).toBe(2_000);
    expect(state.totalMs).toBe(4_400);
  });

  it('measures the trailing silence from the LAST speech frame, not from the first pause', () => {
    const state = detectTurnEnd(
      [
        speech(1_200),
        quiet(3_000), // a mid-sentence breath: 3 s of quiet, far past the gap
        speech(1_200),
        quiet(2_100),
      ],
      OPTIONS,
    );

    expect(state.ended).toBe(true);
    expect(state.speechMs).toBe(2_400);
    expect(state.trailingSilenceMs).toBe(2_100);
  });

  it('counts a frame exactly at the threshold as speech and one below it as silence', () => {
    const atThreshold = detectTurnEnd(
      [{ rms: OPTIONS.speechRmsThreshold, durationMs: 1_500 }, quiet(2_000, OPTIONS.speechRmsThreshold - 1)],
      OPTIONS,
    );
    const belowThreshold = detectTurnEnd(
      [{ rms: OPTIONS.speechRmsThreshold - 1, durationMs: 1_500 }, quiet(2_000)],
      OPTIONS,
    );

    expect(atThreshold.speechMs).toBe(1_500);
    expect(atThreshold.ended).toBe(true);
    expect(belowThreshold.speechMs).toBe(0);
    expect(belowThreshold.ended).toBe(false);
  });

  it('is stateless across calls: the same frames always give the same answer', () => {
    const frames = [speech(2_000), quiet(2_500)];
    const first = detectTurnEnd(frames, OPTIONS);
    const second = detectTurnEnd(frames, OPTIONS);

    expect(first).toEqual(second);
    // The caller keeps appending frames; a shorter prefix is not "ended" merely
    // because a longer one was evaluated before.
    expect(detectTurnEnd([speech(2_000), quiet(100)], OPTIONS).ended).toBe(false);
  });

  it('reports a zero-length empty window instead of throwing', () => {
    const state = detectTurnEnd([], OPTIONS);

    expect(state).toEqual({
      ended: false,
      speechStarted: false,
      speechMs: 0,
      trailingSilenceMs: 0,
      totalMs: 0,
    });
  });

  it('turns frames into the detector input without changing the decision', () => {
    // The wiring the room capture actually uses: PCM -> energy -> decision. It
    // stays pure so the room-side code has no arithmetic of its own.
    const frames = [speech(2_000, pcm16Rms(Int16Array.from([1_000, -1_000]))), quiet(2_500, pcm16Rms(new Int16Array(480)))];

    expect(detectTurnEnd(frames, OPTIONS).ended).toBe(true);
    expect(frames[1]?.rms).toBe(0);
    expect(frames[1]!.rms).toBeLessThan(OPTIONS.speechRmsThreshold);
  });

  it('exposes the two phase profiles the harness uses, with the measured speech floor', () => {
    expect(SPEECH_RMS_THRESHOLD).toBe(200);
    expect(GREETING_TURN_END).toEqual({
      speechRmsThreshold: SPEECH_RMS_THRESHOLD,
      minSpeechMs: 1_500,
      trailingSilenceMs: 2_500,
    });
    // A spoken answer can be one short sentence, so the floor is much lower than
    // the greeting's, and the gap is longer to survive a mid-answer pause.
    expect(RESPONSE_TURN_END).toEqual({
      speechRmsThreshold: SPEECH_RMS_THRESHOLD,
      minSpeechMs: 300,
      trailingSilenceMs: 3_000,
    });
    expect(RESPONSE_TURN_END.trailingSilenceMs).toBeGreaterThan(
      GREETING_TURN_END.trailingSilenceMs,
    );
  });
});

describe('pcm16Rms', () => {
  it('reads digital silence as zero', () => {
    expect(pcm16Rms(new Int16Array(960))).toBe(0);
  });

  it('returns zero for an empty buffer instead of NaN', () => {
    expect(pcm16Rms(new Int16Array(0))).toBe(0);
  });

  it('is sign-independent: a symmetric waveform has the amplitude of its samples', () => {
    expect(pcm16Rms(Int16Array.from([1_000, -1_000, 1_000, -1_000]))).toBe(1_000);
  });

  it('matches the textbook RMS of a known pattern', () => {
    // mean of squares = 315220.5 -> sqrt = 561.44
    const samples = Int16Array.from([0, 100, -100, 500, -500, 1_000, -1_000, 42]);

    expect(pcm16Rms(samples)).toBeCloseTo(561.44, 1);
  });

  it('saturates near int16 full scale, which is how the threshold was calibrated', () => {
    expect(pcm16Rms(Int16Array.from([32_767, -32_768]))).toBeGreaterThan(32_700);
    expect(pcm16Rms(Int16Array.from([32_767, -32_768]))).toBeLessThan(32_768);
  });

  it('separates the measured idle track (RMS 0, peak 2) from the measured speech (RMS 600-2800)', () => {
    expect(pcm16Rms(Int16Array.from([0, 2, -2, 0]))).toBeLessThan(SPEECH_RMS_THRESHOLD);
    expect(pcm16Rms(Int16Array.from([600, -600]))).toBeGreaterThanOrEqual(SPEECH_RMS_THRESHOLD);
  });
});
