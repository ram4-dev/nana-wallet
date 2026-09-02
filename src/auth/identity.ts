import type { FastifyRequest } from "fastify";

export type RequestIdentity = { userId: string };

export interface RequestIdentityProvider {
  resolve(request: FastifyRequest): Promise<RequestIdentity>;
}

/** Development-only identity seam. It must be replaced before multi-user access. */
export class DemoIdentityProvider implements RequestIdentityProvider {
  public constructor(private readonly userId: string) {}

  public async resolve(_request: FastifyRequest): Promise<RequestIdentity> {
    return { userId: this.userId };
  }
}
