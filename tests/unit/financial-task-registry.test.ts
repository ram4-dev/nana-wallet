import { describe, expect, it, vi } from 'vitest';
import { FinancialTaskRegistry } from '../../src/conversations/financial-task-registry.js';

describe('financial task registry', () => {
  it('does not launch a claimed operation twice and drains active work', async () => {
    const registry = new FinancialTaskRegistry();
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    expect(registry.start({ operationId: 'attempt-1', run })).toBe('started');
    expect(registry.start({ operationId: 'attempt-1', run })).toBe('already_running');
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await registry.drain({ timeoutMs: 100 });
    expect(registry.has('attempt-1')).toBe(false);
  });
});
