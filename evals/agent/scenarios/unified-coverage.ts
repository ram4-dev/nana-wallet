import type { AgentScenario } from './types.js';
import { modelStep } from './types.js';
import { balanceArgs, CONFIG, MAMA_ID } from './constants.js';

/**
 * Unified-surface coverage (spec: unified-agent-tools, D6): scenarios for the
 * read tools previously without any eval coverage, plus multi-network balance
 * reads (Solana devnet, default Arc, unsupported network). These run offline in
 * CI with a mock model, so they pin tool selection and parameter correctness —
 * not provider behavior.
 */
export const unifiedCoverageScenarios: AgentScenario[] = [
  {
    name: 'networks question selects get_networks',
    turns: [
      {
        userText: '¿En qué redes puedo operar?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-networks',
              toolName: 'get_networks',
              input: '{}',
            },
          ]),
          modelStep([{ type: 'text', text: 'Operás en Arc testnet y Solana devnet.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_networks'],
      toolCall: { toolName: 'get_networks', args: {} },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'token question selects list_tokens with the requested network',
    turns: [
      {
        userText: '¿Qué monedas hay disponibles en solana-devnet?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-tokens',
              toolName: 'list_tokens',
              input: JSON.stringify({ network: 'solana-devnet' }),
            },
          ]),
          modelStep([{ type: 'text', text: 'En Solana devnet hay SOL.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['list_tokens'],
      toolCall: { toolName: 'list_tokens', args: { network: 'solana-devnet' } },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'address question selects get_address for the configured wallet',
    turns: [
      {
        userText: '¿Cuál es la dirección de mi billetera en arc-testnet?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-address',
              toolName: 'get_address',
              input: JSON.stringify({ network: CONFIG.network }),
            },
          ]),
          modelStep([{ type: 'text', text: 'Tu dirección en Arc es 0x…' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_address'],
      toolCall: { toolName: 'get_address', args: { network: CONFIG.network } },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'history question selects get_history without broadcasting',
    turns: [
      {
        userText: 'Mostrame el historial de transferencias',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-history',
              toolName: 'get_history',
              input: balanceArgs(),
            },
          ]),
          modelStep([{ type: 'text', text: 'Acá va tu historial reciente.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_history'],
      toolCall: {
        toolName: 'get_history',
        args: {
          network: CONFIG.network,
          token: CONFIG.token,
          wallet: CONFIG.wallet,
        },
      },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'relationship question selects search_user_memory, never a broadcast',
    turns: [
      {
        userText: '¿Quién es Lucas para mí?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-memory',
              toolName: 'search_user_memory',
              input: JSON.stringify({ query: 'Lucas' }),
            },
          ]),
          modelStep([{ type: 'text', text: 'Lucas es tu amigo del equipo.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['search_user_memory'],
      toolCall: { toolName: 'search_user_memory', args: { query: 'Lucas' } },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'save-recipient request stages memory and never broadcasts',
    turns: [
      {
        userText: 'Guardá a Ana con la dirección 0x1111111111111111111111111111111111111111',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'stage-memory',
              toolName: 'stage_user_memory',
              input: JSON.stringify({
                kind: 'recipient',
                name: 'Ana',
                description: 'amiga',
                address: '0x1111111111111111111111111111111111111111',
              }),
            },
          ]),
          modelStep([{ type: 'text', text: '¿Confirmás guardar a Ana?' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['stage_user_memory'],
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'memory write happens only with a confirmation id',
    turns: [
      {
        userText: 'sí, guardala',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'write-memory',
              toolName: 'write_user_memory',
              input: JSON.stringify({ confirmationId: MAMA_ID }),
            },
          ]),
          modelStep([{ type: 'text', text: 'Listo, guardé el contacto.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['write_user_memory'],
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'balance question naming Solana passes network solana-devnet',
    turns: [
      {
        userText: '¿Cuánto tengo en solana?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-balance-solana',
              toolName: 'get_balance',
              input: JSON.stringify({ network: 'solana-devnet' }),
            },
          ]),
          modelStep([{ type: 'text', text: 'Tenés 0 SOL.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_balance'],
      toolCall: { toolName: 'get_balance', args: { network: 'solana-devnet' } },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'balance question without a network defaults to Arc',
    turns: [
      {
        userText: '¿Cuánto tengo?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-balance-default',
              toolName: 'get_balance',
              input: JSON.stringify({ network: CONFIG.network, token: CONFIG.token }),
            },
          ]),
          modelStep([{ type: 'text', text: 'Tenés 9.99 USDC.' }]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_balance'],
      toolCall: {
        toolName: 'get_balance',
        args: { network: CONFIG.network, token: CONFIG.token },
      },
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
  {
    name: 'balance on an unsupported network is refused, never broadcast',
    turns: [
      {
        userText: '¿Cuánto tengo en mainnet?',
        modelSteps: [
          modelStep([
            {
              type: 'tool-call',
              toolCallId: 'read-balance-bad-network',
              toolName: 'get_balance',
              input: JSON.stringify({ network: 'ethereum-mainnet' }),
            },
          ]),
          modelStep([
            { type: 'text', text: 'No puedo consultar esa red. Operás en Arc testnet y Solana devnet.' },
          ]),
        ],
      },
    ],
    expected: {
      status: 'answer',
      toolNames: ['get_balance'],
      broadcastReached: false,
      pendingTransfer: false,
    },
  },
];
