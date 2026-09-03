const CONFIRMATIONS = new Set([
  'confirm', 'i confirm', 'yes confirm', 'yes, confirm', 'yes i confirm', 'yes, i confirm',
  'confirm transfer', 'confirm the transfer', 'confirmar', 'confirmo', 'sí confirmo', 'sí, confirmo',
  'si confirmo', 'si, confirmo', 'sí confirma', 'sí, confirma', 'si confirma', 'si, confirma',
  'te lo confirmo', 'sí te lo confirmo', 'sí, te lo confirmo', 'si te lo confirmo', 'si, te lo confirmo',
  'confírmalo', 'confirmalo', 'sí confírmalo', 'sí, confírmalo', 'si confirmalo', 'si, confirmalo',
  'lo confirmo', 'sí lo confirmo', 'sí, lo confirmo', 'si lo confirmo', 'si, lo confirmo',
  'yo te lo confirmo', 'sí yo te lo confirmo', 'sí, yo te lo confirmo',
  'confirmar transferencia', 'confirmar la transferencia', 'confirmo la transferencia',
]);

const CANCELLATIONS = new Set([
  'cancel', 'cancel transfer', 'cancel the transfer', 'cancel it', 'no, cancel',
  'cancelar', 'cancelo', 'cancelar transferencia', 'cancelar la transferencia',
  'cancelo la transferencia',
]);

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');
}

export function isConfirmation(text: string): boolean {
  return CONFIRMATIONS.has(normalize(text));
}

export function isCancellation(text: string): boolean {
  return CANCELLATIONS.has(normalize(text));
}
