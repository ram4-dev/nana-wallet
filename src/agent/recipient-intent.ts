export type RecipientReference =
  | { kind: 'none' }
  | { kind: 'pronoun' }
  | { kind: 'relationship'; query: string }
  | { kind: 'query'; query: string };

const TRANSFER_PREFIX = /^(?:send|transfer|mandale|mandá|manda|enviá|envia)\s+(?:money|funds|plata|dinero)?\s*(?:to|a)?\s*/i;
const PRONOUN = /^(?:him|her|them|él|el|ella|ellos|ellas|le)$/i;
const RELATIONSHIP = /\b(?:my|mi|mis|your|tu|tus)\s+(?:grandson|granddaughter|grandchild|nieto|nieta|hijo|hija|hijos|padre|madre|sibling|hermano|hermana)\b/i;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ADDRESS_IN_TEXT = /\b0x[a-fA-F0-9]{40}\b/;

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
  const matched = text.trim().match(TRANSFER_PREFIX);
  if (!matched) return { kind: 'none' };
  const reference = cleanReference(text.trim().slice(matched[0].length));
  if (!reference || ADDRESS.test(reference)) return { kind: 'none' };
  if (PRONOUN.test(reference)) return { kind: 'pronoun' };
  if (RELATIONSHIP.test(reference)) return { kind: 'relationship', query: reference };
  return { kind: 'query', query: reference };
}

/** A user-supplied exact address keeps the legacy explicit-address flow. */
export function hasExplicitTransferAddress(text: string): boolean {
  return /\b(?:send|transfer|mandale|mandá|manda|enviá|envia)\b/i.test(text) && ADDRESS_IN_TEXT.test(text);
}
