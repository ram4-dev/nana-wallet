import { useEffect, useRef, useState } from "react";

import type {
  AvatarAnimation,
  AvatarDefinition,
  FlatExpression,
  TransitionKind,
} from "./avatarTypes";
import { flattenExpression, numericFields } from "./avatarTypes";

/* Motricidad ambiente ------------------------------------------------------ */

const smoothstep = (value: number) => value * value * (3 - 2 * value);

/** Ruido determinístico. No usamos Math.random para que el movimiento sea reproducible. */
const hash = (value: number) => {
  const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return (raw - Math.floor(raw)) * 2 - 1;
};

const smoothNoise = (elapsedMs: number, axis: number, seed: number, interval: number) => {
  const progress = elapsedMs / interval;
  const step = Math.floor(progress);
  const blend = smoothstep(progress - step);
  const previous = hash(step * 3 + axis + seed);
  const next = hash((step + 1) * 3 + axis + seed);
  return previous + (next - previous) * blend;
};

/** Sacada ocular: un salto corto cada 1,1 s, resuelto en 140 ms. */
const saccade = (elapsedMs: number, axis: number, seed: number) => {
  if (elapsedMs <= 0) return 0;
  const interval = 1100;
  const duration = 140;
  const step = Math.floor(elapsedMs / interval);
  const progress = (elapsedMs - step * interval) / duration;
  const blend = smoothstep(Math.min(progress, 1));
  const previous = step === 0 ? 0 : hash((step - 1) * 2 + axis + seed);
  const next = hash(step * 2 + axis + seed);
  return previous + (next - previous) * blend;
};

const EYE_SEED = 17.29;
const seedOf = (expression: FlatExpression) =>
  expression.headX * 0.71 + expression.headY * 1.13 + expression.headZ * 1.37;

const INTERVALO_MINIMO_ACENTO_MS = 10_000;
const INTERVALO_MAXIMO_ACENTO_MS = 20_000;
const DURACION_ACENTO_MS = 1_100;
const MARGEN_TRANSICION_ACENTO_MS = 80;
const AMPLITUD_ACENTO_GRADOS = 3;

const intervaloAcento = (secuencia: number, semilla: number) => {
  const muestra = (hash(semilla + secuencia * 47.13 + 89.71) + 1) / 2;
  return (
    INTERVALO_MINIMO_ACENTO_MS + muestra * (INTERVALO_MAXIMO_ACENTO_MS - INTERVALO_MINIMO_ACENTO_MS)
  );
};

const direccionAcento = (secuencia: number, semilla: number) =>
  hash(semilla + secuencia * 31.37 + 53.19) >= 0 ? 1 : -1;

/** Inclinación corta, con entrada y salida suaves para volver sin cortes. */
const inclinacionAcento = (transcurridoMs: number, direccion: number) => {
  const progreso = Math.min(1, Math.max(0, transcurridoMs / DURACION_ACENTO_MS));
  const pulso = Math.sin(Math.PI * smoothstep(progreso));
  return direccion * AMPLITUD_ACENTO_GRADOS * pulso;
};

const bodyOffsetOf = (expression: FlatExpression, elapsedMs: number) => {
  const seed = seedOf(expression);
  if (expression.bodyMotion === "slowDrift") {
    return {
      x: smoothNoise(elapsedMs, 3, seed, 2900) * 1.45,
      y: smoothNoise(elapsedMs, 4, seed, 3700) * 1.1,
    };
  }
  if (expression.bodyMotion === "shake") {
    const time = elapsedMs / 1000;
    return {
      x: (Math.sin(time * 31) + Math.sin(time * 53) * 0.45) * 1.35,
      y: (Math.sin(time * 37) + Math.sin(time * 61) * 0.4) * 1.1,
    };
  }
  return { x: 0, y: 0 };
};

const eyeOffsetOf = (expression: FlatExpression, elapsedMs: number) => {
  if (expression.eyeMotion === "microSaccades") {
    return {
      x: saccade(elapsedMs, 0, EYE_SEED) * 1.5,
      y: saccade(elapsedMs, 1, EYE_SEED) * 0.9,
    };
  }
  if (expression.eyeMotion === "shake") {
    const time = elapsedMs / 1000;
    return { x: Math.sin(time * 43) * 1.2, y: Math.sin(time * 57) * 0.8 };
  }
  return { x: 0, y: 0 };
};

/* Transiciones ------------------------------------------------------------- */

const easings: Record<TransitionKind, (t: number) => number> = {
  smooth: smoothstep,
  snappy: (t) => 1 - (1 - t) ** 3,
  // Sobrepasa y vuelve, que es lo que da la sensación elástica.
  spring: (t) => {
    const c = 1.70158 * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
  },
};

/** Evita que un giro de 350 grados se interpole por el camino largo. */
const nearestAngle = (target: number, from: number) => {
  let candidate = target;
  while (candidate - from > 180) candidate -= 360;
  while (candidate - from < -180) candidate += 360;
  return candidate;
};

const angleFields = new Set(["headX", "headY", "headZ", "leftAngle", "rightAngle"]);

const interpolate = (from: FlatExpression, to: FlatExpression, progress: number) => {
  const result: FlatExpression = { ...from };
  for (const field of numericFields) {
    const target = angleFields.has(field) ? nearestAngle(to[field], from[field]) : to[field];
    result[field] = from[field] + (target - from[field]) * progress;
  }
  result.eyeMotion = progress > 0.5 ? to.eyeMotion : from.eyeMotion;
  result.bodyMotion = progress > 0.5 ? to.bodyMotion : from.bodyMotion;
  return result;
};

/* Reproductor -------------------------------------------------------------- */

export type AvatarFrame = {
  expression: FlatExpression;
  blink: number;
  bodyOffset: { x: number; y: number };
  eyeOffset: { x: number; y: number };
  inclinacionAcento: number;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Reproduce una animación del .avatar.json sobre un requestAnimationFrame.
 * Cada paso mantiene una expresión durante holdMs y después transiciona a la
 * siguiente durante transitionMs. El parpadeo corre en su propio reloj, con
 * intervalos aleatorios entre minIntervalMs y maxIntervalMs.
 */
export function useAvatarPlayer(definition: AvatarDefinition, animationKey: string): AvatarFrame {
  const neutral = flattenExpression(
    definition.expressions["neutral"] ?? Object.values(definition.expressions)[0]!,
  );
  // Arranca ya en el primer paso de la animación, no en la pose de reposo.
  // En reposo algunos avatares tienen los ojos casi tocándose (Cloudee se
  // superpone 1,2px) y no queremos que eso se vea ni un cuadro.
  const [frame, setFrame] = useState<AvatarFrame>(() => {
    const firstStep = definition.animations[animationKey]?.steps[0];
    const firstExpression = firstStep ? definition.expressions[firstStep.expression] : undefined;
    return {
      expression: firstExpression ? flattenExpression(firstExpression) : neutral,
      blink: 1,
      bodyOffset: { x: 0, y: 0 },
      eyeOffset: { x: 0, y: 0 },
      inclinacionAcento: 0,
    };
  });
  const animationRef = useRef<AvatarAnimation | undefined>(undefined);
  animationRef.current = definition.animations[animationKey];

  useEffect(() => {
    const animation = definition.animations[animationKey];
    const still = prefersReducedMotion();

    const stepExpression = (index: number) => {
      const step = animation?.steps[index];
      const expression = step ? definition.expressions[step.expression] : undefined;
      return expression ? flattenExpression(expression) : neutral;
    };

    if (!animation || animation.steps.length === 0 || still) {
      // Sin animación o con movimiento reducido: primera expresión, quieta.
      setFrame({
        expression: stepExpression(0),
        blink: 1,
        bodyOffset: { x: 0, y: 0 },
        eyeOffset: { x: 0, y: 0 },
        inclinacionAcento: 0,
      });
      return;
    }

    const stepCount = animation.steps.length;
    let index = 0;
    let direction = 1;
    let phaseStart = performance.now();
    let inTransition = false;
    let finished = false;

    const blink = animation.blink;
    let nextBlinkAt = phaseStart + blink.initialDelayMs;
    let blinkStartedAt = 0;

    const semillaAcento = seedOf(stepExpression(0));
    let secuenciaAcento = 0;
    let proximoAcentoEn = phaseStart + intervaloAcento(secuenciaAcento, semillaAcento);
    let acentoIniciadoEn: number | null = null;
    let sentidoAcento = 1;

    const randomBlinkGap = () =>
      blink.minIntervalMs + Math.random() * Math.max(0, blink.maxIntervalMs - blink.minIntervalMs);

    let raf = 0;
    const tick = (now: number) => {
      const step = animation.steps[index]!;
      const elapsed = now - phaseStart;

      let expression: FlatExpression;
      if (!inTransition) {
        expression = stepExpression(index);
        if (!finished && elapsed >= step.holdMs) {
          const isLast = direction > 0 ? index === stepCount - 1 : index === 0;
          if (isLast && animation.playbackMode === "once") {
            finished = true;
          } else {
            inTransition = true;
            phaseStart = now;
          }
        }
      } else {
        const nextIndex =
          animation.playbackMode === "pingPong" ? index + direction : (index + 1) % stepCount;
        const from = stepExpression(index);
        const to = stepExpression(nextIndex < 0 || nextIndex >= stepCount ? index : nextIndex);
        const duration = Math.max(1, step.transitionMs);
        const progress = Math.min(1, elapsed / duration);
        expression = interpolate(from, to, easings[step.transition](progress));
        if (progress >= 1) {
          if (animation.playbackMode === "pingPong") {
            if (nextIndex <= 0 || nextIndex >= stepCount - 1) direction *= -1;
            index = Math.max(0, Math.min(stepCount - 1, nextIndex));
          } else {
            index = (index + 1) % stepCount;
          }
          inTransition = false;
          phaseStart = now;
        }
      }

      let blinkValue = 1;
      if (blink.enabled) {
        if (blinkStartedAt) {
          const blinkProgress = (now - blinkStartedAt) / blink.durationMs;
          if (blinkProgress >= 1) {
            blinkStartedAt = 0;
            nextBlinkAt = now + randomBlinkGap();
          } else {
            // Baja y sube: 0 en la mitad del parpadeo.
            blinkValue = Math.abs(Math.cos(blinkProgress * Math.PI));
          }
        } else if (now >= nextBlinkAt) {
          blinkStartedAt = now;
        }
      }

      let inclinacionActual = 0;
      if (acentoIniciadoEn !== null) {
        const transcurridoAcento = now - acentoIniciadoEn;
        if (transcurridoAcento >= DURACION_ACENTO_MS) {
          acentoIniciadoEn = null;
        } else {
          inclinacionActual = inclinacionAcento(transcurridoAcento, sentidoAcento);
        }
      } else if (now >= proximoAcentoEn && !inTransition) {
        const pasoActivo = animation.steps[index]!;
        const tiempoDisponible = finished
          ? Number.POSITIVE_INFINITY
          : pasoActivo.holdMs - (now - phaseStart);

        // Si el paso está por cambiar, esperamos a que la transición termine.
        if (tiempoDisponible >= DURACION_ACENTO_MS + MARGEN_TRANSICION_ACENTO_MS) {
          acentoIniciadoEn = now;
          sentidoAcento = direccionAcento(secuenciaAcento, semillaAcento);
          secuenciaAcento += 1;
          proximoAcentoEn = now + intervaloAcento(secuenciaAcento, semillaAcento);
        }
      }

      setFrame({
        expression,
        blink: blinkValue,
        bodyOffset: bodyOffsetOf(expression, now),
        eyeOffset: eyeOffsetOf(expression, now),
        inclinacionAcento: inclinacionActual,
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // neutral se deriva de definition, no hace falta como dependencia aparte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, animationKey]);

  return frame;
}
