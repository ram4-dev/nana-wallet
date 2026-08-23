import { useCallback, useRef, useState } from "react";

import { api, getErrorMessage } from "@/lib/api";

const MIC_UNSUPPORTED_MESSAGE = "Este dispositivo no permite grabar audio.";
const MIC_PERMISSION_DENIED_MESSAGE =
  "No pudimos usar el micrófono. Revisá los permisos y probá de nuevo.";

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Tap-to-start / tap-to-stop voice input: records, transcribes, then hands off the text. */
export function useVoiceRecorder(
  onTranscribed: (text: string) => void,
  onError: (message: string) => void,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      setIsTranscribing(true);
      try {
        const text = await api.transcribeAudio(blob);
        if (text.trim()) {
          onTranscribed(text.trim());
        } else {
          onError("No te escuché bien. Probá de nuevo.");
        }
      } catch (error) {
        onError(getErrorMessage(error));
      } finally {
        setIsTranscribing(false);
      }
    },
    [onError, onTranscribed],
  );

  const startRecording = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError(MIC_UNSUPPORTED_MESSAGE);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: mimeType ?? "audio/webm" });
        chunksRef.current = [];
        void transcribe(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      onError(MIC_PERMISSION_DENIED_MESSAGE);
    }
  }, [onError, stopStream, transcribe]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
  }, []);

  const toggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return { isRecording, isTranscribing, toggle };
}
