import 'dotenv/config';
import { FinancialTaskRegistry } from '../conversations/financial-task-registry.js';
import { readLiveKitPrivacyConfig } from '../config/livekit.js';

export type LiveKitWorkerConfig = { url: string; apiKey: string; apiSecret: string; shutdownTimeoutMs: number };

export function readLiveKitWorkerConfig(environment: NodeJS.ProcessEnv = process.env): LiveKitWorkerConfig {
  readLiveKitPrivacyConfig(environment);
  const url = environment.LIVEKIT_URL?.trim();
  const apiKey = environment.LIVEKIT_API_KEY?.trim();
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) throw new Error('LiveKit worker requires LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.');
  return { url, apiKey, apiSecret, shutdownTimeoutMs: Number(environment.LIVEKIT_SHUTDOWN_TIMEOUT_MS ?? 10_000) };
}

export function createLiveKitWorkerRuntime() {
  const financialTasks = new FinancialTaskRegistry();
  return { financialTasks, async close() { await financialTasks.drain({ timeoutMs: 10_000 }); } };
}

if (/worker\.(ts|js)$/.test(process.argv[1] ?? '')) {
  readLiveKitWorkerConfig();
  console.error('LiveKit worker transport is not started without an explicit room adapter.');
}
