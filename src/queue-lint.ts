import { readTaskSpecs } from './task-specs.js';
import type { BacklogRunnerConfig, BacklogTaskSpec } from './types.js';

const RESEARCH_WRITE_PREFIXES = ['backlog/', 'scripts/backlog/'] as const;

export type ReadyTaskLintIssue = {
  taskId: string;
  title: string;
  reason: string;
};

function researchWritesStayBacklogOnly(task: BacklogTaskSpec): boolean {
  return task.touchPaths.length > 0 && task.touchPaths.every(item => RESEARCH_WRITE_PREFIXES.some(prefix => item.startsWith(prefix)));
}

function researchHasFollowupRequirement(task: BacklogTaskSpec): boolean {
  return task.acceptanceCriteria.some(criterion => /follow-?up|candidate queue|backlog item|implementation task/i.test(criterion));
}

export function lintReadyTask(task: BacklogTaskSpec, config: BacklogRunnerConfig): ReadyTaskLintIssue[] {
  const issues: ReadyTaskLintIssue[] = [];

  if (task.state !== 'ready') {
    return issues;
  }

  if (task.touchPaths.length === 0) {
    issues.push({
      taskId: task.id,
      title: task.title,
      reason: 'ready task has no touch_paths',
    });
  }

  if (task.acceptanceCriteria.length === 0) {
    issues.push({
      taskId: task.id,
      title: task.title,
      reason: 'ready task has no acceptance_criteria',
    });
  }

  if (!config.validationProfiles[task.validationProfile]) {
    issues.push({
      taskId: task.id,
      title: task.title,
      reason: `ready task references unknown validation profile "${task.validationProfile}"`,
    });
  }

  if (task.taskKind === 'research') {
    if (!researchWritesStayBacklogOnly(task)) {
      issues.push({
        taskId: task.id,
        title: task.title,
        reason: 'ready research task must stay backlog-only in its write scope',
      });
    }
    if (!researchHasFollowupRequirement(task)) {
      issues.push({
        taskId: task.id,
        title: task.title,
        reason: 'ready research task must require concrete follow-up backlog output',
      });
    }
    return issues;
  }

  if (!task.executionDomain) {
    issues.push({
      taskId: task.id,
      title: task.title,
      reason: 'ready implementation task is missing execution_domain',
    });
  }

  return issues;
}

export async function lintBacklogQueue(
  config: BacklogRunnerConfig,
): Promise<{ ok: boolean; issues: ReadyTaskLintIssue[]; messages: string[] }> {
  const tasks = await readTaskSpecs(config.files.taskSpecsDir);
  const readyTasks = tasks.filter(task => task.state === 'ready');
  const issues = readyTasks.flatMap(task => lintReadyTask(task, config));

  if (issues.length === 0) {
    return {
      ok: true,
      issues,
      messages: ['  ✓ ready-task queue lint passed'],
    };
  }

  return {
    ok: false,
    issues,
    messages: [
      `  ✗ ready-task queue lint failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      ...issues.map(issue => `    - ${issue.taskId}: ${issue.reason}`),
    ],
  };
}
