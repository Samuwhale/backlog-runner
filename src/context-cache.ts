import type { AgentContextPayload } from './types.js';

export type ContextRole = 'execution' | 'repair' | 'reconciliation' | 'discovery' | 'planner';

type ContextSection = {
  name: string;
  value: unknown;
};

const ROLE_CONTRACTS: Record<ContextRole, Record<string, unknown>> = {
  execution: {
    authoritative_sources: ['task_specs', 'runtime_state', 'synthesized_repo_memory'],
    generated_reports: 'advisory_only',
    search_strategy: 'start_targeted_expand_only_if_needed',
    validation_owner: 'scheduler_final_validation',
  },
  repair: {
    authoritative_sources: ['task_specs', 'runtime_state', 'workspace_snapshot', 'synthesized_repo_memory'],
    generated_reports: 'advisory_only',
    search_strategy: 'repair_only_preserve_auditability',
    validation_owner: 'scheduler_final_validation',
  },
  reconciliation: {
    authoritative_sources: ['task_specs', 'runtime_state', 'workspace_snapshot', 'synthesized_repo_memory'],
    generated_reports: 'advisory_only',
    search_strategy: 'repair_only_preserve_auditability',
    validation_owner: 'scheduler_final_validation',
  },
  discovery: {
    authoritative_sources: ['task_specs', 'synthesized_repo_memory', 'pass_config'],
    generated_reports: 'advisory_only',
    search_strategy: 'inspect_repo_emit_candidates_only',
    output_mode: 'candidate_queue_only',
  },
  planner: {
    authoritative_sources: ['task_specs', 'synthesized_repo_memory', 'selected_planner_batch'],
    generated_reports: 'advisory_only',
    search_strategy: 'plan_only_no_repo_writes',
    output_mode: 'strict_supersede_action',
  },
};

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeForStableJson(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, normalizeForStableJson(entryValue)]);

  return Object.fromEntries(entries);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value), null, 2);
}

export function buildContextPayload(role: ContextRole, sections: ContextSection[]): AgentContextPayload {
  const prefix = [
    'BACKLOG_RUNNER_CONTEXT_V2',
    stableJson({
      role,
      contracts: ROLE_CONTRACTS[role],
      format: 'compact_structured_brief',
    }),
  ].join('\n');

  const tail = sections
    .map(section => `${section.name}\n${stableJson(section.value)}`)
    .join('\n\n');

  return { prefix, tail };
}
