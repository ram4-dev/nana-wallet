/**
 * Spoken decision classification for the voice confirmation gate.
 *
 * A confirmation answers the preview the server just read aloud. Two things
 * have to be true, and this module only decides the first:
 *
 *   1. the utterance IS a decision (this file), and
 *   2. the speaker heard the complete read-back (the gate).
 *
 * ## Why not a list of exact sentences
 *
 * It used to be one, and it made confirming a spelling test. Real users answer
 * with the ordinary ways a person agrees — "dale", "listo", "ok", "perfecto" —
 * and every one of them was refused. Worse, the user had no way to discover
 * which word the system wanted, so the flow looked broken.
 *
 * The relationship this module must preserve is NOT "matches a known sentence".
 * It is:
 *
 *   - the utterance must carry a polarity word (yes/confirm/… or no/cancel/…),
 *   - and it must carry NOTHING ELSE: no amount, no recipient, no new
 *     instruction.
 *
 * "Sí, envíale uno a Lucas, confirmo." is the case that matters. It is a NEW
 * instruction that happens to contain "confirmo", and authorizing a transfer
 * from it would mean sending money on the strength of a sentence nobody
 * reviewed. So the rule is compositional: every token has to be polarity or
 * filler, and at least one has to be polarity.
 *
 * ## Cancellations
 *
 * A standalone "no" did not cancel either. The same structural rule now covers
 * both directions, so "no", "mejor no" and "no dale" all work while none of
 * them can be read as consent.
 */

/** Polarity words that authorize. */
const CONFIRM_POLARITY = new Set([
  // Spanish
  'si', 'claro', 'obvio', 'seguro', 'exacto', 'correcto', 'confirmo',
  'confirma', 'confirmar', 'confirmalo', 'bien', 'bueno', 'mandale', 'envia',
  'envialo', 'hacelo', 'procede', 'adelante', 'sale', 'dele', 'vamos', 'joya',
  'genial', 'perfecto', 'listo', 'ok', 'okey', 'okay', 'dale',
  // English
  'yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'go', 'do', 'of', 'course',
]);

/** Polarity words that refuse. Never contains a word from CONFIRM_POLARITY. */
const CANCEL_POLARITY = new Set([
  // Spanish
  'no', 'cancela', 'cancelo', 'cancelar', 'dejalo', 'olvidalo', 'olvidate',
  'para', 'mejor', 'nada',
  // English
  'nope', 'cancel', 'stop', 'nevermind',
]);

/**
 * Words that carry no decision by themselves and may appear in either
 * direction: "sí, dale" confirms and "no dale" cancels, so the polarity word,
 * never the filler, is what decides.
 *
 * A word can be BOTH filler and polarity ('dale', 'bien', 'listo'): filler lets
 * it accompany another word, polarity lets it stand alone. 'no' is deliberately
 * in neither confirmation set, so "no dale" can only ever cancel.
 */
const FILLER = new Set([
  // Spanish
  'dale', 'por', 'favor', 'gracias', 'de', 'una', 'todo', 'esta', 'yo', 'te',
  'lo', 'vos', 'que', 'y', 'nani', 'entonces', 'ahora', 'ya', 'si', 'sí',
  // Articles and nouns that point at the pending transfer instead of carrying
  // a new instruction. "confirmar la transferencia" is a decision about the
  // preview; "confirmar la transferencia de 5 a Lucas" is not, and the amount
  // and the name still fail the rule.
  'la', 'el', 'los', 'las', 'transferencia', 'transfer', 'pago', 'eso',
  'esto', 'esa', 'ese',
  // English
  'it', 'ahead', 'please', 'then', 'now', 'the', 'i',
]);

/**
 * Idioms whose meaning lives in the pair, not in any single word, so the
 * compositional rule cannot reach them.
 */
const CONFIRM_IDIOMS = new Set(['de una', 'todo bien', 'esta bien']);
const CANCEL_IDIOMS = new Set(['mejor no', 'no gracias', 'dejame pensar']);

/**
 * An utterance is a decision only if it is short enough to be one. A long
 * sentence is an instruction, however it ends.
 */
const MAX_DECISION_TOKENS = 6;

function normalize(text: string): string {
  return text
    .toLocaleLowerCase('es-AR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isDecision(
  normalized: string,
  polarity: ReadonlySet<string>,
  idioms: ReadonlySet<string>,
): boolean {
  if (!normalized) return false;
  if (idioms.has(normalized)) return true;
  const tokens = normalized.split(' ');
  if (tokens.length > MAX_DECISION_TOKENS) return false;
  let sawPolarity = false;
  for (const token of tokens) {
    if (polarity.has(token)) {
      sawPolarity = true;
      continue;
    }
    if (!FILLER.has(token)) return false;
  }
  return sawPolarity;
}

export function isConfirmation(text: string): boolean {
  // 'si' and 'sí' both normalize to 'si'; the polarity set holds it and the
  // filler set repeats it so it can accompany another word without deciding.
  return isDecision(normalize(text), CONFIRM_POLARITY, CONFIRM_IDIOMS);
}

export function isCancellation(text: string): boolean {
  return isDecision(normalize(text), CANCEL_POLARITY, CANCEL_IDIOMS);
}
