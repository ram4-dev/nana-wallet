import naniEscuchando from "@/assets/nani/nani-escuchando.png";
import naniLista from "@/assets/nani/nani-lista.png";
import naniPensando from "@/assets/nani/nani-pensando.png";

/** Estados del agente que devuelve la API, mapeados a reacciones de Nani. */
export type AgenteEstado =
  "escuchando" | "pensando" | "esperando_confirmacion" | "listo" | "no_entendi";

const avatarForState: Record<AgenteEstado, { src: string; pose: string }> = {
  escuchando: { src: naniEscuchando, pose: "escuchando" },
  pensando: { src: naniPensando, pose: "pensando" },
  esperando_confirmacion: { src: naniLista, pose: "lista" },
  listo: { src: naniLista, pose: "lista" },
  no_entendi: { src: naniPensando, pose: "pensando" },
};

/** Lo que el lector de pantalla anuncia. La imagen interna es decorativa. */
const labelForState: Record<AgenteEstado, string> = {
  escuchando: "Nani te está escuchando",
  pensando: "Nani está pensando",
  esperando_confirmacion: "Nani espera que revises",
  listo: "Nani está lista para ayudarte",
  no_entendi: "Nani no te entendió bien",
};

type AgenteAvatarProps = {
  estado: AgenteEstado;
  /** Lado del cuadro en píxeles. La imagen se escala sola. */
  size?: number;
};

export function AgenteAvatar({ estado, size = 256 }: AgenteAvatarProps) {
  const avatar = avatarForState[estado];

  return (
    <span
      className="nani-avatar-frame"
      data-avatar-state={estado}
      role="img"
      aria-label={labelForState[estado]}
      style={{ width: size, height: size }}
    >
      <img
        src={avatar.src}
        alt=""
        className={`nani-avatar-image nani-avatar-image--${avatar.pose} breathe`}
        draggable={false}
      />
    </span>
  );
}
