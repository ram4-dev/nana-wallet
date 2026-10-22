/** Retira sólo MSW; conserva cualquier otro service worker del origen. */
export async function removeDevelopmentMockWorker(
  workers: Pick<ServiceWorkerContainer, "getRegistrations" | "controller">,
): Promise<boolean> {
  const isMock = (worker: ServiceWorker | null) =>
    worker !== null && new URL(worker.scriptURL).pathname.endsWith("/mockServiceWorker.js");
  let removed = false;
  for (const registration of await workers.getRegistrations()) {
    if ([registration.active, registration.waiting, registration.installing].some(isMock)) {
      removed = (await registration.unregister()) || removed;
    }
  }
  // El controlador de esta página sobrevive al unregister hasta una navegación.
  return removed && isMock(workers.controller);
}
