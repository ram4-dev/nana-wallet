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
});
