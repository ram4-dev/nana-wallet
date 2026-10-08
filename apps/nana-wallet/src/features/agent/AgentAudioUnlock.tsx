import { Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export type AgentAudioUnlockProps = {
  /** True while the browser holds Nani's voice behind a user gesture. */
  blocked: boolean;
  /** Nani's opening turn as the room transcribed it, shown while her voice cannot play. */
  intro?: string | null;
  onUnlock: () => void;
};

/**
 * Visible degradation for a browser that blocks remote audio: the user reads
 * what Nani is saying and unlocks the playback with one tap.
 */
export function AgentAudioUnlock({ blocked, intro, onUnlock }: AgentAudioUnlockProps) {
  if (!blocked) return null;

  return (
    <section
      className="mt-3 w-full shrink-0 rounded-2xl border border-border bg-warning-surface p-4 text-warning-surface-foreground"
      role="status"
    >
      <p className="font-extrabold">Tu navegador bloqueó el audio de Nani</p>
      <p className="mt-1 text-sm font-bold">
        Te dejo por escrito lo que te está diciendo. Con un toque la escuchás.
      </p>
      {intro ? (
        <div className="mt-3 rounded-2xl bg-card px-4 py-3">
          <p className="text-sm font-bold text-muted-foreground">Nani dijo:</p>
          <p className="mt-0.5 text-base font-extrabold">“{intro}”</p>
        </div>
      ) : null}
      <Button
        type="button"
        className="press mt-3 min-h-12 w-full font-extrabold"
        onClick={onUnlock}
      >
        <Volume2 className="size-5" strokeWidth={2.4} />
        Escuchar a Nani
      </Button>
    </section>
  );
}
