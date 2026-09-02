import { describe, expect, it } from 'vitest';
import { DeferredTurnQueue } from '../../../src/livekit/deferred-turn.js';

describe('one-item deferred turn queue', () => {
  it('retains only the first final turn and removes it exactly once', () => {
    const queue = new DeferredTurnQueue();
    expect(queue.enqueue('first request')).toBe(true);
    expect(queue.enqueue('later request')).toBe(false);
    expect(queue.peek()).toBe('first request');
    expect(queue.take()).toBe('first request');
    expect(queue.take()).toBeUndefined();
  });

  it('loses deferred text when the worker is discarded instead of replaying it', () => {
    const queue = new DeferredTurnQueue();
    queue.enqueue('do not replay');
    queue.clear();
    expect(queue.peek()).toBeUndefined();
  });
});
