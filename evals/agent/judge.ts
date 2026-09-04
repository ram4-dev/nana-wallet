import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import { chatModelFor } from './model-factory.js';

/**
 * Fixed conversational-quality rubric. Each criterion is scored 1 (very poor)
 * to 5 (excellent). The judge is a single LLM call against the same
 * openai-compatible endpoint that serves the evaluated agent, using a
 * different model id (default `deepseek-v4-pro`, overridable via EVAL_JUDGE_MODEL).
 */

export const judgeScoresSchema = z.object({
  claridad: z.number().int().min(1).max(5),
  jerga: z.number().int().min(1).max(5),
  espanol: z.number().int().min(1).max(5),
  tono: z.number().int().min(1).max(5),
  sin_tecnica: z.number().int().min(1).max(5),
});

export const judgeVerdictSchema = z.object({
  scores: judgeScoresSchema,
  justifications: z.object({
    claridad: z.string().trim().min(1),
    jerga: z.string().trim().min(1),
    espanol: z.string().trim().min(1),
    tono: z.string().trim().min(1),
    sin_tecnica: z.string().trim().min(1),
  }),
  overall: z.number().min(1).max(5),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const JUDGE_SYSTEM_PROMPT = `Sos un evaluador experto de calidad conversacional para un asistente de billetera destinado a adultos mayores no técnicos de habla hispana (Argentina). Tu tarea es evaluar la respuesta del asistente según una rúbrica fija de 5 criterios.

Cada criterio se puntúa de 1 (muy deficiente) a 5 (excelente). Para cada criterio, escribí una justificación breve (una o dos oraciones) que explique la puntuación.

Criterios:
1. claridad: la respuesta es clara y fácil de entender para un adulto mayor no técnico.
2. jerga: la respuesta evita jerga técnica o cripto innecesaria (por ejemplo, términos como blockchain, gas, red, swap, contrato inteligente, transacción on-chain, comisión de red).
3. espanol: el español es correcto y natural; se acepta el uso rioplatense (voseo) siempre que sea coherente y no haya errores de concordancia u ortografía.
4. tono: el tono es cálido, respetuoso y empático, adecuado para una persona mayor.
5. sin_tecnica: la respuesta NO expone detalles técnicos internos (nombres de herramientas o tools, políticas internas, estados internos, identificadores, hashes, campos de configuración, dryRun, pendingTransfer, etc.).

Además, devolvé un puntaje overall (1 a 5) que represente la calidad conversacional general de la respuesta.

Devolvé únicamente un objeto JSON EXACTO con esta forma, sin campos adicionales:
{
  "scores": { "claridad": 5, "jerga": 5, "espanol": 5, "tono": 5, "sin_tecnica": 5 },
  "justifications": { "claridad": "texto", "jerga": "texto", "espanol": "texto", "tono": "texto", "sin_tecnica": "texto" },
  "overall": 5
}`;

function buildJudgePrompt(input: string, response: string): string {
  return `Entrada del usuario:
${input}

Respuesta del asistente:
${response}

Devolvé el veredicto JSON con scores, justifications y overall.`;
}

/** Judge model id, resolved lazily so dotenv has already loaded. */
export function getJudgeModelId(): string {
  return process.env.EVAL_JUDGE_MODEL ?? 'deepseek-v4-pro';
}

export function buildJudgeModel(): LanguageModel {
  const providerId = process.env.EVAL_JUDGE_PROVIDER?.trim() || 'opencode';
  return chatModelFor(providerId, getJudgeModelId());
}

/**
 * Judges one agent response. Makes a single LLM call via `generateObject`
 * against the judge model. If the model returns something that fails the zod
 * schema, the call is retried once; the second failure is rethrown.
 */
export async function judgeResponse(
  input: string,
  response: string,
  opts?: { judgeModel?: LanguageModel },
): Promise<JudgeVerdict> {
  const judgeModel = opts?.judgeModel ?? buildJudgeModel();
  const prompt = buildJudgePrompt(input, response);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: judgeModel,
        schema: judgeVerdictSchema,
        system: JUDGE_SYSTEM_PROMPT,
        prompt,
      });
      return judgeVerdictSchema.parse(object);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
