export type RecipientReference =
  | { kind: 'none' }
  | { kind: 'pronoun' }
  | { kind: 'relationship'; query: string }
  | { kind: 'query'; query: string };

const TRANSFER_PREFIX = /^(?:send|transfer|mandale|mandá|manda|enviá|envia)\s+(?:money|funds|plata|dinero)?\s*(?:to|a)?\s*/i;
const LEADING_VOCATIVE = /^(?:(?:hey|hi|hello|hola)\s+)?(?:nana|nani)\s*[,!:.-]?\s*/i;
const LEADING_POLITENESS = /^(?:please|por\s+favor)\s*[,!:.-]?\s*/i;
const PRONOUN = /^(?:him|her|them|él|el|ella|ellos|ellas|le)$/i;
const RELATIONSHIP = /\b(?:my|mi|mis|your|tu|tus)\s+(?:grandson|granddaughter|grandchild|nieto|nieta|hijo|hija|hijos|padre|madre|sibling|hermano|hermana)\b/i;
const QUALIFIED_RELATIONSHIP = /^((?:my|mi|mis|your|tu|tus)\s+(?:grandson|granddaughter|grandchild|nieto|nieta|hijo|hija|hijos|padre|madre|sibling|hermano|hermana))\s+([\p{L}][\p{L}\p{M}'’-]*(?:\s+[\p{L}][\p{L}\p{M}'’-]*)*)$/iu;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ADDRESS_IN_TEXT = /\b0x[a-fA-F0-9]{40}\b/;
const WRITTEN_AMOUNT = '(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte)';
const AMOUNT_AND_TOKEN_BEFORE_PREPOSITION = new RegExp(
  `^\\s*(?:\\d+(?:[.,]\\d+)?|${WRITTEN_AMOUNT})(?:\\s+[A-Za-z][\\w-]*)?\\s+(?:to|a)\\s+`,
  'i',
);

function cleanReference(value: string): string {
  return value
    .replace(/^(?:the|el|la)\s+/i, '')
    .replace(/\s+(?:money|funds|plata|dinero)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

/**
 * Finds a recipient reference only when the turn is a transfer request. It
 * intentionally returns no address-like input: explicit-address transfers are
 * handled by the existing WDK path and recipient memory never indexes them.
 */
export function detectRecipientReference(text: string): RecipientReference {
  const normalizedTurn = text
    .trim()
    .replace(LEADING_VOCATIVE, '')
    .replace(LEADING_POLITENESS, '');
  const matched = normalizedTurn.match(TRANSFER_PREFIX);
  if (!matched) return { kind: 'none' };
  const remainder = normalizedTurn.slice(matched[0].length);
  const reference = cleanReference(remainder.replace(AMOUNT_AND_TOKEN_BEFORE_PREPOSITION, ''));
  if (!reference || ADDRESS.test(reference)) return { kind: 'none' };
  if (PRONOUN.test(reference)) return { kind: 'pronoun' };
  const qualifiedRelationship = reference.match(QUALIFIED_RELATIONSHIP);
  if (qualifiedRelationship) {
    const [, relationship, name] = qualifiedRelationship;
    return { kind: 'query', query: `${name} ${relationship}` };
  }
  if (RELATIONSHIP.test(reference)) return { kind: 'relationship', query: reference };
  return { kind: 'query', query: reference };
}

/** A user-supplied exact address keeps the legacy explicit-address flow. */
export function hasExplicitTransferAddress(text: string): boolean {
  return /\b(?:send|transfer|mandale|mandá|manda|enviá|envia)\b/i.test(text) && ADDRESS_IN_TEXT.test(text);
}
