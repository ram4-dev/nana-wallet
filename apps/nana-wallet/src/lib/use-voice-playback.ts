import { useCallback, useRef, useState } from "react";

import { api } from "@/lib/api";

const MUTED_STORAGE_KEY = "nana-wallet-voice-muted";

function readStoredMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Reads agent replies aloud through ElevenLabs TTS, with a persisted mute toggle. */
export function useVoicePlayback() {
  const [isMuted, setIsMuted] = useState(readStoredMuted);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleMuted = useCallback(() => {
    setIsMuted((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(MUTED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence only.
      }
      if (next) {
        audioRef.current?.pause();
      }
      return next;
    });
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (isMuted || !text.trim()) return;
      try {
        const blob = await api.speak(text);
        audioRef.current?.pause();
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.addEventListener("ended", () => URL.revokeObjectURL(audio.src), { once: true });
        await audio.play();
      } catch {
        // Silent failure: the reply is still shown as text, voice is a bonus.
      }
    },
    [isMuted],
  );

  return { isMuted, toggleMuted, speak };
}
