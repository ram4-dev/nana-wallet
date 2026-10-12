import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Check,
  Copy,
  RefreshCw,
  Send,
  Wallet,
} from "lucide-react";

import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/api-types";
import { useNotificationsFeed } from "@/features/notifications/useNotificationsFeed";

/**
 * wallet-profile (WP-010/WP-011/WP-012): identity plus the personal SOL
 * balance. The pesos total, quotes and simulated movements are preserved (but
 * not mounted) in `features/wallet/LegacyMoneySections.tsx` (WP-015).
 *
 * Balance read (WP-011): staleTime 30 s, refetchOnMount "always", no retry,
 * no polling, explicit refresh button. Error state wins over cached data so a
 * failed refresh always hides a previously shown amount. WalletLifecycle only
 * Payment-authorization management lives in /perfil (owner decision
 * 2026-10-07): this screen shows balance, assets and activity only.
 */

export const Route = createFileRoute("/mi-plata")({
  head: () => ({
    meta: [
      { title: "Wallet | Nana Wallet" },
      {
        name: "description",
        content:
          "Your SOL balance on Solana devnet, in big letters and with the time of the check.",
      },
      { property: "og:title", content: "Wallet" },
      {
        property: "og:description",
        content: "See your SOL balance and refresh it whenever you want.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  pendingComponent: () => <RoutePending label="We are looking for your money" />,
  errorComponent: ({ error, reset }) => <RouteError error={error} onRetry={reset} />,
  component: MiPlataPage,
});

const NOT_READY_LABELS: Record<string, string> = {
  unprovisioned: "Your wallet is not prepared yet.",
  provisioning: "We are preparing your wallet.",
  recovery_required: "Your wallet needs recovery.",
  conflict: "We detected a conflict with your wallet.",
  unavailable: "Your wallet is not available right now.",
};

function formatObservedAt(observedAt: string): string {
  // `en-US`: the copy on this screen is English, and a Spanish locale renders
  // Spanish from the formatter rather than from a string — "5 de enero" is not
  // findable by grepping for Spanish copy, but it is plainly on screen.
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(observedAt));
}

/**
 * Exact atomic-amount formatting for the personal balance.
 *
 * The backend sends the amount as a canonical decimal string and SOL has nine
 * decimals, so it must never go through Number. Same es-AR convention as
 * `formatUsdcBalance` (""."" for the integer group, "","" for the fraction,
 * trailing fraction zeros trimmed), but driven by the asset's own `decimals`
 * so the screen renders whatever unit the contract reports.
 */
function formatAtomicBalance(amountAtomic: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountAtomic) || decimals <= 0) {
    throw new Error("Invalid atomic balance.");
  }
  const divisor = 10n ** BigInt(decimals);
  const value = BigInt(amountAtomic);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return fraction ? `${groupedWhole},${fraction}` : groupedWhole;
}

/**
 * WP-012 (superseded 2026-10-07): WalletLifecycle moved to /perfil.
 * explicit user action, in its own section. Its load/errors are independent
 * from the balance and never hide or replace the balance section. It does not
 * provision anything by itself; WalletLifecycle only reads when mounted.
 */

function MiPlataPage() {
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const userId = meQuery.data?.userId;
  const notifications = useNotificationsFeed();

  const balancesQuery = useQuery({
    queryKey: queryKeys.balances(userId, SOLANA_DEVNET_CHAIN_ID),
    queryFn: api.getBalances,
    // WP-013: never query without a resolved identity.
    enabled: Boolean(userId),
    // WP-011: refresh on entry, no polling, no retry loop.
    staleTime: 30_000,
    refetchOnMount: "always",
    retry: false,
    refetchInterval: false,
  });

  // LuckGnome structure: "Tus activos" covers every chain the user holds.
  const networkBalancesQuery = useQuery({
    queryKey: queryKeys.networkBalances(userId),
    queryFn: api.getNetworkBalances,
    enabled: Boolean(userId),
    staleTime: 30_000,
    refetchOnMount: "always",
    retry: false,
  });
  const [addressVisible, setAddressVisible] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  // WP-011: the identity error renders before any dependent load.
  if (meQuery.isPending) return <RoutePending label="We are looking for your money" />;
  if (meQuery.isError) {
    return <RouteError error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  if (balancesQuery.isPending) {
    return <RoutePending label="We are looking for your balance" />;
  }

  if (balancesQuery.isError) {
    // WP-011: error wins over data — a previous amount is never shown next to
    // a failed refresh.
    return (
      <main className="mx-auto max-w-md px-6 pt-12 pb-40">
        <h1 className="text-2xl font-extrabold">Wallet</h1>
        <section className="surface-card mt-5 p-5" role="alert">
          <h2 className="text-xl font-extrabold">We could not read your balance</h2>
          <p className="mt-2 text-base text-muted-foreground">
            {getErrorMessage(balancesQuery.error)}
          </p>
          <Button
            type="button"
            variant="outline"
            className="press mt-4 min-h-12 w-full text-base font-extrabold"
            onClick={() => void balancesQuery.refetch()}
          >
            <RefreshCw className="size-5" aria-hidden="true" />
            Refresh balance
          </Button>
        </section>
      </main>
    );
  }

  const balances = balancesQuery.data;
  const networkBalances = networkBalancesQuery.data ?? [];
  const activity = notifications.items
    .filter((item) => item.category === "wallet_event" || item.category === "assistant_transfer")
    .slice(0, 3);

  return (
    <main className="mx-auto max-w-md px-5 pt-12 pb-40">
      <header className="flex items-center justify-end gap-3">
        <Link
          to="/notificaciones"
          className="press inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-bold text-foreground"
          aria-label={`Notifications${notifications.unreadCount ? `, ${notifications.unreadCount} unread` : ""}`}
          data-testid="notifications-shortcut"
        >
          <Bell className="size-4" aria-hidden="true" />
          Notifications
          {notifications.unreadCount > 0 ? (
            <span
              className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground"
              aria-hidden="true"
            >
              {notifications.unreadCount}
            </span>
          ) : null}
        </Link>
      </header>

      <h1 className="mt-1 text-3xl font-extrabold tracking-tight">My wallet</h1>

      {balances.walletState === "ready" ? (
        <section className="lg-balance-card" aria-label="Your balance">
          <p className="text-sm text-muted-foreground">Your balance</p>
          {/* WP-010: exact string/BigInt format; es-AR separators. */}
          <p
            className="mt-1.5 mb-1.5 break-words text-4xl font-extrabold tracking-tight"
            data-testid="usdc-balance"
          >
            {formatAtomicBalance(balances.assets[0]!.balanceAtomic, balances.assets[0]!.decimals)}{" "}
            {balances.assets[0]!.symbol}
          </p>
          <p className="inline-flex items-center gap-1.5 text-sm font-bold text-brand-ink">
            <Wallet className="size-4" aria-hidden="true" />
            {balances.networkName}
          </p>
          {balances.source === "fixture" ? (
            <p className="mt-2 inline-flex rounded-full border border-border bg-card px-3 py-1 text-sm font-bold text-foreground">
              Demo amount
            </p>
          ) : null}
          <p className="mt-2 text-sm text-muted-foreground">
            Checked: {formatObservedAt(balances.observedAt)}
          </p>
        </section>
      ) : (
        <section className="surface-card mt-5 p-5" role="status" data-testid="wallet-not-ready">
          <div className="flex items-center gap-2">
            <Wallet className="size-6 text-brand-ink" aria-hidden="true" />
            <h2 className="text-xl font-extrabold">Wallet</h2>
          </div>
          <p className="mt-2 text-lg text-muted-foreground">
            {NOT_READY_LABELS[balances.walletState] ?? "Your wallet is not ready yet."}
          </p>
          <p className="mt-1 text-base text-muted-foreground">{balances.networkName}</p>
        </section>
      )}

      {balances.walletState === "ready" ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <Link
              to="/"
              className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-primary bg-primary font-extrabold text-primary-foreground"
            >
              <Send className="size-4" aria-hidden="true" />
              Send
            </Link>
            <button
              type="button"
              className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-border bg-card font-extrabold text-foreground"
              onClick={() => setAddressVisible((visible) => !visible)}
              aria-expanded={addressVisible}
            >
              <ArrowDownLeft className="size-4" aria-hidden="true" />
              Receive
            </button>
          </div>
          {addressVisible ? (
            <div className="mt-3 rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-bold">Your address on {balances.networkName}</p>
              <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
                {balances.address}
              </p>
              <button
                type="button"
                className="press mt-2.5 inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-bold"
                onClick={() => {
                  void navigator.clipboard.writeText(balances.address);
                  setAddressCopied(true);
                  window.setTimeout(() => setAddressCopied(false), 2000);
                }}
              >
                {addressCopied ? (
                  <Check className="size-4 text-brand-ink" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {addressCopied ? "Copied" : "Copy address"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <section className="mt-7">
        <div className="flex items-center justify-between gap-2.5">
          <h2 className="text-base font-extrabold">Your assets</h2>
          <span className="text-xs text-muted-foreground">{networkBalances.length || 1}</span>
        </div>
        <div className="lg-row-list mt-2">
          {networkBalances.length === 0 ? (
            <div className="lg-row">
              <span className="lg-row-icon" aria-hidden="true">
                <Wallet className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">Solana</span>
                <span className="block text-xs text-muted-foreground">SOL · Solana devnet</span>
              </span>
              <span className="text-right">
                <strong className="block text-sm font-bold" data-testid="usdc-balance">
                  {balances.walletState === "ready"
                    ? `${formatAtomicBalance(
                        balances.assets[0]!.balanceAtomic,
                        balances.assets[0]!.decimals,
                      )} ${balances.assets[0]!.symbol}`
                    : "—"}
                </strong>
              </span>
            </div>
          ) : (
            networkBalances.map((asset) => (
              <div key={asset.network} className="lg-row">
                <span className="lg-row-icon" aria-hidden="true">
                  <Wallet className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">
                    {asset.token === "SOL" ? "Solana" : asset.token}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {asset.token} · {asset.network}
                  </span>
                </span>
                <span className="text-right">
                  <strong className="block whitespace-nowrap text-sm font-bold">
                    {asset.balance} {asset.token}
                  </strong>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-base font-extrabold">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            You do not have any wallet activity yet.
          </p>
        ) : (
          <div className="lg-row-list mt-2">
            {activity.map((item) => (
              <div key={item.id} className="lg-row">
                <span className="lg-row-icon" aria-hidden="true">
                  <ArrowUpRight className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">{item.title}</span>
                  {item.explanation ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.explanation}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8 rounded-2xl border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Here you see your SOL balance on Solana devnet. We do not show pesos, quotes or simulated
          movements.
        </p>
      </section>
    </main>
  );
}
