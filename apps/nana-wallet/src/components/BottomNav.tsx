import { Link } from "@tanstack/react-router";
import { User, Wallet, Sparkles } from "lucide-react";

export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-md items-end justify-between gap-2 px-6 pt-3 pb-5">
        <Link
          to="/perfil"
          className="press flex w-24 flex-col items-center gap-1 rounded-2xl py-3 text-muted-foreground [&.active]:text-primary"
          activeProps={{ className: "active bg-secondary" }}
        >
          <User className="size-7" strokeWidth={2.4} />
          <span className="text-sm font-bold">Mi perfil</span>
        </Link>

        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="press plastic -mt-10 flex size-24 flex-col items-center justify-center gap-1 rounded-full"
        >
          <Sparkles className="size-9" strokeWidth={2.4} />
          <span className="text-sm font-extrabold">Agente</span>
        </Link>

        <Link
          to="/portfolio"
          className="press flex w-24 flex-col items-center gap-1 rounded-2xl py-3 text-muted-foreground [&.active]:text-primary"
          activeProps={{ className: "active bg-secondary" }}
        >
          <Wallet className="size-7" strokeWidth={2.4} />
          <span className="text-sm font-bold">Mi plata</span>
        </Link>
      </div>
    </nav>
  );
}
