const REDACTED = '[redacted]';

const SECRET_PATTERNS = [
  /0x[0-9a-f]{40,64}/giu,
  /\b(?:sk|pk|api|token|secret|key)[_-]?[a-z0-9._-]{8,}\b/giu,
  /\b(?:amount|monto|balance|saldo|token|usdt|eth|usd₮)\s*[:=]?\s*\d+(?:[.,]\d+)?\b/giu,
  /\b\d+(?:[.,]\d+)?\s*(?:usdt|usd₮|eth|ars|usd)\b/giu,
  /\b(?:hash|txhash|transactionhash)\s*[:=]?\s*0x[a-z0-9]+\b/giu,
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const lower = key.toLowerCase();
    return [key, /(?:address|amount|balance|token|secret|key|authorization|payload|hash|recipient|name)/u.test(lower) ? REDACTED : redactValue(item)];
  }));
}
