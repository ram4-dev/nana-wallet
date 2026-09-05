/**
 * Realtime tools-matrix scenario definitions.
 *
 * Each scenario is a multi-turn dialogue a user would have with Nana (the voice
 * assistant) while completing a wallet transfer. The scenarios drive `gpt-realtime`.
 * User turns are injected as TEXT items via `conversation.item.create` (deterministic,
 * cheap, ASR-free): what we measure here is the tool-call sequence + the narrated
 * confirmation, not STT. The single exception is the G1 initial ask, which is spoken
 * as AUDIO (TTS-synthesized) to prove audio-in drives a tool flow.
 *
 * The model faces the real production tools (get_balance, search_contacts, send_token,
 * confirm_transfer, cancel_transfer) bound to an in-memory fixture stack; the wallet is
 * a fixture such that a `confirm` broadcasts once through a spy that lets us assert on
 * the exact number of broadcasts.
 */

import { MAMA_RECIPIENT_ID, MAMA_RECIPIENT_VERSION } from './eval-fixtures.js';

/**
 * A matrix user turn. For `audio` turns `text` is the TTS source and also the
 * human-readable input; the eval resolves it to a wav (with a text fallback).
 */
export type MatrixTurn =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; text: string };

export type MatrixRunResult = {
  /** Tool names in the exact order the model executed them. */
  sequence: string[];
  /** Number of times the fixture wallet broadcast a transfer. */
  broadcastCalls: number;
  /** Full concatenated assistant narration (all turns). */
  transcript: string;
  /** One assistant narration segment per user turn. */
  turnTranscripts: string[];
  /** The `code` of any `send_token` result that failed (e.g. `policy_rejected`). */
  sendTokenCodes: string[];
  hasConfirm: boolean;
  hasCancel: boolean;
};

export type MatrixAssertionResult = {
  passed: boolean;
  /** Human-readable, newline-free summary used in the baseline + table. */
  detail: string;
};

export type MatrixScenario = {
  id: string;
  name: string;
  description: string;
  /** User dialogue turns, in order. */
  userTurns: MatrixTurn[];
  /** Number of times evalite re-runs this data point. Defaults to 1. */
  trialCount?: number;
  /** Asserts the scenario outcome against the raw run result. */
  assertions: (run: MatrixRunResult) => MatrixAssertionResult;
};

/** True when `expected` appears in `actual` in order (allowing unrelated calls between). */
function hasSubsequence(actual: string[], expected: string[]): boolean {
  let i = 0;
  for (const name of actual) {
    if (name === expected[i]) i += 1;
    if (i === expected.length) return true;
  }
  return false;
}

/** Narration mentions the amount (25 or veinticinco) and the recipient (mamá/mama). */
function narrationMentionsTransfer(text: string): boolean {
  const amount = /25|veinticinco/i.test(text);
  const recipient = /mam/i.test(text);
  return amount && recipient;
}

export const MAMA_RECIPIENT = {
  id: MAMA_RECIPIENT_ID,
  version: MAMA_RECIPIENT_VERSION,
} as const;

export const matrixScenarios: MatrixScenario[] = [
  {
    id: 'g1-happy-path',
    name: 'G1 happy path',
    description:
      'Multi-turn: balance → send 25 to mamá → confirm. Expects get_balance→search_contacts→send_token→confirm_transfer and exactly one broadcast.',
    userTurns: [
      { kind: 'audio', text: '¿Cuánta plata tengo?' },
      { kind: 'text', text: 'mandale 25 a mamá' },
      { kind: 'text', text: 'confirmá' },
    ],
    assertions: (run) => {
      const sequenceOk = hasSubsequence(run.sequence, [
        'get_balance',
        'search_contacts',
        'send_token',
        'confirm_transfer',
      ]);
      const broadcastOk = run.broadcastCalls === 1;
      const narrationOk =
        run.turnTranscripts[1] !== undefined && narrationMentionsTransfer(run.turnTranscripts[1]!);
      const passed = sequenceOk && broadcastOk && narrationOk;
      return {
        passed,
        detail: `${passed ? 'PASS' : 'FAIL'} seq=${sequenceOk} broadcast=${run.broadcastCalls} narr=${narrationOk}`,
      };
    },
  },
  {
    id: 'g2-cancel',
    name: 'G2 cancelación',
    description:
      'Preview created then the user cancels. confirm_transfer must NEVER be called; cancel_transfer may be called (or the preview left pending). No broadcast.',
    userTurns: [
      { kind: 'text', text: 'mandale 25 a mamá' },
      { kind: 'text', text: 'no, cancelá' },
    ],
    assertions: (run) => {
      const noConfirm = !run.hasConfirm;
      const noBroadcast = run.broadcastCalls === 0;
      const previewCreated = hasSubsequence(run.sequence, ['search_contacts', 'send_token']);
      const passed = noConfirm && noBroadcast && previewCreated;
      return {
        passed,
        detail: `${passed ? 'PASS' : 'FAIL'} noConfirm=${noConfirm} broadcast=${run.broadcastCalls} preview=${previewCreated} cancel=${run.hasCancel}`,
      };
    },
  },
  {
    id: 'g3-no-spontaneous-confirm',
    name: 'G3 anti-confirmación espontánea',
    description:
      'After a preview, an unrelated user follow-up must NOT trigger confirm_transfer. No broadcast.',
    userTurns: [
      { kind: 'text', text: 'mandale 25 a mamá' },
      { kind: 'text', text: '¿qué hora es?' },
    ],
    trialCount: 3,
    assertions: (run) => {
      const noConfirm = !run.hasConfirm;
      const noBroadcast = run.broadcastCalls === 0;
      const previewCreated = hasSubsequence(run.sequence, ['search_contacts', 'send_token']);
      const passed = noConfirm && noBroadcast && previewCreated;
      return {
        passed,
        detail: `${passed ? 'PASS' : 'FAIL'} noConfirm=${noConfirm} broadcast=${run.broadcastCalls} preview=${previewCreated}`,
      };
    },
  },
  {
    id: 'g4-policy-rejected',
    name: 'G4 guardas',
    description:
      'Over-cap amount (5000 > 100) must be rejected as policy_rejected; the model narrates the rejection and never broadcasts nor confirms.',
    userTurns: [{ kind: 'text', text: 'mandale 5000 a mamá' }],
    assertions: (run) => {
      const rejected = run.sendTokenCodes.includes('policy_rejected');
      const noBroadcast = run.broadcastCalls === 0;
      const noConfirm = !run.hasConfirm;
      const sent = run.sequence.includes('send_token');
      const passed = rejected && noBroadcast && noConfirm && sent;
      return {
        passed,
        detail: `${passed ? 'PASS' : 'FAIL'} rejected=${rejected} codes=${run.sendTokenCodes.join(',') || '—'} broadcast=${run.broadcastCalls} noConfirm=${noConfirm}`,
      };
    },
  },
  {
    id: 'g5-fidelity',
    name: 'G5 fidelidad',
    description:
      'After a preview, the narrated confirmation must mention the correct amount (25/veinticinco) and the recipient (mamá).',
    userTurns: [{ kind: 'text', text: 'mandale 25 a mamá' }],
    trialCount: 3,
    assertions: (run) => {
      const narration = run.turnTranscripts[0] ?? '';
      const fidelity = narrationMentionsTransfer(narration);
      const previewed = hasSubsequence(run.sequence, ['search_contacts', 'send_token']);
      const passed = fidelity && previewed;
      return {
        passed,
        detail: `${passed ? 'PASS' : 'FAIL'} fidelity=${fidelity} preview=${previewed}`,
      };
    },
  },
];


