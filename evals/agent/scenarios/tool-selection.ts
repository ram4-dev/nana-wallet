import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import { balanceArgs, sendTokenArgs, TARGET_ADDRESS, CONFIG } from './constants.js';

/**
 * Tool selection and parameter correctness: the model must pick the right WDK
 * tool and pass the configured network/token (and dry-run flag) without
 * inventing an address or a broadcast.
 */
export const toolSelectionScenarios: AgentScenario[] = [
  {
    name: 'balance question selects get_balance with configured token/network',
    turns: [
      {
        userText: 'How much USDT do I have?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-balance',
              toolName: 'get_balance',
              input: balanceArgs(),
            },
          ]),
          modelStep([{ type: 'text', text: 'You have 42.5 USDT.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_balance'],
      toolCall: {
        toolName: 'get_balance',
        args: {
          network: CONFIG.network,
          token: CONFIG.token,
          wallet: CONFIG.wallet,
        },
      },
      broadcastReached: false,
      previewRequested: false,
    },
  },
  {
    name: 'complete transfer request selects send_token dry-run preview with resolved recipient',
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
    ],
    expected: {
      status: 'confirmation_required',
      toolNames: ['send_token'],
      toolCall: {
        toolName: 'send_token',
        args: {
          network: CONFIG.network,
          token: CONFIG.token,
          to: TARGET_ADDRESS,
          amount: '10',
          wallet: CONFIG.wallet,
          dryRun: true,
        },
      },
      previewRequested: true,
      broadcastReached: false,
      pendingTransfer: true,
    },
  },
];
