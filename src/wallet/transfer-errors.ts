/**
 * Rejection raised BEFORE any signing or dispatch happens.
 *
 * A transfer can be refused by a local precondition — wrong chain, wrong token,
 * a recipient outside the allowlist, or an amount above the per-transfer cap —
 * and that rejection is a distinct outcome from a transport failure. The route
 * layer maps it to a 422 so the caller sees a definitive refusal instead of an
 * ambiguous "something failed"; conflating the two is what the repo's payment
 * semantics forbid.
 *
 * This lived in the retired `transfer-pipeline.ts`. It stays because the
 * rejection contract is still part of the HTTP surface, and the requirement it
 * encodes (reject before signing, never after) is preserved in
 * `.agent-workflow/tasks/privy-sdk-migration/05-preserved-requirements.md`.
 */
export class TransferRejectedError extends Error {
  public constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "TransferRejectedError";
  }
}
