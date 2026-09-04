import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import { sendTokenArgs, TARGET_ADDRESS } from './constants.js';

/**
 * Preview → confirm flow: a correct dry-run preview stages a pending transfer,
 * and the explicit confirm turn broadcasts in fixture mode and reflects the
 * sent state (and clears the pending intent).
 */
export const previewConfirmScenarios: AgentScenario[] = [
  {
    name: 'correct preview then explicit confirm reaches a fixture broadcast',
    turns: [
      {
        userText: `Send 10 USDT to ${TARGET_ADDRESS}`,
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'preview-transfer',
              toolName: 'send_token',
              input: sendTokenArgs(TARGET_ADDRESS, '10', true),
            },
          ]),
          modelStep([
            { type: 'text', text: 'Prepared a 10 USDT transfer. Confirm to continue.' },
          ]),
        ],
      },
      { userText: 'confirm' },
    ],
    expected: {
      status: 'sent',
      toolNames: ['send_token'],
      toolCall: {
        toolName: 'send_token',
        args: {
          to: TARGET_ADDRESS,
          amount: '10',
          dryRun: true,
        },
      },
      previewRequested: true,
      broadcastReached: true,
      pendingTransfer: false,
    },
  },
];
