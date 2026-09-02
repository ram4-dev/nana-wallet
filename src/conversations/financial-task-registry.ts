export class FinancialTaskRegistry {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, unknown>();
  private readonly listeners = new Set<(event: unknown) => void>();
  private accepting = true;

  public start(input: { operationId: string; run: () => Promise<void> }): 'started' | 'already_running' {
    if (!this.accepting || this.tasks.has(input.operationId)) return 'already_running';
    let execution: Promise<void>;
    try {
      execution = Promise.resolve(input.run());
    } catch (error) {
      execution = Promise.reject(error);
    }
    const task = execution.catch((error) => {
      this.failures.set(input.operationId, error);
    }).finally(() => {
      this.tasks.delete(input.operationId);
    });
    this.tasks.set(input.operationId, task);
    return 'started';
  }

  public has(operationId: string): boolean { return this.tasks.has(operationId); }
  public get isAccepting(): boolean { return this.accepting; }
  public failure(operationId: string): unknown { return this.failures.get(operationId); }

  public stopAccepting(): void { this.accepting = false; }

  public publish(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async wait(operationId: string): Promise<void> {
    await this.tasks.get(operationId);
  }

  public async drain(options: { timeoutMs: number }): Promise<void> {
    this.stopAccepting();
    const pending = [...this.tasks.values()];
    if (pending.length === 0) return;
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
      throw new Error('Financial task drain timeout must be positive.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
