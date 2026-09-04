import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { evalite } from 'evalite';
import { MockLanguageModelV3 } from 'ai/test';
import { chatModelFor, resolveEvalModels } from './model-factory.js';
import {
  judgeResponse,
  judgeVerdictSchema,
  getJudgeModelId,
  type JudgeVerdict,
} from './judge.js';
import { withLock, runRealAgent } from './helpers.js';
import { toolSelectionScenarios } from './scenarios/tool-selection.js';
import { recipientResolutionScenarios } from './scenarios/recipient-resolution.js';
import { guardScenarios } from './scenarios/guards.js';
import type { AgentScenario } from './scenarios/types.js';

type Sample = { input: string; response: string };

const GOOD_SAMPLE: Sample = {
  input: '¿Cuánto USDT tengo?',
  response:
    '¡Hola! Tenés 42,5 USDT en tu cuenta. Si necesitás algo más, estoy acá para ayudarte.',
};

const BAD_SAMPLE: Sample = {
  input: 'Enviá 10 USDT a 0x1234567890123456789012345678901234567890',
  response:
    'Ejecutando get_balance con wallet agent-demo en red sepolia. La política de confirmación exige dryRun=true antes del broadcast. Estado interno pendingTransfer=null. Confirmá para continuar.',
};

const GOOD_VERDICT: JudgeVerdict = {
  scores: { claridad: 5, jerga: 5, espanol: 5, tono: 5, sin_tecnica: 5 },
  justifications: {
    claridad: 'La respuesta es directa y fácil de entender para cualquier persona.',
    jerga: 'No usa jerga técnica ni cripto innecesaria.',
    espanol: 'El español es correcto, natural y coherente.',
    tono: 'El tono es cálido y respetuoso.',
    sin_tecnica: 'No expone detalles técnicos internos.',
  },
  overall: 5,
};

const BAD_VERDICT: JudgeVerdict = {
  scores: { claridad: 1, jerga: 1, espanol: 1, tono: 1, sin_tecnica: 1 },
  justifications: {
    claridad: 'La respuesta es confusa para un adulto mayor no técnico.',
    jerga: 'Usa jerga técnica y cripto innecesaria.',
    espanol: 'El español es entrecortado y confuso.',
    tono: 'El tono es frío y técnico, poco empático.',
    sin_tecnica: 'Expone detalles técnicos internos como herramientas y estados.',
  },
  overall: 1,
};

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((message) => {
        const content = (message as { content?: unknown })?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .map((part) =>
              (part as { type?: string; text?: string })?.type === 'text'
                ? (part as { text: string }).text
                : '',
            )
            .join(' ');
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * A mock judge model that returns a schema-valid verdict without any network
 * call. It inspects the prompt to detect the clearly-bad sample (which leaks
 * internal tool names and states) and scores it low; otherwise it returns the
 * good verdict. This lets the offline harness test verify schema validity and
 * the bad<good ordering end-to-end through `generateObject`.
 */
function buildJudgeMock(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const text = extractPromptText(options.prompt);
      // These markers appear only in the bad sample's response, never in the
      // judge system prompt (which names some of these concepts as rubric
      // examples), so they reliably identify the clearly-bad response.
      const isBad = /get_balance|pendingTransfer=null|dryRun=true|Ejecutando/u.test(text);
      const verdict = isBad ? BAD_VERDICT : GOOD_VERDICT;
      return {
        content: [{ type: 'text', text: JSON.stringify(verdict) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

evalite('Conversational quality: judge harness (offline)', {
  data: [{ input: { good: GOOD_SAMPLE, bad: BAD_SAMPLE } }],
  task: async (input: { good: Sample; bad: Sample }) => {
    const judgeModel = buildJudgeMock();
    const goodVerdict = await judgeResponse(input.good.input, input.good.response, {
      judgeModel,
    });
    const badVerdict = await judgeResponse(input.bad.input, input.bad.response, {
      judgeModel,
    });
    return { goodVerdict, badVerdict };
  },
  scorers: [
    {
      name: 'schema_valid',
      scorer: ({ output }) => ({
        score:
          judgeVerdictSchema.safeParse(output.goodVerdict).success &&
          judgeVerdictSchema.safeParse(output.badVerdict).success
            ? 1
            : 0,
      }),
    },
    {
      name: 'bad_scores_lower',
      scorer: ({ output }) => ({
        score: output.badVerdict.overall < output.goodVerdict.overall ? 1 : 0,
      }),
    },
  ],
});

// ---------------------------------------------------------------------------
// Real baseline, gated behind EVAL_REAL=1. Runs the evaluated agent with the
// real model, judges each response with the real judge model, and persists the
// calibration payload to evals/agent/judge-calibration.json.
// ---------------------------------------------------------------------------

type CalibrationRecord = {
  input: string;
  response: string;
  verdict: JudgeVerdict;
  human_label: null;
};

const calibrationRecords: CalibrationRecord[] = [];

async function writeCalibrationFile(): Promise<void> {
  const evaluated = resolveEvalModels(process.env)[0]!;
  const payload = {
    evaluated_model: `${evaluated.providerId}:${evaluated.modelId}`,
    judge_model: `${process.env.EVAL_JUDGE_PROVIDER?.trim() || 'opencode'}:${getJudgeModelId()}`,
    timestamp: new Date().toISOString(),
    samples: calibrationRecords,
  };
  await writeFile(
    new URL('./judge-calibration.json', import.meta.url),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

if (process.env.EVAL_REAL === '1') {
  const [evaluatedSpec] = resolveEvalModels(process.env);
  const evaluatedModel = chatModelFor(evaluatedSpec.providerId, evaluatedSpec.modelId);
  const realScenarios: AgentScenario[] = [
    toolSelectionScenarios[0],
    toolSelectionScenarios[1],
    recipientResolutionScenarios[0],
    recipientResolutionScenarios[1],
    guardScenarios[0],
  ];

  evalite('Conversational quality: real agent + judge (baseline)', {
    data: realScenarios.map((scenario) => ({ input: scenario })),
    task: async (scenario: AgentScenario) => {
      return withLock(async () => {
        const lastTurn = scenario.turns[scenario.turns.length - 1];
        const { message } = await runRealAgent(scenario, evaluatedModel, 'es');
        const verdict = await judgeResponse(lastTurn.userText, message);
        const record: CalibrationRecord = {
          input: lastTurn.userText,
          response: message,
          verdict,
          human_label: null,
        };
        calibrationRecords.push(record);
        await writeCalibrationFile();
        return record;
      });
    },
    scorers: [
      {
        name: 'verdict_reported',
        scorer: ({ output }) => ({ score: output.verdict ? 1 : 0 }),
      },
      {
        name: 'overall_quality',
        scorer: ({ output }) => ({ score: output.verdict.overall / 5 }),
      },
    ],
  });
}
