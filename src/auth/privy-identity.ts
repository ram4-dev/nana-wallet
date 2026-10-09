import { createPublicKey } from "node:crypto";
import { jwtVerify } from "jose";
import type { FastifyRequest } from "fastify";

const PRIVY_ISSUER = "privy.io";
const PRIVY_DID_PREFIX = "did:privy:";

export class PrivyIdentityError extends Error {
  public constructor(
    public readonly code: "unauthenticated",
    message: string,
  ) {
    super(message);
    this.name = "PrivyIdentityError";
  }
}

export type PrivyIdentityProviderConfig = {
  appId: string;
  /** Trusted app verification keys in PEM (SPKI) form; supports a rotation bundle. */
  verificationKeyPem: string;
  /** Resolves a verified Privy DID to the internal users UUID (PMU-003). */
  resolvePrivyDid: (privyDid: string, displayName?: string) => Promise<string>;
};

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new PrivyIdentityError("unauthenticated", "Missing bearer token.");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new PrivyIdentityError("unauthenticated", "Missing bearer token.");
  }
  return token;
}

/**
 * Verified Privy access-token identity provider (PMU-001/002). Verification
 * succeeds only for ES256 tokens signed with the app verification key,
 * issued by privy.io, for this app's audience, and unexpired. The verified
 * `sub` (Privy DID) is resolved to the internal users UUID through the
 * idempotent provisioning function (PMU-003) on the owner connection —
 * never through `withUserTransaction`.
 */
function parseVerificationKeys(pem: string): ReturnType<typeof createPublicKey>[] {
  const blocks = pem.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/gu);
  if (!blocks?.length || blocks.length > 10 || pem.replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/gu, "").trim()) {
    throw new Error("PRIVY_VERIFICATION_KEY must contain valid PEM public keys.");
  }
  return blocks.map((block) => {
    const key = createPublicKey(block);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("Privy verification keys must use P-256.");
    }
    return key;
  });
}

export class PrivyIdentityProvider {
  private readonly verificationKeys: ReturnType<typeof createPublicKey>[];

  public constructor(private readonly config: PrivyIdentityProviderConfig) {
    try {
      this.verificationKeys = parseVerificationKeys(config.verificationKeyPem);
    } catch {
      throw new Error("PRIVY_VERIFICATION_KEY must be a valid PEM public key.");
    }
  }

  public async resolve(
    request: FastifyRequest,
  ): Promise<{ userId: string; issuedAt: Date | undefined }> {
    const token = extractBearerToken(request);
    let payload: { sub?: string; name?: string; iat?: number };
    try {
      const result = await Promise.any(this.verificationKeys.map((key) => jwtVerify(token, key, {
        algorithms: ["ES256"],
        issuer: PRIVY_ISSUER,
        audience: this.config.appId,
        // exp is mandatory (PMU-002): reject tokens without expiry.
        requiredClaims: ["iss", "aud", "sub", "exp"],
      })));
      payload = result.payload as { sub?: string; name?: string; iat?: number };
    } catch {
      throw new PrivyIdentityError(
        "unauthenticated",
        "Invalid or expired Privy access token.",
      );
    }
    const sub = payload.sub;
    if (!sub || !sub.startsWith(PRIVY_DID_PREFIX)) {
      throw new PrivyIdentityError(
        "unauthenticated",
        "Invalid Privy DID subject.",
      );
    }
    const userId = await this.config.resolvePrivyDid(sub, payload.name);
    // Surface the verified issued-at so the session floor can compare it. The
    // provider stays a pure offline verifier (no DB access): the floor lives
    // outside it, in a decorator that reads users.session_floor_at.
    const issuedAt =
      typeof payload.iat === "number" ? new Date(payload.iat * 1000) : undefined;
    return { userId, issuedAt };
  }
}

export type PrivyVerificationInputs = {
  appId: string;
  verificationKeyPem: string;
};

/** Reads and validates the Privy verification inputs from the environment (PMU-001). */
export function readPrivyVerificationInputs(
  environment: NodeJS.ProcessEnv,
): PrivyVerificationInputs {
  const appId = environment.PRIVY_APP_ID?.trim();
  const verificationKeyPem = environment.PRIVY_VERIFICATION_KEY?.trim().replace(
    /\\n/gu,
    "\n",
  );
  if (!appId)
    throw new Error("PRIVY_APP_ID is required for the Privy identity provider.");
  if (!verificationKeyPem)
    throw new Error(
      "PRIVY_VERIFICATION_KEY is required for the Privy identity provider.",
    );
  try {
    parseVerificationKeys(verificationKeyPem);
  } catch {
    throw new Error("PRIVY_VERIFICATION_KEY must be a valid PEM public key.");
  }
  return { appId, verificationKeyPem };
}
