/**
 * Bridges the LiveKit realtime voice tools (`createRealtimeTools`) to the OpenAI
 * Realtime protocol.
 *
 * Two responsibilities:
 *  1. Declare the tools to the model via `session.update` (`session.tools`): each
 *     tool becomes `{ type: 'function', name, description, parameters }` where
 *     `parameters` is the zod schema converted to a JSON Schema with the native
 *     `z.toJSONSchema`.
 *  2. Execute a model `function_call`: parse the JSON arguments, zod-validate them
 *     against the production tool's schema (never bypassing a strict-schema
 *     violation), call the production `execute(args, opts)` with a minimal `opts`,
 *     record every executed call, and format the result as `function_call_output`.
 *
 * The production tools never see a `dryRun`/free-form `to` argument: the zod schema
 * boundary rejects it before `execute` is ever reached, and the error is returned to
 * the model as a tool output so it can correct itself.
 */
import { z } from 'zod';
import type { FunctionTool } from '@livekit/agents';
import {
  createRealtimeTools,
  type RealtimeToolsDependencies,
} from '../../../src/livekit/realtime-tools/index.js';

/** An OpenAI Realtime function tool declaration for `session.update`. */
export type RealtimeOpenAITool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** A model-emitted function call request. */
export type FunctionCallEvent = {
  callId: string;
  name: string;
  /** Raw JSON string of the arguments as produced by the model. */
  arguments: string;
};

/** The `function_call_output` payload to send back to the model. */
export type FunctionCallOutput = {
  callId: string;
  /** JSON-encoded tool result string. */
  output: string;
};

/** One executed tool invocation, recorded for the eval event log. */
export type ToolCallRecord = {
  name: string;
  rawArgs: string;
  result: unknown;
};

export type RealtimeToolBinding = {
  /** Tools declaration for `session.update` (`session.tools`). */
  tools: RealtimeOpenAITool[];
  /** Executes a model function call and returns the output item payload. */
  executeFunctionCall(event: FunctionCallEvent): Promise<FunctionCallOutput>;
  /** Event log of every executed tool call, in order. */
  calls: ToolCallRecord[];
};

type ZodSchemaLike = {
  safeParse(input: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues?: Array<{ path: PropertyKey[]; message: string }> };
  };
};

function isZodSchema(schema: unknown): schema is ZodSchemaLike {
  return typeof (schema as ZodSchemaLike)?.safeParse === 'function';
}

function toOpenAIJsonSchema(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  }
  // Already a raw JSON Schema; pass it through unchanged.
  return schema as Record<string, unknown>;
}

function formatValidationError(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Builds the OpenAI Realtime binding for one conversation's voice tools.
 *
 * @param dependencies The same dependencies passed to `createRealtimeTools`. The
 *   production tools are created internally and closed over by the executor.
 */
export function createRealtimeToolBinding(
  dependencies: RealtimeToolsDependencies,
): RealtimeToolBinding {
  const tools = createRealtimeTools(dependencies);
  const toolsByName = new Map<string, FunctionTool<any, any, any>>();
  const declaration: RealtimeOpenAITool[] = [];

  for (const tool of tools) {
    toolsByName.set(tool.name, tool);
    declaration.push({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: toOpenAIJsonSchema(tool.parameters),
    });
  }

  const calls: ToolCallRecord[] = [];

  async function executeFunctionCall(event: FunctionCallEvent): Promise<FunctionCallOutput> {
    const tool = toolsByName.get(event.name);
    if (!tool) {
      return {
        callId: event.callId,
        output: JSON.stringify({
          error: 'unknown_tool',
          message: `No tool named "${event.name}".`,
        }),
      };
    }

    let args: unknown;
    try {
      args = JSON.parse(event.arguments || '{}');
    } catch {
      return {
        callId: event.callId,
        output: JSON.stringify({
          error: 'invalid_json',
          message: 'The model produced invalid JSON arguments.',
        }),
      };
    }

    const schema = tool.parameters;
    if (isZodSchema(schema)) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return {
          callId: event.callId,
          output: JSON.stringify({
            error: 'invalid_arguments',
            message: `Argument validation failed: ${formatValidationError(
              parsed.error?.issues ?? [],
            )}`,
          }),
        };
      }
      args = parsed.data;
    }

    // The production tools read no `opts` fields (no ctx/participant); a minimal
    // `opts` carries only the call id. Never bypass a strict-schema rejection above.
    const opts = { toolCallId: event.callId } as never;
    const result = await tool.execute(args as never, opts);
    calls.push({ name: event.name, rawArgs: event.arguments, result });
    return { callId: event.callId, output: JSON.stringify(result) };
  }

  return { tools: declaration, executeFunctionCall, calls };
}
