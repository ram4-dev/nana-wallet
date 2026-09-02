export class FinancialTaskRegistry {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, unknown>();

  public start(input: { operationId: string; run: () => Promise<void> }): 'started' | 'already_running' {
    if (this.tasks.has(input.operationId)) return 'already_running';
    const task = input.run().catch((error) => {
      this.failures.set(input.operationId, error);
    }).finally(() => {
      this.tasks.delete(input.operationId);
    });
    this.tasks.set(input.operationId, task);
    return 'started';
  }

  public has(operationId: string): boolean { return this.tasks.has(operationId); }
  public failure(operationId: string): unknown { return this.failures.get(operationId); }

  public async drain(options: { timeoutMs: number }): Promise<void> {
    const pending = [...this.tasks.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs)),
    ]);
  }
}
