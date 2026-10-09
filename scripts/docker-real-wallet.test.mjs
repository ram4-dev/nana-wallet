import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEnvironment, composeConfig, migrationSql } from './docker-real-wallet.mjs';

function configured() {
  const keys = generateKeyPairSync('ed25519');
  return {
    LIVEKIT_API_KEY: 'synthetic-key', LIVEKIT_API_SECRET: 'synthetic-secret',
    LIVE_VOICE_BINDING_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    LIVE_VOICE_BINDING_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    OPEN_AI_API_KEY: 'synthetic-openai', OPENCODE_GO_API_KEY: 'synthetic-llm',
    NANA_WDK_VOLUME: 'existing-wallet', WDK_WALLET_NAME: 'agent-dev', WDK_TOKEN: 'usdt-test',
  };
}

test('rechaza fixture y proveedor omitido', () => {
  for (const provider of ['fixture', undefined]) assert.throws(() => validateEnvironment(provider, {}), /Elegí --provider/);
});
test('reporta nombres faltantes sin valores', () => {
  const input = configured(); delete input.LIVEKIT_API_SECRET;
  assert.throws(() => validateEnvironment('wdk', input), error => error.message.includes('LIVEKIT_API_SECRET') && !error.message.includes('synthetic-key'));
});
test('no arranca con un par de binding diferente', () => {
  assert.throws(() => validateEnvironment('wdk', { ...configured(), LIVE_VOICE_BINDING_PUBLIC_KEY: configured().LIVE_VOICE_BINDING_PUBLIC_KEY }), /par Ed25519/);
});
test('WDK adapta OpenAI y mantiene el token custom', () => {
  const env = validateEnvironment('wdk', { ...configured(), WDK_NETWORK: 'mainnet' });
  assert.equal(env.WDK_NETWORK, 'sepolia');
  assert.equal(env.WDK_TOKEN, 'usdt-test');
  assert.equal(env.OPENAI_API_KEY, 'synthetic-openai');
});
test('Compose mantiene secretos fuera del documento, wallet externa y DB sin puerto público', () => {
  const config = composeConfig('wdk', validateEnvironment('wdk', configured()));
  assert.equal(config.volumes.wallet.external, true);
  assert.equal(config.volumes.wallet.name, 'existing-wallet');
  assert.equal(config.services.db.ports, undefined);
  assert.equal(config.services.frontend.ports[0], '127.0.0.1::80');
  assert.equal(config.services['voice-worker'].environment.LIVE_VOICE_BINDING_PRIVATE_KEY, undefined);
  assert.equal(config.services.backend.environment.LIVE_VOICE_BINDING_PRIVATE_KEY, '${LIVE_VOICE_BINDING_PRIVATE_KEY}');
  assert.ok(!JSON.stringify(config).includes('synthetic-secret'));
});
test('migraciones contienen una transacción y bloquean cambios de checksum y adopción silenciosa', () => {
  const sql = migrationSql();
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /Base existente sin ledger/);
  assert.match(sql, /checksum <> '[a-f0-9]{64}'/);
  assert.match(sql, /\\if :applied/);
  assert.ok(sql.endsWith('COMMIT;\n'));
});

for (const healthFails of [false, true]) test(`CLI orchestration: health failure=${healthFails}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'nana-cli-e2e-'));
  try {
    const log = join(directory, 'calls.jsonl');
    const fake = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.NANA_TEST_LOG, JSON.stringify(a)+'\\n');
if(a.includes('exec') && a.includes('backend') && process.env.NANA_TEST_HEALTH_FAIL === '1') process.exit(1);
if(a.includes('ps')) console.log(JSON.stringify({State:'running'}));
if(a.includes('port') && a.includes('frontend')) console.log('127.0.0.1:32123');
`;
    for (const name of ['docker', 'portless']) writeFileSync(join(directory, name), fake, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./docker-real-wallet.mjs', import.meta.url)), '--provider', 'wdk'], {
      encoding: 'utf8', env: { ...process.env, ...configured(), NANA_DOCKER_PROJECT: 'nana-cli-test', PATH: directory + ':' + process.env.PATH, NANA_TEST_LOG: log, NANA_TEST_HEALTH_FAIL: healthFails ? '1' : '0' },
    });
    assert.equal(result.status, healthFails ? 1 : 0, result.stderr);
    assert.equal(result.stdout.includes('Stack iniciado:'), !healthFails);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const up = calls.filter(a => a.includes('up'));
    assert.equal(up.length, 2);
    assert.ok(up.every(a => a.includes('--profile') && a.includes('daemon')));
    assert.ok(calls.findIndex(a => a.includes('psql')) < calls.findIndex(a => a.includes('up') && !a.includes('db')));
    assert.equal(calls.some(a => a.includes('alias')), !healthFails);
    assert.ok(!result.stdout.includes('synthetic-secret'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
