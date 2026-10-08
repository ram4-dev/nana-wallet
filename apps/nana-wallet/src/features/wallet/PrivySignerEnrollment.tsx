import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Payment-permission signer consent (TEE-compatible). Rendered ONLY inside the
 * Privy tree (privy mode) and lazy-loaded so bundles outside PrivyProvider
 * never import it.
 *
 * This app runs TEE-execution wallets, so the on-device `delegateWallet`
 * action is NOT supported (Privy errors with a migration hint). The
 * TEE-compatible path is `useSigners().addSigners`, attaching the app's key
 * quorum as a server-side signer with the enrollment policy attached:
 *
 *   signers: [{ signerId: quorumId, policyIds: [policyId] }]
 *
 * The browser supplies NO signer identity beyond the quorum id the backend
 * already disclosed in `prepare`; the backend `complete` read-back is what
 * proves the exact signer + policy binding before persisting the canonical id.
 */
export function PrivySignerEnrollment({
  walletAddress,
  quorumId,
  policyId,
  busy,
  onEnrolled,
  onError,
}: {
  walletAddress: string;
  quorumId: string;
  policyId: string;
  busy: boolean;
  onEnrolled: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { addSigners } = useSigners();
  const [consenting, setConsenting] = useState(false);

  async function handleConsent() {
    setConsenting(true);
    try {
      await addSigners({
        address: walletAddress,
        signers: [{ signerId: quorumId, policyIds: [policyId] }],
      });
      toast.success("Confirmaste la autorización en Privy.");
      await onEnrolled();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "No pudimos confirmar la autorización con Privy.",
      );
    } finally {
      setConsenting(false);
    }
  }

  return (
    <Button
      type="button"
      className="press mt-4 min-h-14 w-full text-base font-extrabold"
      onClick={() => void handleConsent()}
      disabled={busy || consenting}
    >
      {busy || consenting ? (
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      ) : (
        <ShieldCheck className="size-5" aria-hidden="true" />
      )}
      Autorizar firmante en Privy
    </Button>
  );
}
