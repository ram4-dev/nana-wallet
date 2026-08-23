import { Link, useRouterState } from "@tanstack/react-router";
import { User, Wallet, Sparkles } from "lucide-react";

export function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur-md"
      aria-label="Navegación principal"
    >
      <div className="relative mx-auto flex h-[76px] max-w-md items-center justify-between px-7 pt-1 pb-2">
        <Link
          to="/perfil"
          className="press flex h-14 w-20 flex-col items-center justify-center gap-0.5 rounded-2xl py-1 text-muted-foreground [&.active]:text-primary"
          activeProps={{ className: "active bg-secondary" }}
          aria-current={pathname === "/perfil" ? "page" : undefined}
        >
          <User className="size-6" strokeWidth={2.4} />
          <span className="text-sm font-extrabold">Mi perfil</span>
        </Link>

        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="press plastic absolute -top-9 left-1/2 flex size-24 -translate-x-1/2 flex-col items-center justify-center gap-1 rounded-full"
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <Sparkles className="size-9" strokeWidth={2.4} />
          <span className="text-base font-extrabold">Agente</span>
        </Link>

        <Link
          to="/mi-plata"
          className="press flex h-14 w-20 flex-col items-center justify-center gap-0.5 rounded-2xl py-1 text-muted-foreground [&.active]:text-primary"
          activeProps={{ className: "active bg-secondary" }}
          aria-current={pathname === "/mi-plata" ? "page" : undefined}
        >
          <Wallet className="size-6" strokeWidth={2.4} />
          <span className="text-sm font-extrabold">Mi plata</span>
        </Link>
      </div>
    </nav>
  );
}
