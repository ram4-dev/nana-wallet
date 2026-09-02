export function detectConversationLanguage(text: string, previous: 'es' | 'en' = 'es'): 'es' | 'en' {
  if (/[áéíóúñ¿¡]|\b(hola|saldo|transferir|enviar|confirmar|cancelar|gracias)\b/iu.test(text)) return 'es';
  if (/\b(hello|balance|send|transfer|confirm|cancel|thanks)\b/iu.test(text)) return 'en';
  return previous;
}
