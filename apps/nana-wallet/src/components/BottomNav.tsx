import { Link, useRouterState } from "@tanstack/react-router";
import { Sparkles, User, Wallet } from "lucide-react";

/**
 * LuckGnome-structure pill nav (owner decision 2026-10-07): floating pill with
 * the voice orb raised at the center, Nana violet palette and Nani branding.
 */
export function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const itemClass = "lg-nav-item press";

  return (
    <nav className="lg-pill-nav" aria-label="Navegación principal">
      <Link
        to="/mi-plata"
        className={itemClass}
        data-active={pathname === "/mi-plata"}
        aria-current={pathname === "/mi-plata" ? "page" : undefined}
      >
        <Wallet strokeWidth={2.4} aria-hidden="true" />
        <span>Billetera</span>
      </Link>

      <div className="lg-nav-voice-wrap">
        <Link
          to="/"
          className="lg-nav-voice press"
          aria-label="Nani"
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <Sparkles className="size-8 text-primary" strokeWidth={2.2} aria-hidden="true" />
        </Link>
        <span className="sr-only">Voz</span>
      </div>

      <Link
        to="/perfil"
        className={itemClass}
        data-active={pathname === "/perfil" || pathname === "/notificaciones"}
        aria-current={pathname === "/perfil" ? "page" : undefined}
      >
        <User strokeWidth={2.4} aria-hidden="true" />
        <span>Perfil</span>
      </Link>
    </nav>
  );
}
