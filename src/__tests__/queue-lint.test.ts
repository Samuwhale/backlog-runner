import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../config.js';
import { lintReadyTask } from '../queue-lint.js';
import type { BacklogRunnerConfig, BacklogTaskSpec } from '../types.js';

function makeConfig(): BacklogRunnerConfig {
  return normalizeBacklogRunnerConfig(
    {
      files: {
        backlog: './backlog.md',
        candidateQueue: './backlog/inbox.jsonl',
        taskSpecsDir: './backlog/tasks',
        stop: './backlog-stop',
        runtimeReport: './.backlog-runner/runtime-report.md',
        patterns: './scripts/backlog/patterns.md',
        progress: './scripts/backlog/progress.txt',
        stateDb: './.backlog-runner/state.sqlite',
        runnerLogDir: './.backlog-runner/logs',
        runtimeDir: './.backlog-runner',
      },
      prompts: {
        agent: './scripts/backlog/agent.md',
        planner: './scripts/backlog/planner.md',
        product: './scripts/backlog/product.md',
        interface: './scripts/backlog/interface.md',
        ux: './scripts/backlog/ux.md',
        code: './scripts/backlog/code.md',
      },
      validationCommand: 'bash scripts/backlog/validate.sh',
      validationProfiles: {
        repo: 'bash scripts/backlog/validate.sh',
        core: 'pnpm --filter @tokenmanager/core build',
        server: 'pnpm --filter @tokenmanager/server build',
        plugin: 'pnpm preview:build',
        backlog: 'pnpm --filter @tokenmanager/backlog-runner exec vitest run',
      },
      runners: {
        taskUi: { tool: 'claude', model: 'opus' },
        taskCode: { tool: 'codex', model: 'default' },
        planner: { tool: 'codex', model: 'default' },
        product: { tool: 'codex', model: 'default' },
        interface: { tool: 'claude', model: 'sonnet' },
        ux: { tool: 'codex', model: 'default' },
        code: { tool: 'codex', model: 'default' },
      },
    },
    path.join(process.cwd(), 'backlog.config.mjs'),
  );
}

function makeTask(overrides: Partial<BacklogTaskSpec> = {}): BacklogTaskSpec {
  const hasExecutionDomainOverride = Object.prototype.hasOwnProperty.call(overrides, 'executionDomain');
  return {
    id: overrides.id ?? 'task-a',
    title: overrides.title ?? 'Implement a narrow change',
    priority: overrides.priority ?? 'normal',
    taskKind: overrides.taskKind ?? 'implementation',
    executionDomain: overrides.taskKind === 'research'
      ? undefined
      : hasExecutionDomainOverride
        ? overrides.executionDomain
        : 'ui_ux',
    dependsOn: overrides.dependsOn ?? [],
    touchPaths: overrides.touchPaths ?? ['packages/figma-plugin/src/ui/components/TokenList.tsx'],
    capabilities: overrides.capabilities ?? [],
    validationProfile: overrides.validationProfile ?? 'plugin',
    statusNotes: overrides.statusNotes ?? [],
    state: overrides.state ?? 'ready',
    acceptanceCriteria: overrides.acceptanceCriteria ?? ['TokenList updates its create action without changing adjacent flows.'],
    source: overrides.source ?? 'manual',
    createdAt: overrides.createdAt ?? '2026-04-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-09T00:00:00.000Z',
  };
}

describe('queue lint', () => {
  const config = makeConfig();

  it('allows explicit validation profiles that do not match inferred touch path ownership', () => {
    const issues = lintReadyTask(makeTask({
      title: 'Unify manual token creation entry points behind one Tokens create launcher',
      validationProfile: 'backlog',
      acceptanceCriteria: [
        'Toolbar New token, keyboard create, search-no-results create suggestions, inline sibling create, and create-from-empty all open the same create-launcher state.',
      ],
    }), config);

    expect(issues).toEqual([]);
  });

  it('allows planner-like implementation wording when task metadata is otherwise valid', () => {
    const issues = lintReadyTask(makeTask({
      title: 'Unify manual token creation entry points behind one Tokens create launcher',
      acceptanceCriteria: [
        'Toolbar New token, keyboard create, search-no-results create suggestions, inline sibling create, and create-from-empty all open the same create-launcher state instead of mixing an embedded form with a create-mode drawer.',
        'The create launcher preserves draft context for set, group, path, type, and value when the user escalates between quick and full-editor presentations.',
      ],
    }), config);

    expect(issues).toEqual([]);
  });

  it('accepts backlog-only ready research tasks that require follow-up output', () => {
    const issues = lintReadyTask(makeTask({
      taskKind: 'research',
      title: 'Research import intake surfaces for drag-and-drop discoverability, validation feedback, and conflict handoff',
      touchPaths: ['backlog/inbox.jsonl', 'scripts/backlog/progress.txt', 'scripts/backlog/patterns.md'],
      validationProfile: 'backlog',
      acceptanceCriteria: [
        'Write concrete follow-up backlog tasks with implementation-ready touch paths for the import intake redesign.',
      ],
    }), config);

    expect(issues).toEqual([]);
  });

  it('exempts failed tasks from ready-task executor-fit linting', () => {
    const issues = lintReadyTask(makeTask({
      state: 'failed',
      title: 'Codify Tokens workspace surface ownership and remove competing library body variants',
      validationProfile: 'backlog',
    }), config);

    expect(issues).toEqual([]);
  });

  it('still flags missing touch_paths for ready tasks', () => {
    const issues = lintReadyTask(makeTask({
      touchPaths: [],
    }), config);

    expect(issues.map(issue => issue.reason)).toContain('ready task has no touch_paths');
  });

  it('still flags unknown validation profiles', () => {
    const issues = lintReadyTask(makeTask({
      validationProfile: 'unknown-profile',
    }), config);

    expect(issues.map(issue => issue.reason)).toContain('ready task references unknown validation profile "unknown-profile"');
  });

  it('flags ready implementation tasks without an execution domain', () => {
    const issues = lintReadyTask(makeTask({
      executionDomain: undefined,
    }), config);

    expect(issues.map(issue => issue.reason)).toContain('ready implementation task is missing execution_domain');
  });
});
