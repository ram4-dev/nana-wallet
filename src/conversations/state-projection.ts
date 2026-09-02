import type { ConversationSnapshot } from './types.js';

export type ConversationActivity = 'idle' | 'working' | 'awaiting_confirmation' | 'verifying' | 'uncertain';

export function conversationActivity(snapshot: Pick<ConversationSnapshot, 'pendingTransfer' | 'transferResolutionState'>): ConversationActivity {
  if (snapshot.transferResolutionState === 'uncertain') return 'uncertain';
  if (snapshot.transferResolutionState === 'broadcasting') return 'verifying';
  if (snapshot.pendingTransfer) return 'awaiting_confirmation';
  return 'idle';
}
