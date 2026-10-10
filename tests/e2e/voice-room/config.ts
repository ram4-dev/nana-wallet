/**
 * Configuration and explicit credential injection for the voice-room harness.
 *
 * TWO FACTS THAT MAKE THIS MODULE NECESSARY
 * -----------------------------------------
 * 1. `tests/setup/isolate-provider-env.ts` DELETES `LIVEKIT_*`,
 *    `LIVE_VOICE_BINDING_*` and `OPENAI_API_KEY` from `process.env` for every
 *    vitest file. A voice-room test therefore cannot read the ambient
 *    environment; it has to inject the worktree `.env` itself. That is by design,
 *    not a workaround: it means a green run cannot be an accident of the
 *    developer's shell.
 * 2. The worktree `.env` holds `LIVEKIT_URL` pointing at **LiveKit Cloud**, while
 *    this harness talks to the ISOLATED LOCAL stack (`ws://127.0.0.1:7882`). So
 *    the URL is never taken from `.env`; only the key pair is.
 *
 * INJECTION ORDER
 * ---------------
 * `.env` wins over the ambient shell for the injected keys (delete, then load,
 * then fall back to a previously-set ambient value only for keys `.env` does not
 * carry). Without that, a developer with `LIVEKIT_API_KEY` exported for the Cloud
 * project would sign local room tokens with the wrong key and get an opaque
 * handshake failure.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The host-side signaling URL of the isolated e2e stack (compose maps 7882 -> 7880). */
export const DEFAULT_LIVEKIT_HOST_URL = 'ws://127.0.0.1:7882';
/**
 * The isolated e2e Postgres (compose maps 5433 -> 5432).
 *
 * The `search_path` option is NOT decoration and must match compose.yaml and
 * .github/workflows/ci.yml exactly: the application schema-qualifies
 * `extensions.gen_random_uuid()` (postgres-repository.ts:372), and `pgcrypto`
 * lives in the `extensions` schema. Connecting without it makes migrations fail
 * with `type "vector" does not exist` and, later, confirm/cancel fail with
 * `function extensions.gen_random_uuid() does not exist`.
 */
export const DEFAULT_DATABASE_URL =
  'postgresql://postgres@127.0.0.1:5433/wdk_agent?options=-csearch_path%3Dpublic,extensions';
export const DEFAULT_AGENT_NAME = 'nani-agent';
export const DEFAULT_TURN_FIXTURE = 'balance-question.wav';
/** The transfer scenario's request turn: it names the recipient that is actually seeded. */
export const TRANSFER_REQUEST_FIXTURE = 'transfer-to-lucas.wav';
/** A clear spoken affirmative, the way a real person agrees. */
export const TRANSFER_CONFIRM_FIXTURE = 'confirm-transfer.wav';
/** A clear spoken rejection. */
export const TRANSFER_CANCEL_FIXTURE = 'cancel-transfer.wav';

export const ENV_FILE_PATH = resolve(REPO_ROOT, '.env');
export const FIXTURES_DIR = resolve(REPO_ROOT, 'tests/e2e/voice-room/fixtures');
export const ARTIFACTS_DIR = resolve(REPO_ROOT, 'tests/e2e/voice-room/.artifacts');

/** Keys the harness injects from the worktree `.env` (values are never printed). */
export const INJECTED_CREDENTIAL_KEYS = [
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVE_VOICE_BINDING_PRIVATE_KEY',
  'LIVE_VOICE_BINDING_PUBLIC_KEY',
  'OPENAI_API_KEY',
] as const;

export type InjectedCredentialKey = (typeof INJECTED_CREDENTIAL_KEYS)[number];

export type VoiceRoomConfig = {
  /** Host-side signaling URL of the isolated stack, never `.env`'s LIVEKIT_URL. */
  livekitHostUrl: string;
  apiKey: string;
  apiSecret: string;
  bindingPrivateKey: string;
  bindingPublicKey: string;
  /** The worker's OpenAI key is not used by this process, but its absence means the stack cannot answer. */
  openaiApiKey: string;
  databaseUrl: string;
  agentName: string;
};

export type VoiceRoomConfigResolution =
  | { ok: true; config: VoiceRoomConfig }
  | { ok: false; missing: string[] };

export type CredentialInjectionReport = {
  envFilePath: string;
  envFileLoaded: boolean;
  injected: InjectedCredentialKey[];
  /** Injected keys that came from the ambient environment because `.env` lacks them. */
  fromAmbient: InjectedCredentialKey[];
  missing: InjectedCredentialKey[];
  /**
   * Keys that were ALREADY set before injection. Non-empty means the vitest
   * isolation did not strip them (or this is a standalone script run), so the
   * test's own evidence that it injects explicitly is weaker.
   */
  alreadyPresent: InjectedCredentialKey[];
};

/**
 * Loads the worktree `.env` into `process.env` for the keys this harness needs.
 *
 * Operates on the real `process.env` because `process.loadEnvFile` always writes
 * there. It is idempotent and safe to call from both the script and a vitest
 * setup hook.
 */
export function injectWorktreeCredentials(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = ENV_FILE_PATH,
): CredentialInjectionReport {
  const alreadyPresent: InjectedCredentialKey[] = [];
  const ambient = new Map<InjectedCredentialKey, string>();
  for (const key of INJECTED_CREDENTIAL_KEYS) {
    const value = env[key];
    if (value?.trim()) {
      alreadyPresent.push(key);
      ambient.set(key, value);
    }
    delete env[key];
  }

  let envFileLoaded = false;
  try {
    process.loadEnvFile(envFilePath);
    envFileLoaded = true;
  } catch {
    // No `.env` in this checkout (CI) or unreadable: the ambient fallback below
    // and the `missing` list keep the failure explicit either way.
  }

  const injected: InjectedCredentialKey[] = [];
  const fromAmbient: InjectedCredentialKey[] = [];
  const missing: InjectedCredentialKey[] = [];
  for (const key of INJECTED_CREDENTIAL_KEYS) {
    if (env[key]?.trim()) {
      injected.push(key);
      continue;
    }
    const fallback = ambient.get(key);
    if (fallback?.trim()) {
      env[key] = fallback;
      injected.push(key);
      fromAmbient.push(key);
      continue;
    }
    missing.push(key);
  }

  return {
    envFilePath,
    envFileLoaded,
    injected,
    fromAmbient,
    missing,
    alreadyPresent,
  };
}

export function resolveVoiceRoomConfig(
  env: NodeJS.ProcessEnv = process.env,
): VoiceRoomConfigResolution {
  const config: VoiceRoomConfig = {
    // Deliberately NOT env.LIVEKIT_URL: the worktree `.env` points that at LiveKit
    // Cloud. The isolated stack is addressed explicitly.
    livekitHostUrl: env.E2E_LIVEKIT_HOST_URL?.trim() || DEFAULT_LIVEKIT_HOST_URL,
    apiKey: env.LIVEKIT_API_KEY?.trim() ?? '',
    apiSecret: env.LIVEKIT_API_SECRET?.trim() ?? '',
    bindingPrivateKey: env.LIVE_VOICE_BINDING_PRIVATE_KEY?.trim() ?? '',
    bindingPublicKey: env.LIVE_VOICE_BINDING_PUBLIC_KEY?.trim() ?? '',
    openaiApiKey: env.OPENAI_API_KEY?.trim() ?? '',
    databaseUrl: env.E2E_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    agentName: env.E2E_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
  };

  const missing: string[] = [];
  if (!config.apiKey) missing.push('LIVEKIT_API_KEY');
  if (!config.apiSecret) missing.push('LIVEKIT_API_SECRET');
  if (!config.bindingPrivateKey) missing.push('LIVE_VOICE_BINDING_PRIVATE_KEY');
  if (!config.bindingPublicKey) missing.push('LIVE_VOICE_BINDING_PUBLIC_KEY');
  if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');

  return missing.length > 0 ? { ok: false, missing } : { ok: true, config };
}

/** Loud, actionable message naming exactly what is absent. */
export function describeMissingCredentials(
  missing: readonly string[],
  report?: CredentialInjectionReport,
): string {
  return [
    `voice-room e2e: missing credentials: ${missing.join(', ')}`,
    `expected them in ${report?.envFilePath ?? ENV_FILE_PATH} (git-ignored, never logged)`,
    'the vitest isolation setup deletes the LIVEKIT, LIVE_VOICE_BINDING and OPENAI keys from',
    'the environment, so a voice-room run injects the worktree .env explicitly and fails loudly when it cannot.',
  ].join('\n  ');
}

/** The single command that brings the isolated stack up. Quoted in failures. */
export const STACK_UP_COMMAND =
  'docker compose -p nana-e2e -f compose.yaml -f compose.e2e.override.yaml --profile worker up -d';

/**
 * Fails fast, and in words that name the fix, when the isolated stack is not up.
 *
 * Without this a missing stack surfaces as a bare `fetch failed / ECONNREFUSED`
 * from whichever call happens to run first, which does not tell the reader that
 * the stack is the thing that is missing or how to start it. It checks the two
 * dependencies the round trip actually needs, not the credentials (those are
 * handled before this point).
 */
export async function preflightVoiceRoomStack(
  config: VoiceRoomConfig,
): Promise<void> {
  const livekitHttp = config.livekitHostUrl
    .replace(/^wss:/u, 'https:')
    .replace(/^ws:/u, 'http:')
    .replace(/\/+$/u, '');

  try {
    await fetch(`${livekitHttp}/`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      [
        `voice-room e2e: the isolated LiveKit stack is not reachable at ${config.livekitHostUrl}.`,
        `underlying error: ${error instanceof Error ? error.message : String(error)}`,
        `start it with: ${STACK_UP_COMMAND}`,
        'see docs/voice-room-e2e-runbook.md for the ports it publishes.',
      ].join('\n  '),
    );
  }
}

/** Masks the password in a connection string before it is ever printed. */
export function maskConnectionString(value: string): string {
  return value.replace(/\/\/[^@]*@/u, '//***@');
}
