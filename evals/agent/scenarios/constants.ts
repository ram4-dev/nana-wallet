export const USER_ID = '11111111-1111-4111-8111-111111111111';

export const MAMA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MAMA_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const LUCAS_A_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const LUCAS_B_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const ALLOWED_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
export const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890';
export const TARGET_ADDRESS = '0x1234567890123456789012345678901234567890';

export const CONFIG = {
  network: 'sepolia',
  token: 'USDT',
  wallet: 'agent-demo',
} as const;

export function sendTokenArgs(
  to: string,
  amount: string,
  dryRun: boolean,
): string {
  return JSON.stringify({
    network: CONFIG.network,
    token: CONFIG.token,
    to,
    amount,
    wallet: CONFIG.wallet,
    dryRun,
  });
}

export function balanceArgs(): string {
  return JSON.stringify({
    network: CONFIG.network,
    token: CONFIG.token,
    wallet: CONFIG.wallet,
  });
}
