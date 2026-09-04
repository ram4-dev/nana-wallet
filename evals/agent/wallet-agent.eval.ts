import { evalite } from 'evalite';
import { agentScorers, runAgentScenario } from './helpers.js';
import type { AgentExpected, AgentScenario } from './scenarios/types.js';
import { toolSelectionScenarios } from './scenarios/tool-selection.js';
import { guardScenarios } from './scenarios/guards.js';
import { previewConfirmScenarios } from './scenarios/preview-confirm.js';
import { recipientResolutionScenarios } from './scenarios/recipient-resolution.js';

function dataFor(
  scenarios: AgentScenario[],
): Array<{ input: AgentScenario; expected: AgentExpected }> {
  return scenarios.map((scenario) => ({ input: scenario, expected: scenario.expected }));
}

evalite('Agent: tool selection + parameters', {
  data: dataFor(toolSelectionScenarios),
  task: (scenario: AgentScenario) => runAgentScenario(scenario),
  scorers: agentScorers,
});

evalite('Agent: guards', {
  data: dataFor(guardScenarios),
  task: (scenario: AgentScenario) => runAgentScenario(scenario),
  scorers: agentScorers,
});

evalite('Agent: preview → confirm flow', {
  data: dataFor(previewConfirmScenarios),
  task: (scenario: AgentScenario) => runAgentScenario(scenario),
  scorers: agentScorers,
});

evalite('Agent: recipient resolution', {
  data: dataFor(recipientResolutionScenarios),
  task: (scenario: AgentScenario) => runAgentScenario(scenario),
  scorers: agentScorers,
});
