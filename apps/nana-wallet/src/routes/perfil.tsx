import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useLogout } from "@privy-io/react-auth";
import { LogOut } from "lucide-react";
import { useState } from "react";

import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import { resetSession } from "@/lib/session-isolation";

/**
 * wallet-profile (WP-001/WP-002): a simple identity-only profile screen.
 *
 * /perfil renders the display name (or its explicit absence), keeps Salir and
 * its own load/error/retry for /me, and NEVER waits for contacts, agenda,
 * bills, wallet summary or permissions. The preserved legacy sections live in
 * `features/profile/LegacyProfileSections.tsx` and are intentionally not
 * mounted here (WP-015).
 */

const isPrivyEnabled = import.meta.env["VITE_IDENTITY_PROVIDER"] === "privy";

export const Route = createFileRoute("/perfil")({
  head: () => ({
    meta: [
      { title: "Mi perfil | Nana Wallet" },
      {
        name: "description",
        content: "Tus datos, en letra grande y sin vueltas.",
      },
      { property: "og:title", content: "Mi perfil" },
      {
        property: "og:description",
        content: "Tu nombre, tal como lo conocemos, y la salida de sesión.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  pendingComponent: () => <RoutePending label="Estamos buscando tu perfil" />,
  errorComponent: ({ error, reset }) => <RouteError error={error} onRetry={reset} />,
  component: PerfilPage,
});

function LogoutButton() {
  const { logout } = useLogout();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  async function handleLogout() {
    // WP-013: session reset aborts in-flight requests and clears the cache
    // before navigating away, so nothing of this user survives.
    resetSession();
    queryClient.clear();
    await logout();
    void navigate({ to: "/login" });
  }
  return (
    <Button
      type="button"
      variant="outline"
      className="press shrink-0"
      onClick={() => void handleLogout()}
    >
      <LogOut className="size-5" aria-hidden="true" />
      Salir
    </Button>
  );
}

function PerfilPage() {
  // WP-002: the identity query is the only requirement of this screen.
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const [isRetrying, setIsRetrying] = useState(false);

  if (meQuery.isPending) return <RoutePending label="Estamos buscando tu perfil" />;
  if (meQuery.isError) {
    async function retry() {
      setIsRetrying(true);
      try {
        await meQuery.refetch();
      } finally {
        setIsRetrying(false);
      }
    }
    return (
      <main className="mx-auto max-w-md px-6 pt-12 pb-40">
        <section className="surface-card p-5" role="alert">
          <h1 className="text-xl font-extrabold">No pudimos leer tu perfil</h1>
          <p className="mt-2 text-base text-muted-foreground">{getErrorMessage(meQuery.error)}</p>
          <Button
            type="button"
            variant="outline"
            className="press mt-4 min-h-12 w-full text-base font-extrabold"
            onClick={() => void retry()}
            disabled={isRetrying}
          >
            {isRetrying ? "Reintentando" : "Probar de nuevo"}
          </Button>
        </section>
      </main>
    );
  }

  const me = meQuery.data;
  // WP-001: null, empty or whitespace-only names are all "absent". Nothing is
  // persisted and no identifier (userId/DID) is ever displayed.
  const displayName = me.displayName?.trim() ? me.displayName : null;

  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40">
      <section className="lg-profile-card">
        <div
          className="flex size-13 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-xl font-extrabold text-brand-ink"
          aria-hidden="true"
        >
          {displayName ? displayName.charAt(0).toLocaleUpperCase("es-AR") : "N"}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-extrabold">Tu perfil</h1>
          <p
            className="mt-1 break-words text-base font-bold"
            {...(displayName ? {} : { "data-testid": "profile-name-absent" })}
          >
            {displayName ?? "Todavía no tenemos tu nombre"}
          </p>
        </div>
        {isPrivyEnabled ? <LogoutButton /> : null}
      </section>
    </main>
  );
}
