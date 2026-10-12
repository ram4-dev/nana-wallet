import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";

import { EmptyState } from "@/components/RouteStates";
import { api, queryKeys } from "@/lib/api";

/**
 * wallet-profile (WP-010/WP-015): preserved legacy money sections.
 *
 * /mi-plata no longer mounts these: the screen now shows the identity plus the
 * personal USDC balance (WP-010). The pesos summary and simulated movements —
 * and the MSW-only endpoints they consumed (/v1/wallet/summary,
 * /v1/wallet/movements) — are preserved verbatim here so no prior work is
 * deleted. They are NOT mounted by the simplified screen; re-exposing pesos,
 * quotes or simulated movements is a scope decision.
 */

function compactMoney(display: string) {
  return display.replace("$ ", "$");
}

export function LegacyMoneySections({ userId }: { userId: string | undefined }) {
  const summaryQuery = useQuery({
    queryKey: queryKeys.wallet(userId),
    queryFn: api.getWalletSummary,
    enabled: Boolean(userId),
  });
  const movementsQuery = useQuery({
    queryKey: queryKeys.movements(userId),
    queryFn: () => api.getMovements({ limit: 20 }),
    enabled: Boolean(userId),
  });

  if (!summaryQuery.data || !movementsQuery.data) {
    return (
      <EmptyState>We could not find accounts to show you. Try again in a little while.</EmptyState>
    );
  }

  const summary = summaryQuery.data;
  const movements = movementsQuery.data.items;

  return (
    <>
      <section className="relative mt-5 overflow-hidden rounded-[2rem] border border-foreground bg-foreground px-7 py-6 text-background">
        <span
          className="absolute -top-10 -right-8 size-28 rounded-full bg-primary"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-base font-bold text-background/70">Total in pesos</p>
          <p className="mt-1 text-4xl font-extrabold tracking-tight">{summary.total.display}</p>
        </div>
      </section>

      <h2 className="mt-10 text-xl font-extrabold">Where your money is</h2>
      {summary.accounts.length === 0 ? (
        <EmptyState>
          We could not find accounts to show you. Try again in a little while.
        </EmptyState>
      ) : (
        <ul className="mt-4 space-y-3">
          {summary.accounts.map((account) => (
            <li
              key={account.id}
              className="surface-card flex items-center justify-between gap-3 p-5"
            >
              <div>
                <p className="text-lg font-bold">{account.name}</p>
                <p className="text-base text-muted-foreground">{account.subtitle}</p>
              </div>
              <p className="text-right text-lg font-extrabold">{account.balance.display}</p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 text-xl font-extrabold">Latest movements</h2>
      {movements.length === 0 ? (
        <EmptyState>
          You have no movements to show yet. When money comes in or goes out, it will show up here.
        </EmptyState>
      ) : (
        <ul className="mt-4 space-y-3">
          {movements.map((movement) => (
            <li key={movement.id} className="surface-card flex items-center gap-4 p-4">
              <span
                className={
                  movement.kind === "entrada"
                    ? "rounded-xl bg-success-surface text-success-surface-foreground border border-border p-3 text-success"
                    : "rounded-xl bg-destructive-surface text-destructive-surface-foreground border border-border p-3 text-destructive"
                }
                aria-hidden="true"
              >
                {movement.kind === "entrada" ? (
                  <ArrowDownLeft className="size-6" strokeWidth={2.6} />
                ) : (
                  <ArrowUpRight className="size-6" strokeWidth={2.6} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold">{movement.title}</p>
                <p className="text-base text-muted-foreground">{movement.subtitle}</p>
              </div>
              <p className="text-right text-base font-extrabold">
                {movement.kind === "entrada" ? "You received " : "You paid "}
                {compactMoney(movement.amount.display)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
