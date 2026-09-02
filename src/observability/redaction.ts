export const REDACTED = '[redacted]';

const ADDRESS_PATTERN = /\b0x[0-9a-f]{40,64}\b/giu;
const SECRET_PATTERNS = [
  /\b(?:bearer\s+|authorization\s*[:=]\s*)[^\s,;]+/giu,
  /\b(?:sk|pk|api|token|secret|key)[_-]?[a-z0-9._-]{8,}\b/giu,
  /\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/giu,
  /\b(?:hash|txhash|transactionhash)\s*[:=]?\s*0x[a-z0-9]+\b/giu,
  /\b(?:amount|monto|balance|saldo)\s*[:=]?\s*\d+(?:[.,]\d+)?\b/giu,
  /\b\d+(?:[.,]\d+)?\s*(?:usdt|usd₮|eth|ars|usd)\b/giu,
];

// These patterns intentionally cover only recipient-shaped phrases. General
// conversational text remains useful for debugging while names in financial
// turns do not leave the process in a trace.
const RECIPIENT_PATTERNS = [
  /\b((?:to|a|para)\s+)(?:(?:my|mi)\s+)?[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?/giu,
  /\b((?:recipient|destinatario)\s*[:=]\s*)[\p{L}][\p{L}'-]*/giu,
];

export function redactText(value: string): string {
  let redacted = value.replace(ADDRESS_PATTERN, REDACTED);
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
  for (const pattern of RECIPIENT_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  return redacted;
}

const SENSITIVE_KEY_PATTERN = /(?:address|amount|balance|token|secret|key|authorization|payload|provider|request|response|raw|hash|recipient|name|alias|description|private|credential|password|seed)/iu;

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(item),
  ]));
}
