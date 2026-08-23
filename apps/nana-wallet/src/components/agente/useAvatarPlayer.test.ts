import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import cloudeeDefinition from "./cloudee.avatar.json";
import type { AvatarDefinition } from "./avatarTypes";
import { useAvatarPlayer } from "./useAvatarPlayer";

const cloudee = cloudeeDefinition as unknown as AvatarDefinition;

const definicionDePrueba: AvatarDefinition = {
  ...cloudee,
  animations: {
    ...cloudee.animations,
    "prueba-acento": {
      playbackMode: "loop",
      steps: [
        {
          expression: "neutral",
          holdMs: 60_000,
          transitionMs: 500,
          transition: "smooth",
        },
      ],
      blink: {
        enabled: false,
        initialDelayMs: 0,
        minIntervalMs: 0,
        maxIntervalMs: 0,
        durationMs: 1,
      },
    },
  },
};

const configurarFotogramas = () => {
  let ahora = 0;
  let proximoId = 1;
  const pendientes = new Map<number, FrameRequestCallback>();

  vi.spyOn(performance, "now").mockImplementation(() => ahora);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = proximoId;
      proximoId += 1;
      pendientes.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => pendientes.delete(id)),
  );

  return {
    avanzarA(instante: number) {
      ahora = instante;
      const fotogramas = [...pendientes.values()];
      pendientes.clear();
      for (const fotograma of fotogramas) fotograma(ahora);
    },
  };
};

const simularMovimientoReducido = (activo: boolean) => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: activo,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gesto de acento del avatar", () => {
  it("empieza dentro de una ventana de 10 a 20 segundos", () => {
    simularMovimientoReducido(false);
    const fotogramas = configurarFotogramas();
    const { result, unmount } = renderHook(() =>
      useAvatarPlayer(definicionDePrueba, "prueba-acento"),
    );

    act(() => fotogramas.avanzarA(9_999));
    expect(result.current.inclinacionAcento).toBe(0);

    let primerMovimiento: number | undefined;
    for (let instante = 10_000; instante <= 20_000; instante += 50) {
      act(() => fotogramas.avanzarA(instante));
      if (Math.abs(result.current.inclinacionAcento) > 0.01) {
        primerMovimiento = instante;
        break;
      }
    }

    expect(primerMovimiento).toBeGreaterThanOrEqual(10_000);
    expect(primerMovimiento).toBeLessThanOrEqual(20_000);
    unmount();
  });

  it("no se activa con movimiento reducido", () => {
    simularMovimientoReducido(true);
    const fotogramas = configurarFotogramas();
    const { result } = renderHook(() => useAvatarPlayer(definicionDePrueba, "prueba-acento"));

    act(() => fotogramas.avanzarA(20_000));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(result.current.inclinacionAcento).toBe(0);
  });
});
