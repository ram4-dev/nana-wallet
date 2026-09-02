export class DeferredTurnQueue {
  private value: string | undefined;
  public enqueue(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    if (this.value !== undefined) return false;
    this.value = text;
    return true;
  }
  public peek(): string | undefined { return this.value; }
  public take(): string | undefined {
    const value = this.value;
    this.value = undefined;
    return value;
  }
  public clear(): void { this.value = undefined; }
  public get hasValue(): boolean { return this.value !== undefined; }
}
