import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function RoutePending({ label = "Estamos buscando tus datos" }: { label?: string }) {
  return (
    <main className="mx-auto min-h-screen max-w-md px-6 pt-12 pb-40" aria-label={label}>
      <Skeleton className="h-10 w-48" />
      <Skeleton className="mt-6 h-32 w-full rounded-3xl" />
      <Skeleton className="mt-10 h-8 w-56" />
      <div className="mt-4 space-y-4">
        <Skeleton className="h-24 w-full rounded-3xl" />
        <Skeleton className="h-24 w-full rounded-3xl" />
        <Skeleton className="h-24 w-full rounded-3xl" />
      </div>
      <span className="sr-only">{label}</span>
    </main>
  );
}

export function RouteError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof Error
      ? error.message
      : "Esta parte no cargó. No hiciste nada mal. Probá de nuevo.";

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6 pb-32">
      <section className="surface-card w-full p-6 text-center" role="alert">
        <AlertCircle className="mx-auto size-12 text-destructive" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-extrabold">No pudimos mostrar esta parte</h1>
        <p className="mt-3 text-lg text-muted-foreground">{message}</p>
        <Button className="press mt-6 min-h-16 w-full text-lg font-extrabold" onClick={onRetry}>
          Probar de nuevo
        </Button>
      </section>
    </main>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="surface-card mt-4 p-5 text-lg leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
