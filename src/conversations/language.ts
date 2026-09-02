export type ConversationLanguage = 'es' | 'en';

const SPANISH_WORDS = /\b(hola|saldo|transferir|transferencia|enviar|mandar|confirmar|cancelar|gracias|quiero|podés|necesito|para|sí|si)\b/iu;
const ENGLISH_WORDS = /\b(hello|balance|send|transfer|confirm|cancel|thanks|want|need|please|yes|to)\b/iu;

/**
 * Switches only on clear lexical evidence. Accent marks count as Spanish
 * evidence; an ambiguous or very short turn keeps the persisted session
 * language so confirmations do not oscillate between turns.
 */
export function detectConversationLanguage(
  text: string,
  previous: ConversationLanguage = 'es',
): ConversationLanguage {
  const normalized = text.trim();
  if (!normalized) return previous;
  const spanish = (SPANISH_WORDS.test(normalized) ? 1 : 0) +
    (/[áéíóúñ¿¡]/iu.test(normalized) ? 1 : 0);
  const english = ENGLISH_WORDS.test(normalized) ? 1 : 0;
  if (spanish > english) return 'es';
  if (english > spanish) return 'en';
  return previous;
}

export function languageInstruction(language: ConversationLanguage): string {
  return language === 'es'
    ? 'Respond in Spanish using the product\'s natural Rioplatense phrasing.'
    : 'Respond in English.';
}

export function exactFinancialFactsBoundary(language: ConversationLanguage): string {
  return language === 'es'
    ? 'Conservá exactamente los montos, tokens, direcciones, redes y requisitos de confirmación; no los traduzcas ni los redondees.'
    : 'Keep amounts, tokens, addresses, networks, and confirmation requirements exact; never translate or round them.';
}
