// S0 — Gate: does the Privy policy actually constrain the app signer?
//
// Signs ONLY. Never broadcasts. Nothing moves.
// Requires: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_PRIVATE_KEY.
//
// Reads the key from PRIVY_AUTHORIZATION_PRIVATE_KEY_FILE when set, so the value
// never appears in the process arguments.

import { readFileSync } from 'node:fs';
import { PrivyClient } from '@privy-io/node';

const APP = process.env.PRIVY_APP_ID;
const SECRET = process.env.PRIVY_APP_SECRET;
const KEY = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY_FILE
  ? readFileSync(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY_FILE, 'utf8').trim()
  : process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;

const WALLET = process.env.PRIVY_EVM_WALLET_ID ?? 'hb000bxgo0kkdkg5fp6se9g9';
const USDC = '0x3600000000000000000000000000000000000000';
const CHAIN = 5042002;
const ALLOWLISTED = '0x1531F7AA08D5dF6E9e7d1e0dF8C88656BF9EBd5C';
const NOT_ALLOWLISTED = '0x000000000000000000000000000000000000dEaD';

if (!APP || !SECRET || !KEY) {
  console.log('BLOCKED: missing PRIVY_APP_ID / PRIVY_APP_SECRET / app key');
  process.exit(1);
}

const privy = new PrivyClient({ appId: APP, appSecret: SECRET });
const ctx = { authorization_private_keys: [KEY] };

function transferData(to, amountAtomic) {
  return (
    '0xa9059cbb' +
    to.slice(2).toLowerCase().padStart(64, '0') +
    BigInt(amountAtomic).toString(16).padStart(64, '0')
  );
}

async function attempt(label, amountAtomic, to) {
  const data = transferData(to, amountAtomic);
  try {
    const res = await privy.wallets().ethereum().signTransaction(WALLET, {
      params: {
        transaction: {
          chain_id: CHAIN,
          to: USDC,
          value: '0x0',
          data,
          type: 2,
          nonce: '0x0',
          gas_limit: '0x20000',
          max_fee_per_gas: '0x3b9aca00',
          max_priority_fee_per_gas: '0x3b9aca00',
        },
      },
      authorization_context: ctx,
    });
    // The SDK returns the signed payload under a method-specific field; read it
    // generically so the probe does not depend on one shape.
    const signed =
      res && typeof res === 'object'
        ? Object.entries(res).find(([k]) => /signed/i.test(k))?.[1]
        : null;
    console.log(`${label}: SIGNED${signed ? ' (signed payload returned)' : ''}`);
    return { label, outcome: 'signed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${label}: BLOCKED -> ${message.slice(0, 200)}`);
    return { label, outcome: 'blocked', message };
  }
}

console.log(`wallet: ${WALLET}  chain: ${CHAIN}  usdc: ${USDC}`);
console.log('--- 3 cases, sign only, no broadcast ---');
const results = [];
results.push(await attempt('A) 1.00 USDC -> allowlisted      ', 1_000_000n, ALLOWLISTED));
results.push(await attempt('B) 1.00 USDC -> NOT allowlisted  ', 1_000_000n, NOT_ALLOWLISTED));
results.push(await attempt('C) 20.00 USDC -> allowlisted (over cap)', 20_000_000n, ALLOWLISTED));

console.log('--- verdict ---');
const a = results[0].outcome === 'signed';
const b = results[1].outcome === 'blocked';
const c = results[2].outcome === 'blocked';
console.log(`A allowed (expected signed): ${a}`);
console.log(`B recipient NOT in allowlist rejected (expected blocked): ${b}`);
console.log(`C over per-transfer cap rejected (expected blocked): ${c}`);
console.log(
  a && b && c
    ? 'POLICY ENFORCES: the signer is constrained.'
    : 'POLICY DOES NOT FULLY ENFORCE: do not enable signing before fixing the policy.',
);
