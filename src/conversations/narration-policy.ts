export type NarrationReason = 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain';

export type NarrationInput = {
  reason: NarrationReason;
  text: string;
  now?: number;
  operationId?: string;
};

export type NarrationPolicy = {
  shouldNarrate(input: NarrationInput): boolean;
  remember(input: NarrationInput): void;
};

export function createNarrationPolicy(options: {
  clock?: { now(): number };
  delayMs?: number;
} = {}): NarrationPolicy {
  const clock = options.clock ?? { now: () => Date.now() };
  const delayMs = options.delayMs ?? 3_000;
  const previousByOperation = new Map<string, NarrationInput>();
  const workingStartedAtByOperation = new Map<string, number>();
  return {
    shouldNarrate(input) {
      const operationId = input.operationId ?? 'default';
      const text = input.text.trim();
      if (!text) return false;
      if (input.reason === 'delayed') {
        const now = input.now ?? clock.now();
        const workingStartedAt = workingStartedAtByOperation.get(operationId);
        if (workingStartedAt === undefined || now - workingStartedAt < delayMs) return false;
      }
      const previous = previousByOperation.get(operationId);
      if (!previous) return true;
      return input.reason !== previous.reason || text !== previous.text.trim();
    },
    remember(input) {
      const operationId = input.operationId ?? 'default';
      const value = { ...input, text: input.text.trim(), now: input.now ?? clock.now() };
      if (value.reason === 'started') workingStartedAtByOperation.set(operationId, value.now!);
      if (value.reason === 'result' || value.reason === 'uncertain') workingStartedAtByOperation.delete(operationId);
      previousByOperation.set(operationId, value);
    },
  };
}

export function shouldNarrate(input: {
  reason: NarrationReason;
  previousReason?: NarrationReason;
  previousText?: string;
  text: string;
  now?: number;
  startedAt?: number;
  delayMs?: number;
}): boolean {
  if (!input.text.trim()) return false;
  if (input.reason === 'delayed' &&
    (input.startedAt === undefined || input.now === undefined ||
      input.now - input.startedAt < (input.delayMs ?? 3_000))) return false;
  if (input.previousReason === undefined) return true;
  return input.reason !== input.previousReason || input.text.trim() !== (input.previousText ?? '').trim();
}

export function narrateFinancialFact(input: {
  language: 'es' | 'en';
  phase: 'started' | 'awaiting_confirmation' | 'broadcasting' | 'verifying' | 'completed' | 'failed' | 'uncertain';
  amount?: string;
  token?: string;
  recipient?: string;
}): string {
  if (input.language === 'es') {
    if (input.phase === 'started') return 'Voy a preparar la transferencia.';
    if (input.phase === 'awaiting_confirmation') {
      const recipient = input.recipient ? ` para ${input.recipient}` : '';
      return `Preparé ${input.amount ?? ''} ${input.token ?? ''}${recipient}. Revisá los datos y confirmá para continuar.`.replace(/\s+/gu, ' ').trim();
    }
    if (input.phase === 'broadcasting') return 'Estoy enviando la transferencia.';
    if (input.phase === 'verifying') return 'La transferencia fue enviada; estoy verificando el resultado.';
    if (input.phase === 'completed') return 'La transferencia quedó confirmada.';
    if (input.phase === 'uncertain') return 'No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.';
    return 'La transferencia no pudo completarse.';
  }
  if (input.phase === 'started') return 'I will prepare the transfer.';
  if (input.phase === 'awaiting_confirmation') {
    const recipient = input.recipient ? ` for ${input.recipient}` : '';
    return `I prepared ${input.amount ?? ''} ${input.token ?? ''}${recipient}. Review the details and confirm to continue.`.replace(/\s+/gu, ' ').trim();
  }
  if (input.phase === 'broadcasting') return 'I am sending the transfer.';
  if (input.phase === 'verifying') return 'The transfer was sent; I am verifying the result.';
  if (input.phase === 'completed') return 'The transfer is confirmed.';
  if (input.phase === 'uncertain') return 'I could not confirm the result. Check wallet history before trying another transfer.';
  return 'The transfer could not be completed.';
}
