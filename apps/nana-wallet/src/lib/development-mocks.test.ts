import { describe, expect, it, vi } from "vitest";
import { removeDevelopmentMockWorker } from "./development-mocks";

describe("limpieza de MSW al usar el backend real", () => {
  it("retira MSW y pide una navegación si controla la página", async () => {
    const mock = {
      scriptURL: "https://nana-privy.localhost/mockServiceWorker.js",
    } as ServiceWorker;
    const unregister = vi.fn().mockResolvedValue(true);
    const otherUnregister = vi.fn();
    const registrations = [
      { active: mock, waiting: null, installing: null, unregister },
      {
        active: { scriptURL: "https://nana-privy.localhost/offline.js" },
        waiting: null,
        installing: null,
        unregister: otherUnregister,
      },
    ] as unknown as ServiceWorkerRegistration[];
    expect(
      await removeDevelopmentMockWorker({
        controller: mock,
        getRegistrations: async () => registrations,
      }),
    ).toBe(true);
    expect(unregister).toHaveBeenCalledOnce();
    expect(otherUnregister).not.toHaveBeenCalled();
  });

  it("no pide otra navegación después de retirar el registro", async () => {
    expect(
      await removeDevelopmentMockWorker({ controller: null, getRegistrations: async () => [] }),
    ).toBe(false);
  });
});
