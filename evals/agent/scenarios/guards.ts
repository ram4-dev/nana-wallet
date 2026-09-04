import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import {
  ALLOWED_ADDRESS,
  MAMA_ADDRESS,
  MAMA_ID,
  OTHER_ADDRESS,
  sendTokenArgs,
} from './constants.js';

const LIVE_POLICY_ENV = {
  WDK_TOOLS_SOURCE: 'live',
  WDK_MAX_TRANSFER_AMOUNT: '0.05',
  WDK_ALLOWED_RECIPIENTS: ALLOWED_ADDRESS,
};

/**
 * Guard behaviors: the agent must fail closed before a broadcast — ask for
 * missing data, refuse an unconfirmed broadcast, enforce the live policy
 * allowlist/cap, and revalidate a session-bound recipient.
 */
export const guardScenarios: AgentScenario[] = [
  {
    name: 'incomplete transfer asks for missing fields and never broadcasts',
    turns: [
      {
        userText: 'Send 10 USDT',
        modelSteps: [
          modelStep([{ type: 'text', text: 'Who do you want to send it to?' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: [],
      broadcastReached: false,
      previewRequested: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'broadcast attempt without a pending preview is refused as confirmation_required',
    turns: [
      {
        userText: `Send 10 USDT to ${OTHER_ADDRESS}`,
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'unconfirmed-broadcast',
              toolName: 'send_token',
              input: sendTokenArgs(OTHER_ADDRESS, '10', false),
            },
          ]),
          modelStep([
            { type: 'text', text: 'I cannot broadcast without a confirmed preview.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'error',
      code: 'confirmation_required',
      toolNames: ['send_token'],
      toolCall: { toolName: 'send_token', args: { dryRun: false } },
      broadcastReached: false,
      previewRequested: false,
    },
  },
  {
    name: 'recipient outside the live allowlist is rejected as policy_rejected',
    env: LIVE_POLICY_ENV,
    turns: [
      {
        userText: `Send 0.01 USDT to ${OTHER_ADDRESS}`,
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'non-allowlisted',
              toolName: 'send_token',
              input: sendTokenArgs(OTHER_ADDRESS, '0.01', true),
            },
          ]),
          modelStep([
            { type: 'text', text: 'That recipient is not allowed for live transfers.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'error',
      code: 'policy_rejected',
      toolNames: ['send_token'],
      broadcastReached: false,
      previewRequested: false,
    },
  },
  {
    name: 'amount above the live cap is rejected as policy_rejected',
    env: LIVE_POLICY_ENV,
    turns: [
      {
        userText: `Send 10 USDT to ${ALLOWED_ADDRESS}`,
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'over-cap',
              toolName: 'send_token',
              input: sendTokenArgs(ALLOWED_ADDRESS, '10', true),
            },
          ]),
          modelStep([
            { type: 'text', text: 'That amount exceeds the transfer cap.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'error',
      code: 'policy_rejected',
      toolNames: ['send_token'],
      broadcastReached: false,
      previewRequested: false,
    },
  },
  {
    name: 'recipient revalidation failure is returned as recipient_revalidation_required',
    preload: { selectedRecipient: { recipientId: MAMA_ID, version: 1 } },
    turns: [
      {
        userText: 'Send 10 USDT',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'stale-recipient',
              toolName: 'send_token',
              input: sendTokenArgs(MAMA_ADDRESS, '10', true),
            },
          ]),
          modelStep([
            { type: 'text', text: 'I need to re-resolve the recipient.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'error',
      code: 'recipient_revalidation_required',
      toolNames: ['send_token'],
      broadcastReached: false,
      previewRequested: false,
    },
  },
];
