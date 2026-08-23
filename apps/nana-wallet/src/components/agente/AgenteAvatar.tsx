import { useMemo } from "react";

import type { AvatarDefinition } from "./avatarTypes";
import {
  eyePath,
  projectNode,
  quaternionFromEuler,
  sphereSilhouetteRadius,
} from "./avatarGeometry";
import cloudeeDefinition from "./cloudee.avatar.json";
import { useAvatarPlayer } from "./useAvatarPlayer";

const cloudee = cloudeeDefinition as unknown as AvatarDefinition;

/** Estados del agente que devuelve la API, mapeados a animaciones del avatar. */
export type AgenteEstado =
  "escuchando" | "pensando" | "esperando_confirmacion" | "listo" | "no_entendi";

const animationForState: Record<AgenteEstado, string> = {
  escuchando: "listening",
  pensando: "thinking",
  esperando_confirmacion: "curious",
  listo: "idle",
  no_entendi: "confused",
};

/** Lo que el lector de pantalla anuncia. El avatar en sí es decorativo. */
const labelForState: Record<AgenteEstado, string> = {
  escuchando: "El agente te está escuchando",
  pensando: "El agente está pensando",
  esperando_confirmacion: "El agente espera que revises",
  listo: "El agente está listo para ayudarte",
  no_entendi: "El agente no te entendió bien",
};

const radians = (degrees: number) => (degrees * Math.PI) / 180;

type AgenteAvatarProps = {
  estado: AgenteEstado;
  /** Lado del cuadro en píxeles. El dibujo se escala solo. */
  size?: number;
  definition?: AvatarDefinition;
};

export function AgenteAvatar({ estado, size = 256, definition = cloudee }: AgenteAvatarProps) {
  const animationKey = animationForState[estado];
  const frame = useAvatarPlayer(definition, animationKey);
  const { expression, blink, bodyOffset, eyeOffset, inclinacionAcento } = frame;

  const orientation = useMemo(
    () =>
      quaternionFromEuler(
        radians(expression.headX),
        radians(expression.headY),
        radians(expression.headZ + inclinacionAcento),
      ),
    [expression.headX, expression.headY, expression.headZ, inclinacionAcento],
  );

  const primary = definition.body.primary;
  const bodyRadiusX = sphereSilhouetteRadius(primary.width / 2, expression.perspective);
  const bodyRadiusY = sphereSilhouetteRadius(primary.height / 2, expression.perspective);

  const nodes = definition.body.nodes.map((node) =>
    projectNode(node, orientation, expression.perspective),
  );
  const behindNodes = nodes.filter((node) => node.behind);
  const frontNodes = nodes.filter((node) => !node.behind);

  const leftEye = eyePath(expression, orientation, primary, -1, blink, eyeOffset);
  const rightEye = eyePath(expression, orientation, primary, 1, blink, eyeOffset);

  // El viewBox se calcula desde el cuerpo, así que un avatar más grande
  // o más chico entra igual sin tocar nada.
  const extent = Math.max(bodyRadiusX, bodyRadiusY) * 1.9;

  const bodyColor = definition.colors.body;
  const eyeColor = definition.colors.eyes;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
      role="img"
      aria-label={labelForState[estado]}
      style={{ overflow: "visible" }}
    >
      <g transform={`translate(${bodyOffset.x} ${bodyOffset.y})`}>
        {behindNodes.map((node, index) => (
          <ellipse
            key={`atras-${index}`}
            cx={node.cx}
            cy={node.cy}
            rx={node.rx}
            ry={node.ry}
            transform={`rotate(${node.rotation} ${node.cx} ${node.cy})`}
            fill={bodyColor}
          />
        ))}

        <ellipse cx={0} cy={0} rx={bodyRadiusX} ry={bodyRadiusY} fill={bodyColor} />

        {frontNodes.map((node, index) => (
          <ellipse
            key={`adelante-${index}`}
            cx={node.cx}
            cy={node.cy}
            rx={node.rx}
            ry={node.ry}
            transform={`rotate(${node.rotation} ${node.cx} ${node.cy})`}
            fill={bodyColor}
          />
        ))}

        {leftEye ? <path d={leftEye} fill={eyeColor} /> : null}
        {rightEye ? <path d={rightEye} fill={eyeColor} /> : null}
      </g>
    </svg>
  );
}
