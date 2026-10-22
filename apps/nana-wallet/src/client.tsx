import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

async function enableDevelopmentMocks() {
  if (!import.meta.env.DEV) return;
  // PMU-025: the browser E2E harness exercises the REAL fixture backend, so it
  // opts out of the dev MSW worker via VITE_E2E_REAL_BACKEND. Not reachable in
  // production (DEV guard) and not selectable in unit tests.
  if (import.meta.env["VITE_E2E_REAL_BACKEND"] === "1") {
    if ("serviceWorker" in navigator) {
      const { removeDevelopmentMockWorker } = await import("./lib/development-mocks");
      if (await removeDevelopmentMockWorker(navigator.serviceWorker)) window.location.reload();
    }
    return;
  }
  const { worker } = await import("./mocks/browser");
  await worker.start({ onUnhandledRequest: "bypass" });
}

await enableDevelopmentMocks();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
