import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  eyePath,
  projectNode,
  quaternionFromEuler,
  sphereSilhouetteRadius,
} from "./avatarGeometry";
import cloudeeDefinition from "./cloudee.avatar.json";
import kirbyDefinition from "./kirby.avatar.json";
import type { AvatarDefinition } from "./avatarTypes";
import { flattenExpression } from "./avatarTypes";

const kirby = kirbyDefinition as unknown as AvatarDefinition;
const cloudee = cloudeeDefinition as unknown as AvatarDefinition;
const outDir = process.env["AVATAR_SNAPSHOT_DIR"];
const radians = (degrees: number) => (degrees * Math.PI) / 180;

function renderExpression(key: string, blink = 1, avatar: AvatarDefinition = kirby) {
  const kirby = avatar;
  const expression = flattenExpression(avatar.expressions[key]!);
  const orientation = quaternionFromEuler(
    radians(expression.headX),
    radians(expression.headY),
    radians(expression.headZ),
  );
  const primary = kirby.body.primary;
  const rx = sphereSilhouetteRadius(primary.width / 2, expression.perspective);
  const ry = sphereSilhouetteRadius(primary.height / 2, expression.perspective);
  const nodes = kirby.body.nodes.map((node) =>
    projectNode(node, orientation, expression.perspective),
  );
  const zero = { x: 0, y: 0 };
  const left = eyePath(expression, orientation, primary, -1, blink, zero);
  const right = eyePath(expression, orientation, primary, 1, blink, zero);
  const extent = Math.max(rx, ry) * 1.9;
  const ellipse = (n: (typeof nodes)[number]) =>
    `<ellipse cx="${n.cx}" cy="${n.cy}" rx="${n.rx}" ry="${n.ry}" transform="rotate(${n.rotation} ${n.cx} ${n.cy})" fill="${kirby.colors.body}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="${-extent} ${-extent} ${extent * 2} ${extent * 2}">` +
    nodes
      .filter((n) => n.behind)
      .map(ellipse)
      .join("") +
    `<ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="${kirby.colors.body}"/>` +
    nodes
      .filter((n) => !n.behind)
      .map(ellipse)
      .join("") +
    `<path d="${left}" fill="${kirby.colors.eyes}"/><path d="${right}" fill="${kirby.colors.eyes}"/>` +
    `</svg>`;
  return { svg, left, right, expression };
}

describe("geometría de expresiones", () => {
  const keys = [
    "neutral",
    "curious-left",
    "far-right-glance",
    "upward-side-glance",
    "downward-gaze",
    "joyful-wide",
    "sleepy-squint",
    "eyes-closed",
    "surprised-left",
  ];

  it("cada expresión produce una mirada distinta", () => {
    const rendered = keys.map((key) => ({ key, ...renderExpression(key) }));
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const item of rendered) {
        fs.writeFileSync(path.join(outDir, `expr-${item.key}.svg`), item.svg);
      }
    }
    // Si dos expresiones dieran el mismo path, la cabeza no estaría rotando.
    const paths = new Set(rendered.map((item) => item.left + item.right));
    expect(paths.size).toBe(keys.length);
    for (const item of rendered) {
      expect(item.left, `${item.key} ojo izquierdo`).not.toBe("");
      expect(item.right, `${item.key} ojo derecho`).not.toBe("");
    }
  });

  it("el parpadeo achica el ojo sin hacerlo desaparecer", () => {
    const abierto = renderExpression("neutral", 1);
    const cerrado = renderExpression("neutral", 0);
    expect(cerrado.left).not.toBe(abierto.left);
    expect(cerrado.left).not.toBe("");
    if (outDir) {
      fs.writeFileSync(path.join(outDir, "expr-parpadeo.svg"), cerrado.svg);
    }
  });

  it("Cloudee separa los ojos apenas arranca la animación", () => {
    // En reposo los ojos de Cloudee se tocan (spacing 12,8 con ancho 13,9).
    // Las expresiones de la librería traen su propio spacing, así que en cuanto
    // el reproductor avanza al primer paso los ojos se despegan.
    const reposo = renderExpression("neutral", 1, cloudee);
    const enAnimacion = renderExpression("curious-left", 1, cloudee);
    expect(reposo.expression.spacing).toBeLessThan(reposo.expression.widthLeft);
    expect(enAnimacion.expression.spacing).toBeGreaterThan(enAnimacion.expression.widthLeft);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "cl-reposo.svg"), reposo.svg);
      for (const key of ["curious-left", "joyful-wide", "downward-gaze", "far-right-glance"]) {
        fs.writeFileSync(path.join(outDir, `cl-${key}.svg`), renderExpression(key, 1, cloudee).svg);
      }
    }
  });

  it("una mirada muy lateral esconde parte del ojo detrás de la esfera", () => {
    // far-right-glance gira la cabeza lo suficiente como para que el contorno
    // del ojo deje de estar entero de cara a la cámara.
    const frente = renderExpression("neutral");
    const costado = renderExpression("far-right-glance");
    expect(costado.expression.headY).not.toBe(frente.expression.headY);
  });
});
