export type FinancialIntentValue = string | readonly string[];

export type ParsedFinancialIntent = {
  action?: string;
  amount?: FinancialIntentValue;
  token?: FinancialIntentValue;
  recipient?: FinancialIntentValue;
};

export type CompleteFinancialIntent = {
  action: 'send';
  amount: string;
  token: string;
  recipient: string;
};

export type InterpretationReason =
  | 'ambiguous_action'
  | 'missing_amount'
  | 'ambiguous_token'
  | 'ambiguous_recipient';

export type PendingInterpretation = ParsedFinancialIntent & {
  reasons: InterpretationReason[];
  sourceText?: string;
};

export type FinancialInterpretationAssessment =
  | { decision: 'accept'; intent: CompleteFinancialIntent }
  | {
      decision: 'clarify';
      interpretation: PendingInterpretation;
      reasons: InterpretationReason[];
    };

function oneValue(value: FinancialIntentValue | undefined): string | undefined {
  if (typeof value !== 'string') return value?.length === 1 ? oneValue(value[0]) : undefined;
  const normalized = value?.trim();
  return normalized || undefined;
}

function hasAmbiguousValue(value: FinancialIntentValue | undefined): boolean {
  return Array.isArray(value) && value.length !== 1;
}

export function assessFinancialIntent(
  intent: ParsedFinancialIntent,
): FinancialInterpretationAssessment {
  const reasons: InterpretationReason[] = [];
  if (intent.action !== 'send') reasons.push('ambiguous_action');
  if (!oneValue(intent.amount) || hasAmbiguousValue(intent.amount)) {
    reasons.push('missing_amount');
  }
  if (!oneValue(intent.token) || hasAmbiguousValue(intent.token)) {
    reasons.push('ambiguous_token');
  }
  if (!oneValue(intent.recipient) || hasAmbiguousValue(intent.recipient)) {
    reasons.push('ambiguous_recipient');
  }

  if (reasons.length > 0) {
    return {
      decision: 'clarify',
      interpretation: { ...intent, reasons },
      reasons,
    };
  }

  return {
    decision: 'accept',
    intent: {
      action: 'send',
      amount: oneValue(intent.amount)!,
      token: oneValue(intent.token)!,
      recipient: oneValue(intent.recipient)!,
    },
  };
}

/**
 * Extracts only the structure needed to decide whether wallet tools may run.
 * This parser intentionally does not resolve names or infer missing values.
 */
export function parsePossibleFinancialIntent(
  text: string,
): ParsedFinancialIntent | undefined {
  const normalized = text.trim();
  if (!/\b(send|transfer|pay|envi(?:ar|á)|mand(?:ar|á)|transferir|pagar)\b/iu.test(normalized)) {
    return undefined;
  }

  const action = /\b(send|envi(?:ar|á)|mand(?:ar|á)|transfer(?:ir)?|transferí)\b/iu.test(normalized)
    ? 'send'
    : 'pay';
  const amountMatch = /\b(\d+(?:[.,]\d+)?)\s*(?:(?!to\b|a\b|para\b|on\b|en\b)([A-Za-z₮]{2,8}))?/iu.exec(normalized);
  const amount = amountMatch?.[1]?.replace(',', '.');
  const token = amountMatch?.[2];
  const recipientMatch = /\b(?:to|a|para)\s+(.+?)(?:\s+(?:on|en)\s+\w+)?$/iu.exec(normalized);
  const recipientText = recipientMatch?.[1]?.trim();

  return {
    action,
    ...(amount ? { amount } : {}),
    ...(token ? { token: token.toUpperCase() } : {}),
    ...(recipientText
      ? {
          recipient: /\s+(?:or|o)\s+/iu.test(recipientText)
            ? recipientText.split(/\s+(?:or|o)\s+/iu).map((value) => value.trim())
            : recipientText,
        }
      : {}),
  };
}

export function clarificationForInterpretation(
  interpretation: PendingInterpretation,
  language: 'es' | 'en',
): string {
  const action = interpretation.action === 'send'
    ? language === 'es' ? 'enviar una transferencia' : 'send a transfer'
    : language === 'es' ? 'hacer esa acción financiera' : 'take that financial action';
  const fields = [
    !oneValue(interpretation.amount) || hasAmbiguousValue(interpretation.amount)
      ? language === 'es' ? 'el monto' : 'the amount'
      : undefined,
    !oneValue(interpretation.token) || hasAmbiguousValue(interpretation.token)
      ? language === 'es' ? 'el token' : 'the token'
      : undefined,
    !oneValue(interpretation.recipient) || hasAmbiguousValue(interpretation.recipient)
      ? language === 'es' ? 'el destinatario' : 'the recipient'
      : undefined,
  ].filter((value): value is string => Boolean(value));
  if (language === 'es') {
    return `Entendí que querés ${action}, pero necesito que aclares ${fields.join(', ')}. No voy a preparar nada hasta confirmarlo.`;
  }
  return `I understood that you want to ${action}, but I need you to clarify ${fields.join(', ')}. I will not prepare anything until you confirm it.`;
}

export function isInterpretationAcceptance(text: string): boolean {
  return new Set(['yes', 'yes, that', 'accept', 'accept it', 'confirm', 'sí', 'si', 'acepto', 'aceptar', 'confirmo'])
    .has(normalize(text));
}

export function isInterpretationRejection(text: string): boolean {
  return new Set(['no', 'no, that is wrong', 'reject', 'reject it', 'correct it', 'no es eso', 'rechazar', 'corrijo'])
    .has(normalize(text));
}

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase('es-AR').normalize('NFC').replace(/[.!?]+$/u, '').replace(/\s+/gu, ' ');
}
