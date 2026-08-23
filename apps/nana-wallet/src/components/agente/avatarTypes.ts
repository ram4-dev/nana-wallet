export type EyeMotion = "none" | "microSaccades" | "shake";
export type BodyMotion = "none" | "slowDrift" | "shake";
export type TransitionKind = "spring" | "smooth" | "snappy";
export type PlaybackMode = "loop" | "once" | "pingPong";

export type Surface = {
  type: string;
  width: number;
  height: number;
  depth: number;
  roundness: number;
};

export type BodyNode = {
  surface: Surface;
  position: [number, number, number];
  rotation: [number, number, number];
};

export type EyeShape = {
  width: number;
  height: number;
  x: number;
  y: number;
  angle: number;
};

export type AvatarExpression = {
  head: { x: number; y: number; z: number };
  eyes: { left: EyeShape; right: EyeShape; spacing: number };
  perspective: number;
  motion: { eyes: EyeMotion; body: BodyMotion };
  colors?: { body?: string; eyes?: string };
};

export type BlinkConfig = {
  enabled: boolean;
  initialDelayMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  durationMs: number;
};

export type AvatarAnimation = {
  playbackMode: PlaybackMode;
  steps: Array<{
    expression: string;
    holdMs: number;
    transitionMs: number;
    transition: TransitionKind;
  }>;
  blink: BlinkConfig;
  metadata?: { label?: string; description?: string; group?: string };
};

export type AvatarDefinition = {
  schema: string;
  schemaVersion: number;
  name: string;
  body: { primary: Surface; nodes: BodyNode[] };
  colors: { body: string; eyes: string };
  expressions: Record<string, AvatarExpression>;
  expressionOrder: string[];
  animations: Record<string, AvatarAnimation>;
  animationOrder: string[];
};

/**
 * Forma plana de una expresión, que es sobre la que interpolamos.
 * Interpolar campo por campo sobre números sueltos es mucho más simple
 * que interpolar el objeto anidado.
 */
export type FlatExpression = {
  headX: number;
  headY: number;
  headZ: number;
  widthLeft: number;
  widthRight: number;
  heightLeft: number;
  heightRight: number;
  spacing: number;
  positionXLeft: number;
  positionXRight: number;
  positionYLeft: number;
  positionYRight: number;
  leftAngle: number;
  rightAngle: number;
  perspective: number;
  eyeMotion: EyeMotion;
  bodyMotion: BodyMotion;
};

export const flattenExpression = (expression: AvatarExpression): FlatExpression => ({
  headX: expression.head.x,
  headY: expression.head.y,
  headZ: expression.head.z,
  widthLeft: expression.eyes.left.width,
  widthRight: expression.eyes.right.width,
  heightLeft: expression.eyes.left.height,
  heightRight: expression.eyes.right.height,
  spacing: expression.eyes.spacing,
  positionXLeft: expression.eyes.left.x,
  positionXRight: expression.eyes.right.x,
  positionYLeft: expression.eyes.left.y,
  positionYRight: expression.eyes.right.y,
  leftAngle: expression.eyes.left.angle,
  rightAngle: expression.eyes.right.angle,
  perspective: expression.perspective,
  eyeMotion: expression.motion.eyes,
  bodyMotion: expression.motion.body,
});

/** Los campos numéricos, que son los únicos que se interpolan. */
export const numericFields = [
  "headX",
  "headY",
  "headZ",
  "widthLeft",
  "widthRight",
  "heightLeft",
  "heightRight",
  "spacing",
  "positionXLeft",
  "positionXRight",
  "positionYLeft",
  "positionYRight",
  "leftAngle",
  "rightAngle",
  "perspective",
] as const satisfies readonly (keyof FlatExpression)[];
