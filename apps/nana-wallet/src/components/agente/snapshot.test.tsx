import { render } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AgenteAvatar, type AgenteEstado } from "./AgenteAvatar";
import kirbyDefinition from "./kirby.avatar.json";
import type { AvatarDefinition } from "./avatarTypes";

const outDir = process.env["AVATAR_SNAPSHOT_DIR"];

/**
 * No es un test de regresión: es una herramienta de inspección visual.
 * Solo escribe archivos cuando se le pasa AVATAR_SNAPSHOT_DIR, así que en
 * una corrida normal se limita a comprobar que el avatar dibuja algo.
 */
describe("AgenteAvatar", () => {
  const estados: AgenteEstado[] = [
    "listo",
    "escuchando",
    "pensando",
    "esperando_confirmacion",
    "no_entendi",
  ];

  it("dibuja cuerpo y ojos en todos los estados", () => {
    for (const estado of estados) {
      const { container, unmount } = render(<AgenteAvatar estado={estado} />);
      const svg = container.querySelector("svg");
      expect(svg, estado).not.toBeNull();
      // Cuerpo mas los cuatro bultos de Cloudee, que es el avatar por defecto.
      expect(svg!.querySelectorAll("ellipse").length, estado).toBe(5);
      // Los dos ojos, que se dibujan como paths envueltos sobre la esfera.
      expect(svg!.querySelectorAll("path").length, estado).toBe(2);
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `cloudee-${estado}.svg`), svg!.outerHTML);
      }
      unmount();
    }
  });

  it("tambien dibuja Kirby, que tiene dos nodos en vez de cuatro", () => {
    const kirby = kirbyDefinition as unknown as AvatarDefinition;
    const { container } = render(<AgenteAvatar estado="listo" definition={kirby} />);
    const svg = container.querySelector("svg");
    expect(svg!.querySelectorAll("ellipse").length).toBe(3);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "kirby-listo.svg"), svg!.outerHTML);
    }
  });
});
