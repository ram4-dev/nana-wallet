# Research provenance

This project reimplements concepts in original language. It does not copy current HumanLayer skill text or templates.

## Sources inspected

- HumanLayer workflow documentation: `https://docs.humanlayer.com/guide/skills-workflows`
- Phase contracts: `https://docs.humanlayer.com/explanation/workflow-phases`
- Skill reference: `https://docs.humanlayer.com/reference/skills-workflows`
- Public skills repository: `https://github.com/humanlayer/skills`
  - inspected commit: `3c2629142c5d437428269b1b722b08c0b87f574d`
  - relevant upstream paths: `plugins/design-control-loop/` and `plugins/build-iterated-agentic-loop/`
  - upstream license: MIT, Copyright (c) 2026 HumanLayer
- HumanLayer main repository: `https://github.com/humanlayer/humanlayer`
  - inspected public `main`: `99abe673` (2026-06-18 snapshot used during research)
  - relevant legacy commands: `.claude/commands/create_plan_generic.md`, `iterate_plan.md`, `implement_plan.md`, and `validate_plan.md`
  - upstream license: Apache-2.0
- Historical ACE/FIC explanation: `https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md`

## Availability boundary

HumanLayer documentation references current RPI source paths under `apps/riptide-rpi-claude-plugin/skills/` and a registry under `packages/ui/src/constants/rpi-skills.ts`. Those paths were not present in the inspected public main tree. The documented behavior is observable; the current implementation was therefore not treated as available source.

## Concepts retained

- route work by required review points;
- current-state research before solution questions;
- one controlling artifact per decision type;
- explicit human approval at high-leverage decisions;
- vertical delivery slices with automated and manual evidence;
- bounded recurring work modeled as sensor, controller, actuator, and feedback.

## Material changes

- Combined one-off workflow routing and recurring-loop design behind one task classifier.
- Preserved the observable workflow names Oneshot, RPI, PRD-oriented, and Freeform while defining project-local artifact contracts.
- Made consequence, uncertainty, reversibility, and authority the gate criteria.
- Added explicit prompt-injection, identity-binding, least-privilege, rollback, and manual-bypass controls.
- Removed provider-specific runners, schedulers, and CodeLayer/Claude defaults.

If future work copies a substantial upstream file instead of reimplementing its concepts, add the full applicable upstream license and copyright notice before distribution.
