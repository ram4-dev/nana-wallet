import { useCreateWallet } from "@privy-io/react-auth/solana";
import { useWallets } from "@privy-io/react-auth";
import { Loader2, PlusCircle } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { api, queryKeys } from "@/lib/api";

/**
 * The SDK's `ConnectedWallet` d.ts intersects `BaseConnectedEthereumWallet`, so
 * TypeScript narrows `type` to 'ethereum' even though `useWallets` reports
 * Solana embedded wallets at runtime. Widen the discriminant deliberately.
 */
function isSolanaWallet(wallet: { type: string }): boolean {
  return wallet.type === "solana";
}

/**
 * Solana embedded-wallet setup (Privy-only). Delegated Solana grants require a
 * ready Solana binding, which the backend discovers through an authenticated
 * sync. This component lets the user create their Privy Solana embedded wallet
 * from Nana and immediately re-syncs so the binding becomes ready.
 *
 * Rendered ONLY inside the Privy tree and lazy-loaded so demo-mode bundles
 * never import Privy Solana hooks.
 */
export function SolanaWalletSetup({ userId }: { userId: string | undefined }) {
  const { ready, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const hasSolanaWallet = wallets.some(isSolanaWallet);

  if (!ready || hasSolanaWallet) return null;

  async function handleCreate() {
    setCreating(true);
    setMessage(null);
    try {
      await createWallet(); // resolves { wallet } for the new Solana embedded wallet
      await api.syncWallet();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.currentWallet(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.wallet(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.movements(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.grants(userId) }),
      ]);
      setMessage("Billetera de Solana creada. Ya podés autorizar transferencias delegadas.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No pudimos crear la billetera de Solana. Probá de nuevo.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-4">
      <p className="text-base font-bold">Transferencias delegadas en Solana</p>
      <p className="mt-1 text-base text-muted-foreground">
        Para autorizar transferencias delegadas en Solana necesitás una billetera de Solana. Creala
        cuando quieras: es gratuita y queda protegida por Privy.
      </p>
      <Button
        type="button"
        variant="outline"
        className="press mt-3 min-h-12 w-full text-base font-extrabold"
        onClick={() => void handleCreate()}
        disabled={creating}
      >
        {creating ? (
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        ) : (
          <PlusCircle className="size-5" aria-hidden="true" />
        )}
        Crear billetera de Solana
      </Button>
      {message ? (
        <p
          className="mt-3 rounded-2xl border border-border bg-secondary p-3 text-sm font-semibold"
          role="status"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
