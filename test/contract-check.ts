import { normalizeBacklogRunnerConfig } from '../src/config.js';
import type { BacklogRunnerConfigInput, BacklogTaskSpec } from '../src/types.js';

const validConfig = {
  preset: 'balanced',
  prompts: {
    agent: './scripts/backlog/agent.md',
    planner: './scripts/backlog/planner.md',
  },
  validation: {
    default: 'bash scripts/backlog/validate.sh',
  },
  providers: {
    agents: {
      ui: { tool: 'claude', model: 'claude-opus-4-6' },
      code: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'codex', model: 'gpt-5.4' },
    },
  },
  workspace: {
    workers: 1,
    useWorktrees: true,
  },
  discovery: {
    enabled: true,
    passes: {
      frontend: {},
    },
  },
} satisfies BacklogRunnerConfigInput;

const validTask = {
  id: 'task-a',
  title: 'Implement a narrow change',
  priority: 'normal',
  taskKind: 'implementation',
  executionDomain: 'code_logic',
  dependsOn: [],
  touchPaths: ['src/index.ts'],
  capabilities: [],
  validationProfile: 'repo',
  statusNotes: [],
  state: 'ready',
  acceptanceCriteria: ['The change behaves as expected.'],
  source: { type: 'manual' },
  createdAt: '2026-04-13T00:00:00.000Z',
  updatedAt: '2026-04-13T00:00:00.000Z',
} satisfies BacklogTaskSpec;

normalizeBacklogRunnerConfig(validConfig);
void validTask;

const invalidLegacyPrompts: BacklogRunnerConfigInput['prompts'] = {
  agent: './scripts/backlog/agent.md',
  planner: './scripts/backlog/planner.md',
  // @ts-expect-error Legacy prompt roles were removed from the config contract.
  product: './scripts/backlog/product.md',
};

const invalidLegacyProviders: NonNullable<BacklogRunnerConfigInput['providers']> = {
  agents: {
    ui: { tool: 'claude', model: 'claude-opus-4-6' },
    code: { tool: 'codex', model: 'gpt-5.4' },
    planner: { tool: 'codex', model: 'gpt-5.4' },
    // @ts-expect-error Legacy runner roles were removed from the public config contract.
    product: { tool: 'codex', model: 'gpt-5.4' },
  },
};

const invalidLegacySourceTask: BacklogTaskSpec = {
  id: 'task-b',
  title: 'Legacy source shape',
  priority: 'normal',
  taskKind: 'implementation',
  executionDomain: 'code_logic',
  dependsOn: [],
  touchPaths: ['src/index.ts'],
  capabilities: [],
  validationProfile: 'repo',
  statusNotes: [],
  state: 'ready',
  acceptanceCriteria: ['The source shape is rejected by the type system.'],
  // @ts-expect-error Legacy scalar task sources were removed in favor of object-form sources.
  source: 'manual',
  createdAt: '2026-04-13T00:00:00.000Z',
  updatedAt: '2026-04-13T00:00:00.000Z',
};

void invalidLegacyPrompts;
void invalidLegacyProviders;
void invalidLegacySourceTask;
