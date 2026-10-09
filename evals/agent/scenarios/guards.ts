import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import {
  MAMA_ADDRESS,
  MAMA_ID,
  OTHER_ADDRESS,
  sendTokenArgs,
} from './constants.js';

/**
 * Guard behaviors: the agent must fail closed before a broadcast — ask for
 * missing data, refuse an unconfirmed broadcast, and revalidate a session-bound
 * recipient.
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
