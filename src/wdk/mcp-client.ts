import { createRequire } from 'node:module';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters
} from '@modelcontextprotocol/sdk/client/stdio.js';

export const REQUIRED_WDK_TOOLS = [
  'get_networks',
  'list_tokens',
  'get_token',
  'get_address',
  'get_balance',
  'get_history',
  'send_token'
] as const;

const require = createRequire(import.meta.url);
const SENSITIVE_KEY = /(seed|mnemonic|passphrase|private.?key|api.?key|credential|secret.?config)/i;
const SAFE_ENVIRONMENT_NAMES = [
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR'
] as const;

export type EvidenceStage =
  | 'handshake'
  | 'connection'
  | 'discovery'
  | 'call'
  | 'validation'
  | 'closure';

export class McpBoundaryError extends Error {
  public readonly stage: EvidenceStage;
  public readonly sanitized: string;
  public readonly raw: unknown | null;

  public constructor(stage: EvidenceStage, cause: unknown, raw: unknown | null = null) {
    super(`${stage}: ${sanitizeError(cause)}`);
    this.name = 'McpBoundaryError';
    this.stage = stage;
    this.sanitized = sanitizeError(cause);
    this.raw = raw;
  }
}

export class EvidenceSafetyError extends Error {
  public constructor(message = 'Sensitive material cannot be stored in WDK evidence.') {
    super(message);
    this.name = 'EvidenceSafetyError';
  }
}

export type RawTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpSession = {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: RawTool[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

export type WdkMcpClientOptions = {
  handshakeTimeoutMs?: number;
  callTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  explicitWdkEnvironment?: ExplicitWdkEnvironment;
  sessionFactory?: (configuration: StdioServerParameters) => McpSession;
};

export type ExplicitWdkEnvironment = Partial<{
  WDK_INDEXER_API_KEY: string;
}>;

export type TransferInput = {
  to: string;
  amount: string;
  network: 'sepolia';
  token: 'usdt';
  baseUnits?: boolean;
  index?: number;
  wallet?: string;
  dryRun: boolean;
};

export type TransferEvidence = {
  schemaVersion: 'wdk-evidence/v1';
  network: 'sepolia';
  asset: 'USD₮';
  input: TransferInput;
  raw: unknown;
  broadcast: {
    attempted: boolean;
    count: 0 | 1;
    hash: string | null;
    verification: 'not-requested' | 'not-verified' | 'not-dispatched' | 'uncertain';
  };
  failure?: {
    stage: EvidenceStage;
    error: string;
  };
};

export function resolveBundledWdkMcp(): string {
  return require.resolve('@tetherto/wdk-cli/bin/wdk-mcp.mjs');
}

export function allowlistedEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  explicitWdkEnvironment: ExplicitWdkEnvironment = {}
): Record<string, string> {
  const inherited = getDefaultEnvironment();
  const result: Record<string, string> = {};

  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = environment[name] ?? inherited[name];
    if (value) result[name] = value;
  }

  for (const [name, value] of Object.entries(explicitWdkEnvironment)) {
    if (value) result[name] = value;
  }

  return result;
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeText(raw)
    .slice(0, 500);
}

function sanitizeText(raw: string): string {
  return raw
    .replace(/((?:seed|mnemonic|passphrase|private.?key|api.?key|credential|secret.?config)\s*[=:]\s*)(\S+)/gi, '$1[REDACTED]')
    .replace(/((?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Token\s+)[^\s,;]+/g, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s/:@]+):[^\s@/]+@/gi, '$1:[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|signature|sig|secret|password|passphrase)=)[^&#\s]*/gi, '$1[REDACTED]');
}

export function sanitizeForEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForEvidence);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) throw new EvidenceSafetyError();
      result[key] = sanitizeForEvidence(nested);
    }
    return result;
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}

export function classifyHistory(raw: unknown): 'unavailable' | 'stale' | 'empty' | 'non-empty' {
  const decoded = decodeMcpText(raw);
  if (decoded !== raw) return classifyHistory(decoded);
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    if (candidate.isError === true || candidate.unavailable === true) return 'unavailable';
    if (candidate.stale === true) return 'stale';
    for (const key of ['history', 'transactions', 'items', 'results']) {
      if (Array.isArray(candidate[key])) return candidate[key].length === 0 ? 'empty' : 'non-empty';
    }
  }
  return 'unavailable';
}

export function createTransferEvidence(input: TransferInput, raw: unknown): TransferEvidence {
  if (input.network !== 'sepolia' || input.token !== 'usdt') {
    throw new McpBoundaryError('validation', 'USD₮ evidence requires a Sepolia token transfer.');
  }
  if (isMcpToolError(raw)) {
    throw new McpBoundaryError('call', mcpErrorMessage(raw));
  }
  const hash = findTransactionHash(raw);
  return {
    schemaVersion: 'wdk-evidence/v1',
    network: 'sepolia',
    asset: 'USD₮',
    input: sanitizeForEvidence(input) as TransferInput,
    raw: sanitizeForEvidence(raw),
    broadcast: {
      attempted: input.dryRun === false,
      count: input.dryRun === false ? 1 : 0,
      hash,
      verification: input.dryRun ? 'not-requested' : 'not-verified'
    }
  };
}

export class WdkMcpClient {
  private readonly handshakeTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly sessionFactory: (configuration: StdioServerParameters) => McpSession;
  private readonly configuration: StdioServerParameters;
  private session: McpSession | undefined;
  private lifecycle: 'new' | 'open' | 'closed' | 'failed' = 'new';

  public constructor(options: WdkMcpClientOptions = {}) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 15_000;
    this.configuration = {
      command: process.execPath,
      args: [resolveBundledWdkMcp()],
      cwd: process.cwd(),
      env: allowlistedEnvironment(options.environment, options.explicitWdkEnvironment),
      stderr: 'pipe'
    };
    this.sessionFactory = options.sessionFactory ?? createSdkSession;
  }

  public spawnConfiguration(): Readonly<StdioServerParameters> {
    return this.configuration;
  }

  public async open(): Promise<void> {
    if (this.lifecycle !== 'new') {
      throw new McpBoundaryError('connection', 'WDK MCP clients are single-use and never restart automatically.');
    }
    this.session = this.sessionFactory(this.configuration);
    try {
      await within(this.session.connect(), this.handshakeTimeoutMs, 'handshake');
      this.lifecycle = 'open';
    } catch (error) {
      this.lifecycle = 'failed';
      await this.closeQuietly();
      throw asBoundaryError('handshake', error);
    }
  }

  public async discover(): Promise<{ tools: RawTool[] }> {
    const session = this.requireOpen('discovery');
    try {
      const discovery = await within(session.listTools(), this.callTimeoutMs, 'discovery');
      assertRequiredTools(discovery.tools);
      return sanitizeForEvidence(discovery) as { tools: RawTool[] };
    } catch (error) {
      await this.close();
      throw asBoundaryError('discovery', error);
    }
  }

  public async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callWithDispatch(name, args);
  }

  private async callWithDispatch(
    name: string,
    args: Record<string, unknown>,
    onDispatch?: () => void
  ): Promise<unknown> {
    const session = this.requireOpen('call');
    try {
      const safeArgs = sanitizeForEvidence(args) as Record<string, unknown>;
      onDispatch?.();
      const raw = await within(session.callTool(name, safeArgs), this.callTimeoutMs, 'call');
      const sanitized = sanitizeForEvidence(raw);
      if (isMcpToolError(sanitized)) {
        throw new McpBoundaryError('call', mcpErrorMessage(sanitized), sanitized);
      }
      return sanitized;
    } catch (error) {
      await this.close();
      throw asBoundaryError('call', error);
    }
  }

  public async sendToken(input: TransferInput): Promise<TransferEvidence> {
    const candidate = validateTransferCandidate(input);
    let dispatched = false;
    try {
      const raw = await this.callWithDispatch('send_token', candidate, () => { dispatched = true; });
      return createTransferEvidence(candidate, raw);
    } catch (error) {
      if (candidate.dryRun) throw error;
      return {
        schemaVersion: 'wdk-evidence/v1',
        network: 'sepolia',
        asset: 'USD₮',
        input: sanitizeForEvidence(candidate) as TransferInput,
        raw: error instanceof McpBoundaryError ? error.raw : null,
        broadcast: {
          attempted: dispatched,
          count: dispatched ? 1 : 0,
          hash: null,
          verification: dispatched ? 'uncertain' : 'not-dispatched'
        },
        failure: {
          stage: error instanceof McpBoundaryError ? error.stage : 'call',
          error: sanitizeError(error)
        }
      };
    }
  }

  public async close(): Promise<void> {
    if (this.lifecycle === 'closed') return;
    this.lifecycle = 'closed';
    await this.closeQuietly();
  }

  private requireOpen(stage: EvidenceStage): McpSession {
    if (this.lifecycle !== 'open' || !this.session) {
      throw new McpBoundaryError(stage, 'WDK MCP client is not open.');
    }
    return this.session;
  }

  private async closeQuietly(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.close();
    } catch {
      // A failed close cannot justify a restart or another wallet call.
    }
  }
}

function createSdkSession(configuration: StdioServerParameters): McpSession {
  const transport = new StdioClientTransport(configuration);
  const client = new Client({ name: 'aleph-wdk-evidence', version: '0.1.0' });
  let sanitizedStderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    sanitizedStderr = `${sanitizedStderr}${sanitizeError(chunk)}`.slice(-500);
  });
  const withDiagnostics = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch (error) {
      const detail = sanitizedStderr ? `; stderr: ${sanitizedStderr}` : '';
      throw new Error(`${sanitizeError(error)}${detail}`);
    }
  };
  return {
    connect: () => withDiagnostics(client.connect(transport)),
    listTools: () => withDiagnostics(client.listTools()),
    callTool: (name, args) => withDiagnostics(client.callTool({ name, arguments: args })),
    close: () => client.close()
  };
}

function assertRequiredTools(tools: RawTool[]): void {
  const names = new Set(tools.map((tool) => tool.name));
  const missing = REQUIRED_WDK_TOOLS.filter((tool) => !names.has(tool));
  if (missing.length > 0) throw new Error(`WDK MCP discovery is missing tools: ${missing.join(', ')}.`);
}

function validateTransferCandidate(input: TransferInput): TransferInput {
  const candidate = input as { network?: unknown; token?: unknown; to?: unknown; amount?: unknown; dryRun?: unknown };
  if (candidate.network !== 'sepolia' || typeof candidate.token !== 'string' || candidate.token.toLowerCase() !== 'usdt') {
    throw new McpBoundaryError('validation', 'USD₮ evidence requires the Sepolia usdt token.');
  }
  if (typeof candidate.to !== 'string' || candidate.to.trim().length === 0) {
    throw new McpBoundaryError('validation', 'A recipient is required for USD₮ evidence.');
  }
  if (typeof candidate.amount !== 'string' || candidate.amount.trim().length === 0) {
    throw new McpBoundaryError('validation', 'An amount is required for USD₮ evidence.');
  }
  if (typeof candidate.dryRun !== 'boolean') {
    throw new McpBoundaryError('validation', 'dryRun must be explicit for USD₮ evidence.');
  }
  return { ...input, token: 'usdt', to: candidate.to, amount: candidate.amount, dryRun: candidate.dryRun };
}

function asBoundaryError(stage: EvidenceStage, error: unknown): McpBoundaryError {
  return error instanceof McpBoundaryError ? error : new McpBoundaryError(stage, error);
}

async function within<T>(operation: Promise<T>, timeoutMs: number, stage: EvidenceStage): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function findTransactionHash(value: unknown): string | null {
  const decoded = decodeMcpText(value);
  if (decoded !== value) return findTransactionHash(decoded);
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  for (const key of ['hash', 'transactionHash', 'txHash']) {
    if (typeof candidate[key] === 'string') return candidate[key];
  }
  return null;
}

function isMcpToolError(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && (value as Record<string, unknown>).isError === true;
}

function mcpErrorMessage(value: unknown): string {
  const decoded = decodeMcpText(value);
  if (decoded && typeof decoded === 'object') {
    const candidate = decoded as Record<string, unknown>;
    for (const key of ['message', 'error', 'code']) {
      if (typeof candidate[key] === 'string') return sanitizeError(candidate[key]);
    }
  }
  return 'WDK MCP tool returned isError=true.';
}

function decodeMcpText(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return value;
  const text = content.find(
    (entry): entry is { type: 'text'; text: string } =>
      Boolean(entry) && typeof entry === 'object' &&
      (entry as Record<string, unknown>).type === 'text' &&
      typeof (entry as Record<string, unknown>).text === 'string'
  );
  if (!text) return value;
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return value;
  }
}
