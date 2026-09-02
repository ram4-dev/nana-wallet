import { randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';

type SigningKey = Parameters<SignJWT['sign']>[0];

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, '\n');
}

export type LiveVoiceBindingClaims = {
  sub: string;
  conversationId: string;
  purpose: 'live_voice_binding';
  jti: string;
  iat: number;
  exp: number;
  iss: 'nani-api';
  aud: 'nani-livekit-worker';
};

export class LiveBindingError extends Error {
  public constructor(public readonly code: 'invalid_binding' | 'expired_binding') {
    super(code);
    this.name = 'LiveBindingError';
  }
}

async function signingKey(privateKey: string | SigningKey): Promise<SigningKey> {
  return typeof privateKey === 'string' ? importPKCS8(normalizePem(privateKey), 'EdDSA') : privateKey;
}

async function verificationKey(publicKey: string) {
  return importSPKI(normalizePem(publicKey), 'EdDSA');
}

export async function issueLiveVoiceBinding(input: {
  userId: string;
  conversationId: string;
  privateKey: string | SigningKey;
  lifetimeSeconds?: number;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const lifetimeSeconds = input.lifetimeSeconds ?? 60;
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0 || lifetimeSeconds > 300) {
    throw new LiveBindingError('invalid_binding');
  }
  return new SignJWT({ conversationId: input.conversationId, purpose: 'live_voice_binding' })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSeconds)
    .setIssuer('nani-api')
    .setAudience('nani-livekit-worker')
    .sign(await signingKey(input.privateKey));
}

export async function verifyLiveVoiceBinding(input: {
  token: string;
  publicKey: string;
  now?: number;
}): Promise<LiveVoiceBindingClaims> {
  try {
    const result = await jwtVerify(input.token, await verificationKey(input.publicKey), {
      algorithms: ['EdDSA'], issuer: 'nani-api', audience: 'nani-livekit-worker',
      ...(input.now === undefined ? {} : { currentDate: new Date(input.now * 1000) }),
    });
    const payload = result.payload;
    if (
      typeof payload.sub !== 'string' || typeof payload.conversationId !== 'string' ||
      payload.purpose !== 'live_voice_binding' || typeof payload.jti !== 'string' ||
      typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
    ) throw new LiveBindingError('invalid_binding');
    return payload as unknown as LiveVoiceBindingClaims;
  } catch (error) {
    if (error instanceof LiveBindingError) throw error;
    const code = error instanceof Error && ('code' in error && error.code === 'ERR_JWT_EXPIRED' || error.name === 'JWTExpired' || error.message.toLowerCase().includes('expired')) ? 'expired_binding' : 'invalid_binding';
    throw new LiveBindingError(code);
  }
}
