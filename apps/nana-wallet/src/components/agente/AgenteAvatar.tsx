import naniEscuchando from "@/assets/nani/nani-escuchando.png";
import naniLista from "@/assets/nani/nani-lista.png";
import naniPensando from "@/assets/nani/nani-pensando.png";
import type { LiveVoiceState } from "@/features/agent/voice/live-voice-reducer";

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
  escuchando: "Nani is listening to you",
  pensando: "Nani is thinking",
  esperando_confirmacion: "Nani is waiting for you to review",
  listo: "Nani is ready to help you",
  no_entendi: "Nani did not quite understand you",
};

type AgenteAvatarProps = {
  estado: AgenteEstado;
  livePhase?: LiveVoiceState["phase"];
  /** Lado del cuadro en píxeles. La imagen se escala sola. */
  size?: number;
};

export function AgenteAvatar({ estado, livePhase, size = 256 }: AgenteAvatarProps) {
  const avatar = avatarForState[estado];
  const liveLabel = {
    speaking: "Nani is speaking",
    muted: "Microphone paused",
    reconnecting: "Nani is reconnecting",
    paused: "Session paused",
    thinking: "Nani is thinking",
    request_waiting: "Your request is waiting",
    connecting: "Nani is connecting",
    binding: "Nani is preparing the conversation",
    failed: "Nani's voice is not available",
    listening: "Nani is listening to you",
    idle: labelForState[estado],
  } satisfies Record<LiveVoiceState["phase"], string>;

  return (
    <span
      className="nani-avatar-frame"
      data-avatar-state={estado}
      role="img"
      aria-label={livePhase ? liveLabel[livePhase] : labelForState[estado]}
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
