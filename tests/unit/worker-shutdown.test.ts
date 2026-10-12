import { describe, expect, it, vi } from 'vitest';
import { FinancialTaskRegistry } from '../../src/conversations/financial-task-registry.js';
import { createLiveKitWorkerRuntime } from '../../src/livekit/worker.js';

describe('LiveKit worker shutdown', () => {
  it('stops new financial work, drains within the deadline, and closes dependencies once', async () => {
    const registry = new FinancialTaskRegistry();
    const close = vi.fn(async () => undefined);
    let release!: () => void;
    registry.start({
      operationId: 'attempt-1',
      run: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const runtime = createLiveKitWorkerRuntime({
      dependencies: { financialTasks: registry, close } as never,
      shutdownTimeoutMs: 20,
    });

    const startedAt = Date.now();
    await runtime.close();
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(runtime.acceptingJobs).toBe(false);
    expect(registry.isAccepting).toBe(false);
    expect(registry.start({ operationId: 'attempt-2', run: async () => undefined })).toBe('already_running');
    expect(close).toHaveBeenCalledOnce();

    release();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('finishes even when a dependency close hangs, instead of holding the process open', async () => {
    // THE OBSERVED DEFECT. `dependencies.close()` was awaited unbounded, and a live
    // job showed the cost: it logged `job exiting` and `disconnected from room`,
    // then kept handling audio, creating speech handles and running tool calls, and
    // survived its own SIGTERM. The process never exited, stale jobs accumulated at
    // 127-886 MB each competing for four cores, and the live session's speech
    // stalled 2-7 s between deciding to answer and the first audio frame.
    const registry = new FinancialTaskRegistry();
    // Never settles: the shape of a websocket or pool close that hangs.
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createLiveKitWorkerRuntime({
      dependencies: { financialTasks: registry, close } as never,
      shutdownTimeoutMs: 20,
    });

    try {
      const startedAt = Date.now();
      await runtime.close();

      // Bounded: the deadline plus a margin, never the hang.
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(close).toHaveBeenCalledOnce();
      // And it says so, rather than silently pretending the close succeeded.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dependency close did not finish within 20ms'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('still drains in-flight financial work before giving up on the close', async () => {
    // The ordering that makes the timeout safe: money-safety is a WAIT, and it is
    // bounded and runs FIRST, so a hung connection teardown can never cut short a
    // transfer still being settled.
    const registry = new FinancialTaskRegistry();
    const calls: string[] = [];
    let release!: () => void;
    registry.start({
      operationId: 'attempt-1',
      run: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const close = vi.fn(() => {
      calls.push('close');
      return new Promise<void>(() => undefined);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createLiveKitWorkerRuntime({
      dependencies: { financialTasks: registry, close } as never,
      shutdownTimeoutMs: 30,
    });

    try {
      // Drains only when the work settles, so the ordering is observable.
      setTimeout(release, 75);
      await runtime.close();

      expect(calls).toEqual(['close']);
      expect(registry.isAccepting).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
