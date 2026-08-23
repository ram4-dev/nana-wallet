import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildWalletAgentInstructions, getWalletAgentConfig } from '../../src/agent/instructions.js';
import { createDatabaseClient } from '../../src/db/client.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { RecipientMemoryRepository } from '../../src/memory/repository.js';
import { RecipientMemoryService } from '../../src/memory/service.js';
import { createRecipientMemoryTools } from '../../src/memory/tools.js';
import { createSession, getSession, resetSessionStore } from '../../src/sessions/in-memory-store.js';

const LIVE = process.env.RECIPIENT_MEMORY_LLM_E2E === '1';
const USER_ID = '7f143d9a-4939-44cd-b49e-d64f2ad9c397';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/wdk_agent';
const OPENCODE_MODEL = 'opencode-go/deepseek-v4-flash';
const OPENCODE_TIMEOUT_MS = 45_000;
const ADDRESSES = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
] as const;

const queryArgsSchema = z.object({ query: z.string().min(1) }).strict();
const plannerActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('search_recipients'), args: queryArgsSchema }).strict(),
  z.object({ tool: z.literal('search_user_memory'), args: queryArgsSchema }).strict(),
  z.object({ tool: z.literal('clarify'), args: z.object({ message: z.string().min(1) }).strict() }).strict(),
  z.object({ tool: z.literal('none'), args: z.object({}).strict() }).strict(),
]);
const plannerBatchSchema = z.object({
  decisions: z.array(z.object({
    scenario: z.enum(['unique', 'duplicate', 'relationship', 'balance']),
    action: plannerActionSchema,
  }).strict()),
}).strict();

type PlannerAction = z.infer<typeof plannerActionSchema>;
type SearchAction = Extract<PlannerAction, { tool: 'search_recipients' | 'search_user_memory' }>;

function extractOpenCodeText(output: string): string {
  const events = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } });
  const unexpected = events.filter((event) =>
    !['step_start', 'text', 'step_finish'].includes(event.type ?? '') ||
    (event.part?.type !== undefined && !['step-start', 'text', 'step-finish'].includes(event.part.type)),
  );
  if (unexpected.length > 0) throw new Error('OpenCode attempted a non-text action during the retrieval decision smoke.');
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.part?.text ?? '')
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function askPlanner(prompt: string): z.infer<typeof plannerBatchSchema> {
  const output = execFileSync('opencode', [
    '--pure',
    '-m', OPENCODE_MODEL,
    'run',
    '--format', 'json',
    prompt,
  ], {
    // Keep the planner outside the repository so project-local agents/plugins
    // cannot alter the decision contract or create repo artifacts.
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: OPENCODE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return plannerBatchSchema.parse(JSON.parse(extractOpenCodeText(output)));
}

function decisionsByScenario(batch: z.infer<typeof plannerBatchSchema>): Map<string, PlannerAction> {
  const decisions = new Map(batch.decisions.map(({ scenario, action }) => [scenario, action]));
  expect(decisions.size).toBe(batch.decisions.length);
  return decisions;
}

const plannerContract = `${buildWalletAgentInstructions(getWalletAgentConfig())}

You are being tested only at the recipient-retrieval decision stage. Do not use
filesystem, shell, WDK, address, balance, or transfer tools. Choose exactly one
of these actions for each scenario:
- {"tool":"search_recipients","args":{"query":"<case-preserving recipient name>"}}
- {"tool":"search_user_memory","args":{"query":"<case-preserving relationship phrase>"}}
- {"tool":"clarify","args":{"message":"<question for the user>"}}
- {"tool":"none","args":{}}
Use no extra keys. A relationship phrase must use search_user_memory first. A
named person must use search_recipients. An unrelated wallet question uses none.
Never expose or request an address. Return only the requested JSON object.`;

describe.runIf(LIVE)('live LLM recipient retrieval', () => {
  it('lets OpenCode choose the exact pgvector tool while preserving ambiguity and address privacy', async () => {
    const database = createDatabaseClient(DATABASE_URL);
    const repository = new RecipientMemoryRepository(database);
    const embeddings = new EmbeddingService(process.env.RECIPIENT_MEMORY_MODEL_CACHE ?? '.cache/recipient-memory-model');
    const service = new RecipientMemoryService(repository, embeddings, { scoreThreshold: 0.78, scoreMargin: 0.08 });
    const executed: Array<{ scenario: string; tool: SearchAction['tool']; args: { query: string } }> = [];

    try {
      await database.query('DELETE FROM user_memories WHERE user_id = $1', [USER_ID]);
      await database.query('DELETE FROM recipients WHERE user_id = $1', [USER_ID]);

      const martina = await service.writeConfirmed(USER_ID, {
        kind: 'recipient', name: 'Martina', description: 'mi hermana', address: ADDRESSES[0],
      });
      await service.writeConfirmed(USER_ID, {
        kind: 'recipient', name: 'Lucas', description: 'mi vecino', address: ADDRESSES[1],
      });
      await service.writeConfirmed(USER_ID, {
        kind: 'recipient', name: 'Lucas', description: 'mi contador', address: ADDRESSES[2],
      });
      await service.writeConfirmed(USER_ID, {
        kind: 'recipient', name: 'Mateo', description: 'amigo de la familia', address: ADDRESSES[3],
      });
      await service.writeConfirmed(USER_ID, { kind: 'fact', fact: 'Lucas es mi nieto' });
      await service.writeConfirmed(USER_ID, { kind: 'fact', fact: 'Mateo es mi nieto' });

      resetSessionStore();
      const scenarios = Object.fromEntries(['unique', 'duplicate', 'relationship', 'balance'].map((scenario) => {
        const session = createSession();
        return [scenario, { session, tools: createRecipientMemoryTools({ userId: USER_ID, session, service }) }];
      })) as Record<string, { session: ReturnType<typeof createSession>; tools: ReturnType<typeof createRecipientMemoryTools> }>;

      const initial = decisionsByScenario(askPlanner(`${plannerContract}

Return {"decisions":[...]} with each scenario exactly once. Every array item
must have exactly this shape (the scenario name is a value, never an object
key): {"scenario":"unique","action":{"tool":"none","args":{}}}.
- unique: user says "Mandale plata a Martina"
- duplicate: user says "Mandale plata a Lucas"
- relationship: user says "Mandale plata a mi nieto"
- balance: user says "Cuanto saldo tengo?"`));

      expect([...initial.keys()].sort()).toEqual(['balance', 'duplicate', 'relationship', 'unique']);
      expect(initial.get('unique')).toEqual({ tool: 'search_recipients', args: { query: 'Martina' } });
      expect(initial.get('duplicate')).toEqual({ tool: 'search_recipients', args: { query: 'Lucas' } });
      expect(initial.get('relationship')).toEqual({ tool: 'search_user_memory', args: { query: 'mi nieto' } });
      expect(initial.get('balance')).toEqual({ tool: 'none', args: {} });

      const results = new Map<string, unknown>();
      for (const scenario of ['unique', 'duplicate', 'relationship'] as const) {
        const action = initial.get(scenario);
        if (!action || (action.tool !== 'search_recipients' && action.tool !== 'search_user_memory')) {
          throw new Error(`Expected ${scenario} to choose a retrieval tool.`);
        }
        const parsedAction = plannerActionSchema.parse(action) as SearchAction;
        executed.push({ scenario, tool: parsedAction.tool, args: parsedAction.args });
        const liveTool = scenarios[scenario]!.tools[parsedAction.tool];
        results.set(scenario, await liveTool(parsedAction.args));
      }

      expect(results.get('unique')).toMatchObject({ status: 'resolved', recipient: { id: martina.id, version: martina.version } });
      expect(getSession(scenarios.unique!.session.id)?.recipientMemory?.selectedRecipient).toEqual({
        recipientId: martina.id,
        version: martina.version,
      });
      expect(results.get('duplicate')).toMatchObject({ status: 'clarification_required' });
      expect(results.get('relationship')).toEqual({ status: 'clarification_required', facts: [] });
      expect(JSON.stringify([...results.values()])).not.toMatch(/0x[a-fA-F0-9]{40}/);
      for (const address of ADDRESSES) expect(JSON.stringify([...results.values()])).not.toContain(address);

      const followUp = decisionsByScenario(askPlanner(`${plannerContract}

The live PostgreSQL/pgvector tools returned these results:
- duplicate after search_recipients({"query":"Lucas"}): ${JSON.stringify(results.get('duplicate'))}
- relationship after search_user_memory({"query":"mi nieto"}): ${JSON.stringify(results.get('relationship'))}
Return {"decisions":[...]} for duplicate and relationship only. Every array
item must have exactly this shape: {"scenario":"duplicate","action":{"tool":"clarify","args":{"message":"question"}}}.
Preserve each clarification_required result: ask the user a clarification and
do not call any other retrieval tool.`));

      expect([...followUp.keys()].sort()).toEqual(['duplicate', 'relationship']);
      expect(followUp.get('duplicate')).toMatchObject({ tool: 'clarify' });
      expect(followUp.get('relationship')).toMatchObject({ tool: 'clarify' });
      expect(JSON.stringify([...followUp.values()])).not.toMatch(/0x[a-fA-F0-9]{40}/);
      expect(executed).toEqual([
        { scenario: 'unique', tool: 'search_recipients', args: { query: 'Martina' } },
        { scenario: 'duplicate', tool: 'search_recipients', args: { query: 'Lucas' } },
        { scenario: 'relationship', tool: 'search_user_memory', args: { query: 'mi nieto' } },
      ]);
      expect(executed.some(({ scenario }) => scenario === 'balance')).toBe(false);
      expect(executed.some(({ scenario, tool }) => scenario === 'relationship' && tool === 'search_recipients')).toBe(false);
    } finally {
      await database.query('DELETE FROM user_memories WHERE user_id = $1', [USER_ID]);
      await database.query('DELETE FROM recipients WHERE user_id = $1', [USER_ID]);
      await database.close();
      resetSessionStore();
    }
  }, 180_000);
});
