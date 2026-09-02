const CONFIRMATIONS = new Set([
  'confirm', 'i confirm', 'yes confirm', 'yes, confirm', 'yes i confirm', 'yes, i confirm',
  'confirm transfer', 'confirm the transfer', 'confirmar', 'confirmo', 'sí confirmo',
  'si confirmo', 'confirmar transferencia', 'confirmar la transferencia', 'confirmo la transferencia',
]);

const CANCELLATIONS = new Set([
  'cancel', 'cancel transfer', 'cancel the transfer', 'cancel it', 'no, cancel',
  'cancelar', 'cancelo', 'cancelar transferencia', 'cancelar la transferencia',
  'cancelo la transferencia',
]);

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase('es-AR').normalize('NFC')
    .replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');
}

export function isConfirmation(text: string): boolean {
  return CONFIRMATIONS.has(normalize(text));
}

export function isCancellation(text: string): boolean {
  return CANCELLATIONS.has(normalize(text));
}
