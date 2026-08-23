import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, getSession, resetSessionStore } from '../../src/sessions/in-memory-store.js';

const enabled = process.env.WDK_AGENT_E2E === '1' && process.env.WDK_AGENT_PREVIEW_APPROVED === '1';
const recipient = '0xbAf7534493606883085669DB520ED7374dF0c940';

describe('real wallet agent preview', () => {
  beforeEach(() => resetSessionStore());
  afterEach(() => resetSessionStore());

  it.skipIf(!enabled)('uses the configured production model and bundled WDK MCP to create a preview only', async () => {
    const session = createSession();
    const result = await handleMessage(
      session.id,
      `Preview exactly 1 usdt-test on sepolia to ${recipient}. Do not send it.`,
    );

    expect(result).toMatchObject({
      status: 'confirmation_required',
      preview: {
        network: 'sepolia',
        token: 'usdt-test',
        recipient,
        amount: '1',
      },
    });
    expect(getSession(session.id)?.pendingTransfer).toMatchObject({
      network: 'sepolia', token: 'usdt-test', to: recipient, amount: '1', wallet: 'agent-dev',
    });
  });
});
