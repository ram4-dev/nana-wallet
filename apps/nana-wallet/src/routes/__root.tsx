import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { BottomNav } from "../components/BottomNav";
import { Button } from "../components/ui/button";
import { Toaster } from "../components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="surface-card max-w-md p-7 text-center">
        <h1 className="text-3xl font-extrabold text-foreground">Acá no hay nada para ver</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
          No hiciste nada mal. Puede ser que este lugar haya cambiado.
        </p>
        <Button asChild className="press mt-7 min-h-16 w-full text-lg font-extrabold">
          <Link to="/">Volver al inicio</Link>
        </Button>
      </div>
    </div>
  );
}

function ErrorComponent({ error }: { error: Error; reset: () => void }) {
  if (import.meta.env.DEV) console.error(error);
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="surface-card max-w-md p-7 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
          Esta parte no cargó
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
          No es culpa tuya. Algo falló de este lado y tu plata sigue segura.
        </p>
        <Button asChild className="press mt-7 min-h-16 w-full text-lg font-extrabold">
          <a href="/">Volver al inicio</a>
        </Button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Nana Wallet" },
      {
        name: "description",
        content: "Wallet agéntica y accesible para personas mayores y personas con discapacidad.",
      },
      { property: "og:title", content: "Nana Wallet" },
      {
        property: "og:description",
        content: "Pagar, transferir y organizar la vida financiera con ayuda de un agente.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800;900&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <BottomNav />
      <Toaster position="top-center" closeButton />
    </QueryClientProvider>
  );
}
