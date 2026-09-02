export type NarrationReason = 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain';

export function shouldNarrate(input: { reason: NarrationReason; previousReason?: NarrationReason; previousText?: string; text: string }): boolean {
  if (input.reason === 'answer') return true;
  if (input.reason !== input.previousReason) return true;
  return input.text.trim() !== (input.previousText ?? '').trim();
}

export function narrateFinancialFact(input: { language: 'es' | 'en'; phase: 'started' | 'awaiting_confirmation' | 'broadcasting' | 'verifying' | 'completed' | 'failed' | 'uncertain'; amount?: string; token?: string }): string {
  if (input.language === 'es') {
    if (input.phase === 'started') return 'Voy a preparar la transferencia.';
    if (input.phase === 'awaiting_confirmation') return `Preparé ${input.amount ?? ''} ${input.token ?? ''}. Revisá los datos y confirmá para continuar.`.replace(/\s+/gu, ' ').trim();
    if (input.phase === 'broadcasting') return 'Estoy enviando la transferencia.';
    if (input.phase === 'verifying') return 'La transferencia fue enviada; estoy verificando el resultado.';
    if (input.phase === 'completed') return 'La transferencia quedó confirmada.';
    if (input.phase === 'uncertain') return 'No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.';
    return 'La transferencia no pudo completarse.';
  }
  if (input.phase === 'started') return 'I will prepare the transfer.';
  if (input.phase === 'awaiting_confirmation') return `I prepared ${input.amount ?? ''} ${input.token ?? ''}. Review the details and confirm to continue.`.replace(/\s+/gu, ' ').trim();
  if (input.phase === 'broadcasting') return 'I am sending the transfer.';
  if (input.phase === 'verifying') return 'The transfer was sent; I am verifying the result.';
  if (input.phase === 'completed') return 'The transfer is confirmed.';
  if (input.phase === 'uncertain') return 'I could not confirm the result. Check wallet history before trying another transfer.';
  return 'The transfer could not be completed.';
}
