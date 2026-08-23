export type DeterministicIntent =
  | { type: 'balance' }
  | { type: 'send'; amount: string; token: string; to: string };

const SEND_PATTERN =
  /(?:send|mand(?:á|a|ar)|envi(?:á|a|ar)|transfer(?:í|ir)?)\s+(\d+(?:[.,]\d+)?)\s*([A-Za-z]{2,6})?\s+(?:to|a)\s+(0x[a-zA-Z0-9.]+)/iu;
const BALANCE_PATTERN = /(?:how much|balance|saldo|cu[aá]nto)/iu;

export function parseDeterministicIntent(
  text: string,
  defaultToken: string,
): DeterministicIntent | null {
  const send = SEND_PATTERN.exec(text);
  if (send) {
    return {
      type: 'send',
      amount: send[1].replace(',', '.'),
      token: (send[2] ?? defaultToken).toUpperCase(),
      to: send[3],
    };
  }

  if (BALANCE_PATTERN.test(text)) {
    return { type: 'balance' };
  }

  return null;
}

export function isDeterministicAgentRuntime(): boolean {
  return process.env.AGENT_RUNTIME === 'deterministic';
}
