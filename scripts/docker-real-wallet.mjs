#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Uso: node scripts/docker-real-wallet.mjs --provider wdk [--env-file RUTA] [--vault] [--check]

Arranca DB, LiveKit, API, worker y frontend. WDK también usa su daemon.
--check valida sin crear contenedores. --vault inyecta claves mediante vault-env.
WDK requiere NANA_WDK_VOLUME (volumen existente) y WDK_WALLET_NAME/WDK_TOKEN.
Requiere WDK_MAX_TRANSFER_AMOUNT y WDK_ALLOWED_RECIPIENTS.
No crea wallets, no las desbloquea ni ejecuta transferencias.
Variables opcionales: NANA_DOCKER_PROJECT (nana-real), NANA_HOSTNAME (nana),
NANA_DB_VOLUME (volumen existente), NANA_LIVEKIT_MEDIA_START (7881).
`;

export function validateEnvironment(provider, supplied, repo = root) {
  if (provider !== 'wdk') throw new Error('Elegí --provider wdk. Fixture no está admitido.');
  const env = { ...supplied };
  env.OPENAI_API_KEY ||= env.OPEN_AI_API_KEY;
  const required = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVE_VOICE_BINDING_PRIVATE_KEY', 'LIVE_VOICE_BINDING_PUBLIC_KEY', 'OPENAI_API_KEY', 'OPENCODE_GO_API_KEY', 'WDK_MAX_TRANSFER_AMOUNT', 'WDK_ALLOWED_RECIPIENTS'];
  required.push('NANA_WDK_VOLUME', 'WDK_WALLET_NAME', 'WDK_TOKEN');
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Faltan variables: ${missing.join(', ')}`);
  if (!/^\d+(?:\.\d+)?$/.test(env.WDK_MAX_TRANSFER_AMOUNT) || !/[1-9]/.test(env.WDK_MAX_TRANSFER_AMOUNT)) throw new Error('WDK_MAX_TRANSFER_AMOUNT debe ser un decimal positivo.');
  const recipients = env.WDK_ALLOWED_RECIPIENTS.split(',').map(s => s.trim());
  if (recipients.some(s => !/^0x[0-9a-fA-F]{40}$/.test(s) || /^0x0{40}$/i.test(s) || /^0x0{36}dead$/i.test(s))) throw new Error('WDK_ALLOWED_RECIPIENTS contiene una dirección inválida o de quema.');
  try {
    const privateKey = createPrivateKey(env.LIVE_VOICE_BINDING_PRIVATE_KEY.replace(/\\n/g, '\n'));
    const publicKey = createPublicKey(env.LIVE_VOICE_BINDING_PUBLIC_KEY.replace(/\\n/g, '\n'));
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
  } catch { throw new Error('LIVE_VOICE_BINDING_PRIVATE_KEY y LIVE_VOICE_BINDING_PUBLIC_KEY deben formar un par Ed25519 válido.'); }
  env.WDK_TOOLS_SOURCE = 'live';
  env.WDK_NETWORK = 'sepolia';
  env.WDK_WALLET_NAME ||= 'agent-demo';
  env.DEMO_USER_ID ||= '00000000-0000-4000-8000-000000000001';
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(env.DEMO_USER_ID)) throw new Error('DEMO_USER_ID debe ser un UUID.');
  env.NANA_DOCKER_PROJECT ||= 'nana-real';
  env.NANA_HOSTNAME ||= 'nana';
  for (const name of ['NANA_DOCKER_PROJECT', 'NANA_HOSTNAME']) if (!/^[a-z][a-z0-9-]*$/.test(env[name])) throw new Error(`${name} debe usar letras minúsculas, números o guiones.`);
  const media = Number(env.NANA_LIVEKIT_MEDIA_START ?? 7881);
  if (!Number.isInteger(media) || media < 1024 || media > 65525) throw new Error('NANA_LIVEKIT_MEDIA_START debe estar entre 1024 y 65525.');
  env.NANA_LIVEKIT_MEDIA_START = String(media);
  return env;
}

export function composeConfig(provider, env) {
  const ref = name => '${' + name + '}';
  const origin = `https://${env.NANA_HOSTNAME}.localhost`;
  const environment = {
    HOST: '0.0.0.0', PORT: '3000', WDK_TOOLS_SOURCE: env.WDK_TOOLS_SOURCE,
    WDK_NETWORK: env.WDK_NETWORK, WDK_TOKEN: env.WDK_TOKEN, WDK_WALLET_NAME: env.WDK_WALLET_NAME,
    WDK_MAX_TRANSFER_AMOUNT: ref('WDK_MAX_TRANSFER_AMOUNT'), WDK_ALLOWED_RECIPIENTS: ref('WDK_ALLOWED_RECIPIENTS'),
    DATABASE_URL: 'postgresql://postgres@db:5432/wdk_agent?options=-csearch_path%3Dpublic,extensions',
    DEMO_USER_ID: env.DEMO_USER_ID, RECIPIENT_MEMORY_ENABLED: 'true',
    LIVE_VOICE_ENABLED: 'true', LIVEKIT_URL: 'ws://livekit:7880', LIVEKIT_BROWSER_URL: `${origin.replace('https:', 'wss:')}/livekit`,
    LIVEKIT_AGENT_RUNTIME: 'native-livekit', AGENT_RUNTIME: 'llm',
    LIVEKIT_RECORDING_ENABLED: 'false', AGENT_OBSERVABILITY_RECORDING: 'false',
    XDG_CONFIG_HOME: '/wdk-config', CORS_ORIGINS: origin,
    // wallet-profile (WP-003..WP-009): the personal balance endpoint reads the Arc
    // testnet USDC ERC-20. Without this the reader keeps its `fixture` default with
    // an empty map, so every `ready` wallet fails closed with 503
    // BALANCE_NO_DISPONIBLE. Same endpoint the code pins as PRIVY_ARC_RPC_URL.
    BALANCE_READ_SOURCE: 'rpc', BALANCE_RPC_URL: 'https://rpc.testnet.arc.io',
  };
  for (const name of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVE_VOICE_BINDING_PUBLIC_KEY', 'OPENAI_API_KEY', 'OPENCODE_GO_API_KEY', 'WDK_INDEXER_API_KEY']) environment[name] = ref(name);
  const build = { context: root, dockerfile: 'Dockerfile' };
  const base = { build, environment, ...(provider === 'wdk' ? { volumes: ['wallet:/wdk-config'] } : {}), depends_on: { db: { condition: 'service_healthy' }, livekit: { condition: 'service_healthy' } } };
  const config = {
    services: {
      db: { image: 'pgvector/pgvector:0.8.1-pg16', environment: { POSTGRES_DB: 'wdk_agent', POSTGRES_USER: 'postgres', POSTGRES_HOST_AUTH_METHOD: 'trust' }, volumes: ['database:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres -d wdk_agent'], interval: '2s', timeout: '5s', retries: 30 } },
      livekit: { image: 'livekit/livekit-server:v1.13.6', command: ['--config', '/etc/livekit.yaml'], environment: { LIVEKIT_KEYS: '${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}' }, volumes: ['${NANA_LIVEKIT_CONFIG}:/etc/livekit.yaml:ro'], ports: [`127.0.0.1:${env.NANA_LIVEKIT_MEDIA_START}-${Number(env.NANA_LIVEKIT_MEDIA_START) + 10}:${env.NANA_LIVEKIT_MEDIA_START}-${Number(env.NANA_LIVEKIT_MEDIA_START) + 10}/udp`, `127.0.0.1:${env.NANA_LIVEKIT_MEDIA_START}:${env.NANA_LIVEKIT_MEDIA_START}/tcp`], healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:7880/'], interval: '2s', timeout: '5s', retries: 30 } },
      backend: { ...base, environment: { ...environment, LIVE_VOICE_BINDING_PRIVATE_KEY: ref('LIVE_VOICE_BINDING_PRIVATE_KEY') }, command: ['api'], healthcheck: { test: ['CMD', 'node', '-e', 'fetch("http://127.0.0.1:3000/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'], interval: '3s', timeout: '20s', retries: 20 } },
      'voice-worker': { ...base, command: ['worker'] },
      frontend: { build: { context: resolve(root, 'apps/nana-wallet'), dockerfile: 'docker/Dockerfile', args: { PARTICIPANT_IDENTITY: env.DEMO_USER_ID } }, ports: ['127.0.0.1::80'], depends_on: { backend: { condition: 'service_healthy' } }, healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1/'], interval: '3s', timeout: '5s', retries: 20 } },
    },
    volumes: { database: env.NANA_DB_VOLUME ? { external: true, name: env.NANA_DB_VOLUME } : {} },
  };
  if (provider === 'wdk') {
    config.volumes.wallet = { external: true, name: env.NANA_WDK_VOLUME };
    config.services['wdk-daemon'] = { extends: { file: resolve(root, 'compose.yaml'), service: 'wdk-daemon' }, profiles: [], volumes: ['wallet:/wdk-config'] };
    // Override the original named mount without changing the existing Compose file.
    config.volumes.wdk_config = { external: true, name: env.NANA_WDK_VOLUME };
  }
  return config;
}

export function migrationSql(repo = root) {
  const directory = resolve(repo, 'supabase/migrations');
  const files = readdirSync(directory).filter(f => /^\d+_[a-z0-9_-]+\.sql$/i.test(f)).sort();
  let sql = `\\set ON_ERROR_STOP on\nBEGIN;\nSELECT pg_advisory_xact_lock(714201908);\nDO $$ BEGIN IF to_regclass('public.nana_start_migrations') IS NULL AND (to_regclass('public.recipients') IS NOT NULL OR to_regclass('public.conversations') IS NOT NULL) THEN RAISE EXCEPTION 'Base existente sin ledger nana_start_migrations: verificar baseline antes de adoptar; no se modificaron datos'; END IF; END $$;\nCREATE SCHEMA IF NOT EXISTS extensions;\n${readFileSync(resolve(repo, 'supabase/roles.sql'), 'utf8')}\nCREATE TABLE IF NOT EXISTS public.nana_start_migrations(name text primary key, checksum text NOT NULL);\n`;
  for (const name of files) {
    const content = readFileSync(resolve(directory, name), 'utf8');
    const checksum = createHash('sha256').update(content).digest('hex');
    sql += `DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.nana_start_migrations WHERE name='${name}' AND checksum <> '${checksum}') THEN RAISE EXCEPTION 'Cambió la migración ${name}'; END IF; END $$;\nSELECT EXISTS(SELECT 1 FROM public.nana_start_migrations WHERE name='${name}') AS applied \\gset\n\\if :applied\n\\else\n${content}\nINSERT INTO public.nana_start_migrations VALUES ('${name}','${checksum}');\n\\endif\n`;
  }
  return sql + 'COMMIT;\n';
}

function run(command, args, env, input, quiet = false) {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: 'utf8', stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    // Child errors may contain SDK configuration, PEMs or expanded Compose env.
    throw new Error(`${command} ${args[0] ?? ''} falló (código ${result.status ?? 'no disponible'}). No se muestran mensajes que puedan contener secretos.`);
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout?.trim() ?? '';
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { provider: { type: 'string' }, 'env-file': { type: 'string' }, vault: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  let env = { ...process.env };
  if (values['env-file']) env = { ...parseEnv(readFileSync(resolve(values['env-file']), 'utf8')), ...env };
  if (values.vault) {
    const available = run('vault-env', ['list'], env, undefined, true).split(/\s+/);
    const wanted = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVE_VOICE_BINDING_PRIVATE_KEY', 'LIVE_VOICE_BINDING_PUBLIC_KEY', 'OPENAI_API_KEY', 'OPEN_AI_API_KEY', 'OPENCODE_GO_API_KEY', 'WDK_INDEXER_API_KEY'];
    const names = wanted.filter(name => available.includes(name) && !env[name]);
    if (names.length) {
      const result = spawnSync('vault-env', ['run', '--names', names.join(','), '--', process.execPath, fileURLToPath(import.meta.url), ...args.filter(a => a !== '--vault')], { cwd: root, env, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error(`Arranque mediante vault-env incompleto (código ${result.status ?? 'no disponible'}).`);
      return;
    }
  }
  env = validateEnvironment(values.provider, env);
  run('docker', ['info', '--format', '{{.ServerVersion}}'], env, undefined, true);
  run('docker', ['compose', 'version'], env, undefined, true);
  run('portless', ['--version'], env, undefined, true);
  for (const name of ['NANA_WDK_VOLUME', 'NANA_DB_VOLUME']) if (env[name]) run('docker', ['volume', 'inspect', env[name], '--format', '{{.Name}}'], env, undefined, true);
  console.log(`Preflight válido: ${values.provider}, ${env.WDK_NETWORK}, ${env.WDK_TOKEN}.`);
  if (values.check) return;
  // A retained, non-secret config is needed for Compose restarts and bind mounts.
  const state = resolve(root, '.cache/docker-real-wallet', env.NANA_DOCKER_PROJECT);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(state, { recursive: true });
  env.NANA_LIVEKIT_CONFIG = resolve(state, 'livekit.yaml');
  const media = env.NANA_LIVEKIT_MEDIA_START;
  writeFileSync(env.NANA_LIVEKIT_CONFIG, `port: 7880\nrtc:\n  udp_port: "${media}-${Number(media) + 10}"\n  tcp_port: ${media}\n  use_external_ip: false\n  node_ip: "127.0.0.1"\n  advertise_internal_ip: true\n`, { mode: 0o600 });
  const temp = mkdtempSync(resolve(tmpdir(), 'nana-compose-'));
  const path = resolve(temp, 'compose.json');
  writeFileSync(path, JSON.stringify(composeConfig(values.provider, env)), { mode: 0o600 });
  const prefix = ['compose', '--project-directory', root, '--env-file', '/dev/null', '-p', env.NANA_DOCKER_PROJECT, '-f', path, ...(values.provider === 'wdk' ? ['--profile', 'daemon'] : [])];
  const compose = (args, input, quiet = true) => run('docker', [...prefix, ...args], env, input, quiet);
  try {
    compose(['config', '--quiet']);
    console.log('Construyendo imágenes Docker; puede tardar varios minutos…');
    compose(['build']);
    console.log('Iniciando Postgres y aplicando migraciones pendientes…');
    compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db']);
    compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'wdk_agent'], migrationSql());
    console.log('Iniciando LiveKit, API, worker y frontend…');
    compose(['up', '-d', '--wait', '--wait-timeout', '180']);
    const healthProbe = `const r=await fetch('http://127.0.0.1:3000/health');const h=await r.json();if(!r.ok||h.mode!=='live'||h.wallet!=='unlocked'||h.network!==process.env.WDK_NETWORK||(h.provider&&h.provider.status!=='healthy'))process.exit(1);const b=await fetch('http://127.0.0.1:3000/v1/wallet/balance?token='+encodeURIComponent(process.env.WDK_TOKEN));if(!b.ok)process.exit(1);const v=await b.json();if(v.network!==process.env.WDK_NETWORK||v.token!==process.env.WDK_TOKEN)process.exit(1);console.log('Wallet real accesible; lectura de saldo verificada.');`;
    compose(['exec', '-T', 'backend', 'node', '--input-type=module', '-e', healthProbe], undefined, false);
    const worker = JSON.parse('[' + compose(['ps', '--format', 'json', 'voice-worker']).split('\n').filter(Boolean).join(',') + ']');
    if (!worker.length || worker.some(row => row.State !== 'running')) throw new Error('El worker no está corriendo.');
    run('portless', ['proxy', 'start'], env, undefined, true);
    const endpoint = compose(['port', 'frontend', '80']);
    const port = endpoint.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error('Docker no publicó el frontend.');
    run('portless', ['alias', env.NANA_HOSTNAME, port], env, undefined, true);
    console.log(`Stack iniciado: https://${env.NANA_HOSTNAME}.localhost\nProyecto Docker: ${env.NANA_DOCKER_PROJECT}\nWorker en ejecución; la conversación de voz en navegador requiere validación aparte.`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Arranque incompleto.'); process.exitCode = 1; });
}
