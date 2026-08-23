import type { BodyNode, FlatExpression, Surface } from "./avatarTypes";

/**
 * Renderer SVG propio, solo para cuerpos hechos de esferas, que es lo que son
 * Kirby y Cloudee. No soporta cubos, conos ni cápsulas: el motor original hace
 * proyección 3D genérica para 6 primitivas y por eso pesa lo que pesa.
 *
 * Convenciones (las mismas que el .avatar.json que consumimos):
 * - El radio de referencia de la cara es 120, sea cual sea el tamaño del cuerpo.
 * - La cámara está a 620 de distancia y la perspectiva se mezcla de 0 a 1.
 * - Los ojos se dibujan como un contorno de píldora envuelto sobre la esfera,
 *   punto por punto, y solo se ven los tramos cuya normal mira a la cámara.
 */
export const FACE_RADIUS = 120;
export const FOCAL_LENGTH = 620;

export type Point3 = [number, number, number];
export type Quaternion = [number, number, number, number];

const radians = (degrees: number) => (degrees * Math.PI) / 180;

const normalizeQuaternion = ([w, x, y, z]: Quaternion): Quaternion => {
  const length = Math.hypot(w, x, y, z) || 1;
  return [w / length, x / length, y / length, z / length];
};

const multiplyQuaternions = (a: Quaternion, b: Quaternion): Quaternion => {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return normalizeQuaternion([
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]);
};

const quaternionFromAxisAngle = ([x, y, z]: Point3, angle: number): Quaternion => {
  const half = angle / 2;
  const sine = Math.sin(half);
  return normalizeQuaternion([Math.cos(half), x * sine, y * sine, z * sine]);
};

/**
 * Orden de composición Z, X, Y. No es arbitrario: es el que usa el formato
 * del que vienen las expresiones. Cambiarlo hace que la mirada apunte mal.
 */
export const quaternionFromEuler = (x: number, y: number, z: number): Quaternion => {
  const rotX = quaternionFromAxisAngle([1, 0, 0], x);
  const rotY = quaternionFromAxisAngle([0, 1, 0], y);
  const rotZ = quaternionFromAxisAngle([0, 0, 1], z);
  return multiplyQuaternions(multiplyQuaternions(rotZ, rotX), rotY);
};

export const rotatePoint = ([w, x, y, z]: Quaternion, [px, py, pz]: Point3): Point3 => {
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx),
  ];
};

const project = ([x, y, z]: Point3, perspective: number): Point3 => {
  const denominator = FOCAL_LENGTH - z * perspective;
  const scale = Math.abs(denominator) < 0.0001 ? FOCAL_LENGTH / 0.0001 : FOCAL_LENGTH / denominator;
  return [x * scale, y * scale, z];
};

/** Envuelve una coordenada plana de la cara sobre la esfera, vía longitud y latitud. */
const faceCoordinates = (x: number, y: number): [number, number] => {
  const longitude = x / FACE_RADIUS;
  const latitude = y / FACE_RADIUS;
  return [FACE_RADIUS * Math.cos(latitude) * Math.sin(longitude), FACE_RADIUS * Math.sin(latitude)];
};

type SurfaceSample = { point: Point3; normal: Point3 };

const ellipsoidFrontSample = (
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
): SurfaceSample => {
  const remaining = Math.max(0, 1 - (x / (radiusX || 1)) ** 2 - (y / (radiusY || 1)) ** 2);
  const z = radiusZ * Math.sqrt(remaining);
  const nx = x / (radiusX * radiusX || 1);
  const ny = y / (radiusY * radiusY || 1);
  const nz = z / (radiusZ * radiusZ || 1);
  const length = Math.hypot(nx, ny, nz) || 1;
  return { point: [x, y, z], normal: [nx / length, ny / length, nz / length] };
};

/**
 * Contorno de píldora. El radio de esquina es el menor de los dos semiejes,
 * así que un ojo de 20 por 60 sale como una cápsula vertical, que es la forma
 * de los ojos de Kirby.
 */
const pillOutline = (width: number, height: number, samples = 56): Array<[number, number]> => {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const cornerRadius = Math.min(halfWidth, halfHeight);
  const straightY = Math.max(0, halfHeight - cornerRadius);
  const points: Array<[number, number]> = [];
  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    points.push([cosine * cornerRadius, sine * cornerRadius + Math.sign(sine) * straightY]);
  }
  // Ensancha horizontalmente si el ojo es más ancho que alto.
  const widthScale = halfWidth / (cornerRadius || 1);
  return points.map(([x, y]) => [x * widthScale, y]);
};

const toPath = (points: Point3[], close: boolean) => {
  const first = points[0];
  if (!first || points.length < 2) return "";
  const head = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  const body = points
    .slice(1)
    .map((point) => `L${point[0].toFixed(2)} ${point[1].toFixed(2)}`)
    .join("");
  return `${head}${body}${close ? "Z" : ""}`;
};

/**
 * Solo se dibujan los tramos del contorno cuya normal mira a la cámara.
 * Eso es lo que hace que un ojo desaparezca por el costado cuando la cabeza
 * gira, en vez de quedar pegado en el borde.
 */
const visibleSegments = (samples: Array<{ point: Point3; normal: Point3 }>) => {
  const segments: Point3[][] = [];
  let current: Point3[] = [];
  for (const sample of samples) {
    if (sample.normal[2] > 0) current.push(sample.point);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  const closed = segments.length === 1 && current.length === samples.length;
  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => toPath(segment, closed))
    .join("");
};

export type EyeOffset = { x: number; y: number };

export const eyePath = (
  expression: FlatExpression,
  orientation: Quaternion,
  surface: Surface,
  side: -1 | 1,
  blink: number,
  offset: EyeOffset,
): string => {
  const suffix = side < 0 ? "Left" : "Right";
  const width = expression[`width${suffix}` as const];
  const restingHeight = expression[`height${suffix}` as const];
  // El parpadeo no cierra a cero: deja una línea de 5, que es lo que se ve.
  const height = 5 + (restingHeight - 5) * blink;
  const centerX = (side * expression.spacing) / 2 + expression[`positionX${suffix}`] + offset.x;
  const centerY = expression[`positionY${suffix}`] + offset.y;
  const angle = radians(side < 0 ? expression.leftAngle : expression.rightAngle);
  const radiusX = surface.width / 2;
  const radiusY = surface.height / 2;
  const radiusZ = surface.depth / 2;

  const samples = pillOutline(width, height).map(([localX, localY]) => {
    const rotatedX = localX * Math.cos(angle) - localY * Math.sin(angle);
    const rotatedY = localX * Math.sin(angle) + localY * Math.cos(angle);
    const [faceX, faceY] = faceCoordinates(centerX + rotatedX, centerY + rotatedY);
    const sample = ellipsoidFrontSample(faceX, faceY, radiusX, radiusY, radiusZ);
    return {
      point: project(rotatePoint(orientation, sample.point), expression.perspective),
      normal: rotatePoint(orientation, sample.normal),
    };
  });

  return visibleSegments(samples);
};

/**
 * Silueta de una esfera vista en perspectiva. El borde visible no es el ecuador:
 * está un poco más cerca de la cámara, en z = r^2 / focal, y por eso el radio
 * proyectado es algo mayor que el radio real.
 */
export const sphereSilhouetteRadius = (radius: number, perspective: number) => {
  const rimZ = (radius * radius) / FOCAL_LENGTH;
  const rimRadius = radius * Math.sqrt(Math.max(0, 1 - (radius / FOCAL_LENGTH) ** 2));
  const denominator = FOCAL_LENGTH - rimZ * perspective;
  return (rimRadius * FOCAL_LENGTH) / (denominator || 1);
};

export type ProjectedNode = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  behind: boolean;
};

/**
 * Los nodos del cuerpo (los bracitos de Kirby, los bultos de Cloudee) se
 * proyectan como elipses. Es una aproximación: la proyección exacta de un
 * elipsoide fuera del eje es una cónica levemente distinta, pero a este tamaño
 * la diferencia no se ve. Lo que sí importa y sí está resuelto es el orden:
 * un nodo que queda detrás del cuerpo se dibuja antes.
 */
export const projectNode = (
  node: BodyNode,
  orientation: Quaternion,
  perspective: number,
): ProjectedNode => {
  const rotated = rotatePoint(orientation, node.position);
  const [cx, cy, cz] = project(rotated, perspective);
  const denominator = FOCAL_LENGTH - cz * perspective;
  const scale = FOCAL_LENGTH / (denominator || 1);
  return {
    cx,
    cy,
    rx: (node.surface.width / 2) * scale,
    ry: (node.surface.height / 2) * scale,
    rotation: node.rotation[2],
    behind: cz < 0,
  };
};
