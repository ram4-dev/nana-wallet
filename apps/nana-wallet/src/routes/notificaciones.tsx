import { createFileRoute } from "@tanstack/react-router";
import { Bell, Check, RefreshCw } from "lucide-react";

import { RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api";
import { useNotificationsFeed } from "@/features/notifications/useNotificationsFeed";

export const Route = createFileRoute("/notificaciones")({
  head: () => ({ meta: [{ title: "Notifications | Nana Wallet" }] }),
  component: NotificationsPage,
});

function formatDate(value: string) {
  // `en-US`: English copy, and the locale is otherwise invisible to a grep — the
  // formatter would render Spanish month names and a Spanish time meridian.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function NotificationsPage() {
  const feed = useNotificationsFeed();

  if (feed.isLoading && feed.items.length === 0) {
    return <RoutePending label="We are looking for your notifications" />;
  }

  return (
    <main className="mx-auto max-w-md px-6 pt-12 pb-40" data-testid="notifications-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Notifications</h1>
          <p className="mt-1 text-base text-muted-foreground">
            {feed.unreadCount === 0
              ? "You are up to date."
              : `${feed.unreadCount} ${feed.unreadCount === 1 ? "unread notification" : "unread notifications"}.`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="press min-h-12 shrink-0"
          aria-label="Refresh notifications"
          onClick={() => void feed.refresh()}
        >
          <RefreshCw className="size-5" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {feed.error ? (
        <section className="surface-card mt-5 p-5" role="alert">
          <h2 className="text-xl font-extrabold">We could not load the inbox</h2>
          <p className="mt-2 text-base text-muted-foreground">{getErrorMessage(feed.error)}</p>
          <Button className="press mt-4 min-h-12 w-full" onClick={() => void feed.refresh()}>
            Try again
          </Button>
        </section>
      ) : null}

      {feed.isEmpty && !feed.error ? (
        <section className="surface-card mt-6 p-6 text-center" data-testid="notifications-empty">
          <Bell className="mx-auto size-10 text-brand-ink" aria-hidden="true" />
          <h2 className="mt-3 text-xl font-extrabold">There is nothing new yet</h2>
          <p className="mt-2 text-base text-muted-foreground">
            Here you will see the confirmations of your transfers and the activity detected in your
            wallet.
          </p>
        </section>
      ) : null}

      <ul className="mt-5 space-y-3" aria-label="Recent activity">
        {feed.items.map((item) => (
          <li key={item.id}>
            <article
              className={`surface-card p-5 ${item.readAt === null ? "border-brand-ink/40" : ""}`}
              data-testid="notification-item"
              data-status={item.status}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-extrabold">{item.title}</h2>
                  {item.explanation ? (
                    <p className="mt-1 text-base text-muted-foreground">{item.explanation}</p>
                  ) : null}
                </div>
                {item.readAt === null ? (
                  <span className="rounded-full bg-primary/20 px-3 py-1 text-xs font-extrabold text-brand-ink">
                    New
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-sm font-bold text-muted-foreground">
                {formatDate(item.eventAt)}
              </p>
              {item.readAt === null ? (
                <Button
                  type="button"
                  variant="outline"
                  className="press mt-4 min-h-12 w-full"
                  onClick={() => void feed.markRead(item.id)}
                  aria-label={`Mark as read: ${item.title}`}
                >
                  <Check className="size-5" aria-hidden="true" />
                  Mark as read
                </Button>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
