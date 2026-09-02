export type ParsedFinancialIntent = {
  action?: 'send';
  amount?: string;
  token?: string;
  recipient?: string;
};

export type PendingInterpretation = {
  action?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  reasons: Array<'ambiguous_action' | 'missing_amount' | 'ambiguous_token' | 'ambiguous_recipient'>;
};

export type FinancialInterpretationAssessment =
  | { decision: 'accept'; intent: Required<ParsedFinancialIntent> }
  | { decision: 'clarify'; interpretation: PendingInterpretation; reasons: PendingInterpretation['reasons'] };

export function assessFinancialIntent(intent: ParsedFinancialIntent): FinancialInterpretationAssessment {
  const reasons: PendingInterpretation['reasons'] = [];
  if (intent.action !== 'send') reasons.push('ambiguous_action');
  if (!intent.amount?.trim()) reasons.push('missing_amount');
  if (!intent.token?.trim()) reasons.push('ambiguous_token');
  if (!intent.recipient?.trim()) reasons.push('ambiguous_recipient');
  if (reasons.length > 0) return { decision: 'clarify', interpretation: { ...intent, reasons }, reasons };
  return { decision: 'accept', intent: intent as Required<ParsedFinancialIntent> };
}
