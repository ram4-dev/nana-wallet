import { describe, expect, it } from 'vitest';
import { lastCompletedUserTurn } from '../../src/livekit/wallet-conversation-llm.js';
import { createRevisionPublisher } from '../../src/livekit/revision-publisher.js';

describe('LiveKit stream boundaries', () => {
  it('extracts only the latest completed user text', () => {
    expect(lastCompletedUserTurn([
      { role: 'assistant', content: 'welcome' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).toBe('hello');
  });

  it('publishes only lightweight revision events', async () => {
    const events: unknown[] = [];
    const publish = createRevisionPublisher(async (event) => { events.push(event); });
    await publish({ type: 'conversation_state_changed', conversationId: 'c1', revision: 4 });
    expect(events).toEqual([{ type: 'conversation_state_changed', conversationId: 'c1', revision: 4 }]);
  });
});
