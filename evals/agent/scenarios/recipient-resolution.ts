import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import {
  LUCAS_A_ID,
  LUCAS_B_ID,
  MAMA_ADDRESS,
  MAMA_ID,
  USER_ID,
  sendTokenArgs,
} from './constants.js';

const MAMA_CANDIDATE = {
  id: MAMA_ID,
  name: 'Mamá',
  normalizedName: 'mamá',
  description: 'mi madre',
  version: 1,
  status: 'active' as const,
  embeddingModelRevision: 'agent-eval',
  evidence: 'mi madre',
  score: 0.98,
};

const LUCAS_A = {
  id: LUCAS_A_ID,
  name: 'Lucas',
  normalizedName: 'lucas',
  description: 'mi nieto',
  version: 1,
  status: 'active' as const,
  embeddingModelRevision: 'agent-eval',
  evidence: 'mi nieto',
  score: 0.9,
};

const LUCAS_B = {
  id: LUCAS_B_ID,
  name: 'Lucas',
  normalizedName: 'lucas',
  description: 'el electricista',
  version: 1,
  status: 'active' as const,
  embeddingModelRevision: 'agent-eval',
  evidence: 'el electricista',
  score: 0.89,
};

/**
 * Recipient resolution: a named recipient resolves from the memory stub and
 * reaches a preview without leaking the address into the model prompt, while an
 * ambiguous name stops to ask for clarification instead of guessing.
 */
export const recipientResolutionScenarios: AgentScenario[] = [
  {
    name: 'mamá resolves from recipient memory and reaches a preview',
    recipientMemory: {
      userId: USER_ID,
      searchRecipients: async (_userId: string, query: string) => {
        if (query.toLocaleLowerCase('en-US') === 'mamá') {
          return { status: 'resolved', candidates: [MAMA_CANDIDATE], recipient: MAMA_CANDIDATE };
        }
        return { status: 'no_match', candidates: [] };
      },
      searchUserMemory: async () => ({ status: 'ok', facts: [] }),
      getRecipientForVersion: async (_userId: string, recipientId: string) => {
        if (recipientId === MAMA_ID) {
          return { id: MAMA_ID, version: 1, address: MAMA_ADDRESS };
        }
        return undefined;
      },
    },
    turns: [
      {
        userText: 'Send money to mamá',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'selected-address',
              toolName: 'get_selected_recipient_address',
              input: '{}',
            },
          ]),
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'preview-transfer',
              toolName: 'send_token',
              input: sendTokenArgs(MAMA_ADDRESS, '10', true),
            },
          ]),
          modelStep([
            { type: 'text', text: 'Prepared a 10 USDT transfer to mamá. Confirm to continue.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'confirmation_required',
      toolNames: ['get_selected_recipient_address', 'send_token'],
      toolCall: {
        toolName: 'send_token',
        args: { to: MAMA_ADDRESS, amount: '10', dryRun: true },
      },
      recipientSelected: { recipientId: MAMA_ID, version: 1 },
      previewRequested: true,
      broadcastReached: false,
      pendingTransfer: true,
    },
  },
  {
    name: 'ambiguous recipient name asks for clarification instead of guessing',
    recipientMemory: {
      userId: USER_ID,
      searchRecipients: async (_userId: string, query: string) => {
        if (query.toLocaleLowerCase('en-US') === 'lucas') {
          return { status: 'clarification_required', candidates: [LUCAS_A, LUCAS_B] };
        }
        return { status: 'no_match', candidates: [] };
      },
      searchUserMemory: async () => ({ status: 'ok', facts: [] }),
    },
    turns: [{ userText: 'Mandale plata a Lucas' }],
    expected: {
      status: 'clarification_required',
      clarificationAsked: true,
      broadcastReached: false,
      previewRequested: false,
      pendingTransfer: false,
    },
  },
];
