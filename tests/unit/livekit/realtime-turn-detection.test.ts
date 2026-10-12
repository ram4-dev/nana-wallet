import { describe, expect, it } from 'vitest';
import { realtimeModelOptions } from '../../../src/livekit/create-agent-session.js';

/**
 * The turn-taking contract of the voice session.
 *
 * WHY THIS ASSERTS AGAINST THE REAL VENDOR AND NOT A DOUBLE
 * --------------------------------------------------------
 * The defect this pins was not "the app forgot a line". The app passed NO
 * `turnDetection`, so the plugin's own default applied, and that default is
 *
 *   { type: 'semantic_vad', eagerness: 'medium', ... }
 *
 * `semantic_vad` decides the end of a turn with a MODEL, not by measuring
 * silence, so it is inherently slower than a silence threshold — and with
 * `inputAudioNoiseReduction` left `undefined` it is slower still, because floor
 * noise keeps the detector from concluding. Measured on the deployed stack: the
 * agent sat silent through speech spans of 28.4s / 15.5s / 10.1s and through
 * gaps of 8.5s / 6.8s / 5.4s between a tool finishing and the first audio.
 *
 * An injected double cannot catch that class of bug: a test that mocks the
 * vendor only proves the app passed an object, never that the object is one the
 * vendor ACTS ON. So these assertions build the real `RealtimeModel` with the
 * app's own options and read the configuration it will actually send.
 */
describe('the realtime model configures turn-taking explicitly', () => {
  async function effectiveModel(environment: NodeJS.ProcessEnv = {}) {
    const mod = await import('@livekit/agents-plugin-openai');
    const RealtimeModel = (mod as unknown as {
      realtime: { RealtimeModel: new (options: Record<string, unknown>) => unknown };
    }).realtime.RealtimeModel;
    // EXACTLY the options the app builds. No hand-written duplicate: the point
    // of the assertion is that the app's own object is the one that works.
    const options = realtimeModelOptions({ ...environment, OPENAI_API_KEY: 'test-key' });
    return new RealtimeModel(options as unknown as Record<string, unknown>) as {
      _options: Record<string, unknown>;
    };
  }

  it('RED: pins an AGGRESSIVE semantic detector instead of inheriting the patient default', async () => {
    const model = await effectiveModel();

    // The chosen behaviour: still model-decided (so a pause mid-sentence is not
    // cut off), but no longer waiting the way `medium` does.
    expect(model._options.turnDetection).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
    });
  });

  it('RED: turns on noise reduction, which the default leaves undefined', async () => {
    const model = await effectiveModel();

    // Without this the microphone's floor noise reads as "still speaking" and
    // the detector keeps waiting. `far_field` is the laptop/phone-speaker case
    // this web app actually runs in.
    expect(model._options.inputAudioNoiseReduction).toEqual({ type: 'far_field' });
  });

  it('no longer inherits the plugin default it was silently getting', async () => {
    const model = await effectiveModel();

    const turnDetection = model._options.turnDetection as { eagerness?: string };
    expect(turnDetection.eagerness).not.toBe('medium');
    expect(model._options.inputAudioNoiseReduction).toBeDefined();
  });

  it('keeps them operator-overridable, resolved per call like the transcriber', async () => {
    const eager = await effectiveModel({ OPENAI_REALTIME_TURN_EAGERNESS: 'medium' });
    expect(eager._options.turnDetection).toMatchObject({ eagerness: 'medium' });

    const near = await effectiveModel({ OPENAI_REALTIME_NOISE_REDUCTION: 'near_field' });
    expect(near._options.inputAudioNoiseReduction).toEqual({ type: 'near_field' });
  });

  it('falls back to the deliberate defaults on an unrecognised override', async () => {
    // A typo in a deployment variable must not silently disable either setting:
    // failing open to the plugin default is what produced the defect.
    const model = await effectiveModel({
      OPENAI_REALTIME_TURN_EAGERNESS: 'as-fast-as-possible',
      OPENAI_REALTIME_NOISE_REDUCTION: 'ultra',
    });

    expect(model._options.turnDetection).toEqual({ type: 'semantic_vad', eagerness: 'high' });
    expect(model._options.inputAudioNoiseReduction).toEqual({ type: 'far_field' });
  });
});
