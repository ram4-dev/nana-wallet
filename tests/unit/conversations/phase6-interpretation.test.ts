import { describe, expect, it } from 'vitest';
import {
  assessFinancialIntent,
  clarificationForInterpretation,
  isInterpretationAcceptance,
  isInterpretationRejection,
  parsePossibleFinancialIntent,
} from '../../../src/conversations/interpretation.js';

describe('structural financial interpretation gate', () => {
  it('accepts only a complete, unambiguous transfer structure', () => {
    expect(assessFinancialIntent({
      action: 'send',
      amount: '10',
      token: 'USDT',
      recipient: 'Ana',
    })).toEqual({
      decision: 'accept',
      intent: { action: 'send', amount: '10', token: 'USDT', recipient: 'Ana' },
    });
  });

  it('requires missing fields and rejects ambiguous alternatives before tools run', () => {
    const assessment = assessFinancialIntent({
      action: 'send',
      amount: ['10', '20'],
      token: ['USDT', 'USDC'],
      recipient: ['Ana', 'Bruno'],
    });
    expect(assessment).toMatchObject({
      decision: 'clarify',
      reasons: ['missing_amount', 'ambiguous_token', 'ambiguous_recipient'],
    });
  });

  it('does not infer a token or recipient from an incomplete request', () => {
    expect(parsePossibleFinancialIntent('send 10 to Ana')).toEqual({
      action: 'send',
      amount: '10',
      recipient: 'Ana',
    });
    const assessment = assessFinancialIntent(parsePossibleFinancialIntent('send 10 to Ana')!);
    expect(assessment.decision).toBe('clarify');
    if (assessment.decision === 'clarify') {
      expect(clarificationForInterpretation(assessment.interpretation, 'es'))
        .toContain('el token');
    }
  });

  it('allows safe accept/reject gates without treating them as transfer approval', () => {
    expect(isInterpretationAcceptance('sí')).toBe(true);
    expect(isInterpretationAcceptance('yes')).toBe(true);
    expect(isInterpretationRejection('no, that is wrong')).toBe(true);
  });
});
