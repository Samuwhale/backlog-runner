import { buildReconciliationContext, buildWorkspaceRepairContext } from '../context.js';
import type { RunnerLogger } from '../logger.js';
import type {
  BacklogRunnerConfig,
  BacklogStore,
  BacklogTaskClaim,
  BacklogWorkerResult,
  CommandRunner,
  ResolvedRunOptions,
  WorkspaceApplyResult,
  WorkspaceRepairResult,
  WorkspaceStrategy,
} from '../types.js';
import { PREFLIGHT_DEFERRAL_MS, RECONCILIATION_MAX_TURNS } from './constants.js';
import {
  changedFiles,
  drainCandidateQueuePhase,
  diffForPaths,
  implementationRunnerRole,
  readPrompt,
  runValidationPhase,
  scopeViolations,
  stagedFiles,
} from './helpers.js';
import {
  appendRepairNotes,
  persistTaskLifecyclePhase,
  reconciliationFailureResult,
  reconciliationSuccessResult,
  resolveValidationFailureDisposition,
  runLifecycleAgentPhase,
  withFailureReason,
} from './task-lifecycle.js';

export function reconciliationPrompt(basePrompt: string): string {
  return `${basePrompt}

## Reconciliation Mode
You are reconciling an already-implemented task after a git merge/finalization failure.
- Treat the provided diff and failure reason as primary evidence.
- Inspect current local code before deciding how to adapt the change.
- Resolve conflicts autonomously when you can do so coherently and safely.
- Do not drop the task or narrow scope unless the current repo state makes the acceptance criteria impossible.
- Use the declared touch_paths as the intended starting surface, but trust the current workspace diff when adjacent fixes are required to complete the task coherently.
- End with the same strict JSON success/failure object as normal execution.`;
}

export function workspaceRepairPrompt(basePrompt: string, worktreeMode = true): string {
  const ownershipGuidance = worktreeMode
    ? '- This repository is agent-operated by default. You may decide what to keep, discard, split into follow-up work, or restage when needed.'
    : '- In shared-workspace mode, user-originated changes may be present. Do not discard uncommitted changes unless you can confirm they were agent-originated.';
  return `${basePrompt}

## Workspace Repair Mode
You are repairing repo/workspace state for an already-assigned task.
${ownershipGuidance}
- Inspect local code and git state before deciding; do not guess when the repo can answer the question.
- Leave an audit trail in progress notes when you discard or split work.
- In shared-symlink temp worktrees, do not run dependency relinking commands such as pnpm install/add, npm install, yarn install, or bun install. If dependency refresh is required, return the dedicated main-repo refresh reason instead.
- If the task is stale or impossible, return failed with a note starting exactly "stale —" or "impossible —".
- Otherwise, repair the workspace so scheduler preflight, validation, and finalization can proceed.
- End with the same strict JSON success/failure object as normal execution.`;
}

export function shouldFailFromRepairReason(reason?: string): boolean {
  return /^stale\s+—/i.test(reason ?? '') || /^impossible\s+—/i.test(reason ?? '');
}

export async function collectWorkspaceSnapshot(
  commandRunner: CommandRunner,
  cwd: string,
  allowedPaths: string[],
): Promise<{
  changedFiles: string[];
  stagedFiles: string[];
  declaredTouchPathFiles: string[];
  additionalFiles: string[];
}> {
  const [currentChangedFiles, currentStagedFiles] = await Promise.all([
    changedFiles(commandRunner, cwd),
    stagedFiles(commandRunner, cwd),
  ]);
  const additionalFiles = scopeViolations(currentChangedFiles, allowedPaths);
  const extraFiles = new Set(additionalFiles);
  return {
    changedFiles: currentChangedFiles,
    stagedFiles: currentStagedFiles,
    declaredTouchPathFiles: currentChangedFiles.filter(file => !extraFiles.has(file)),
    additionalFiles,
  };
}

export async function attemptWorkspaceRemediation(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  claim: BacklogTaskClaim,
  remediation: {
    mode: 'preflight' | 'validation';
    cwd: string;
    allowedPaths: string[];
    failureReason: string;
    validationSummary?: string;
    verify: () => Promise<{ ok: boolean; reason?: string }>;
  },
): Promise<WorkspaceRepairResult> {
  logger.line('');
  logger.line(`  Attempting autonomous workspace repair: ${remediation.failureReason}`);

  const snapshot = await collectWorkspaceSnapshot(commandRunner, remediation.cwd, remediation.allowedPaths);
  const context = await buildWorkspaceRepairContext(
    config,
    claim,
    await store.getTaskDependencies(claim.task.id),
    await store.getActiveReservations(claim.task.id),
    {
      failureReason: remediation.failureReason,
      mode: remediation.mode,
      changedFiles: snapshot.changedFiles,
      stagedFiles: snapshot.stagedFiles,
      declaredTouchPathFiles: snapshot.declaredTouchPathFiles,
      additionalFiles: snapshot.additionalFiles,
      validationSummary: remediation.validationSummary,
      originalDiff: await diffForPaths(commandRunner, remediation.cwd),
    },
  );
  const agentPhase = await runLifecycleAgentPhase({
    commandRunner,
    options,
    logger,
    executionRole: implementationRunnerRole(claim),
    label: 'workspace repair',
    context,
    prompt: workspaceRepairPrompt(await readPrompt(config.prompts.agent), options.worktrees),
    cwd: remediation.cwd,
    maxTurns: RECONCILIATION_MAX_TURNS,
    failureReason: 'workspace repair agent reported failure',
  });

  const drainResult = await drainCandidateQueuePhase(store, logger);

  if (!agentPhase.ok) {
    return {
      recovered: false,
      deferred: !shouldFailFromRepairReason(agentPhase.failureReason),
      failureReason: agentPhase.failureReason,
      queuedFollowups: drainResult.createdTasks,
    };
  }

  const verification = await remediation.verify();
  if (!verification.ok) {
    logger.line(`  ✗ workspace repair verification failed: ${verification.reason ?? remediation.failureReason}`);
    return {
      recovered: false,
      deferred: true,
      failureReason: verification.reason ?? remediation.failureReason,
      queuedFollowups: drainResult.createdTasks,
    };
  }

  await appendRepairNotes(store, claim.task.id, agentPhase.agentResult.note, drainResult.createdTasks);
  logger.line('  ✓ Workspace repair recovered the task');
  return {
    recovered: true,
    deferred: false,
    queuedFollowups: drainResult.createdTasks,
  };
}

export async function applyClaimRepairOutcome(
  store: BacklogStore,
  logger: RunnerLogger,
  claim: BacklogTaskClaim,
  outcome: WorkspaceRepairResult,
  fallbackReason: string,
): Promise<void> {
  const failureReason = outcome.failureReason ?? fallbackReason;
  if (outcome.deferred) {
    await store.deferClaim(claim, failureReason, PREFLIGHT_DEFERRAL_MS, { category: 'remediation' });
    logger.line(`  ⚠ ${failureReason} — deferred for retry`);
    return;
  }
  await store.failClaim(claim, failureReason);
  logger.line(`  ✗ ${failureReason} — marked failed`);
}

export async function applyTaskRepairOutcome(
  store: BacklogStore,
  logger: RunnerLogger,
  taskId: string,
  outcome: WorkspaceRepairResult,
  fallbackReason: string,
): Promise<void> {
  const failureReason = outcome.failureReason ?? fallbackReason;
  if (outcome.deferred) {
    await store.deferTaskById(taskId, failureReason, PREFLIGHT_DEFERRAL_MS, { category: 'remediation' });
    logger.line(`  ⚠ ${failureReason} — deferred for retry`);
    return;
  }
  await store.failTaskById(taskId, failureReason);
  logger.line(`  ✗ ${failureReason} — marked failed`);
}

export async function tryWithRemediation(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  claim: BacklogTaskClaim,
  startedAt: number,
  remediation: {
    mode: 'preflight' | 'validation';
    cwd: string;
    allowedPaths: string[];
    failureReason: string;
    validationSummary?: string;
    verify: () => Promise<{ ok: boolean; reason?: string }>;
  },
): Promise<{ ok: true } | BacklogWorkerResult> {
  const repaired = await attemptWorkspaceRemediation(
    config, store, commandRunner, logger, options, claim, remediation,
  );
  if (repaired.recovered) {
    return { ok: true };
  }
  await applyClaimRepairOutcome(store, logger, claim, repaired, remediation.failureReason);
  return {
    kind: repaired.deferred ? 'deferred' : 'failed',
    taskId: claim.task.id,
    durationSeconds: Math.max(1, Math.floor((Date.now() - startedAt) / 1000)),
    queuedFollowups: repaired.queuedFollowups,
    note: repaired.failureReason ?? remediation.failureReason,
    validationSummary: remediation.validationSummary,
  };
}

export async function attemptTaskReconciliation(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  workspaceStrategy: WorkspaceStrategy,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  claim: BacklogTaskClaim,
  failureReason: string,
  originalDiff: string,
  taskAlreadyCompleted: boolean,
  commitMessage: string,
  priorFinalizeResult?: WorkspaceApplyResult,
  sleep?: (ms: number) => Promise<void>,
): Promise<WorkspaceRepairResult> {
  logger.line('');
  logger.line(`  Attempting autonomous reconciliation: ${failureReason}`);

  const reconcileInPlace = taskAlreadyCompleted;
  const reconciliationSession = reconcileInPlace ? null : await workspaceStrategy.setup();
  const reconciliationCwd = reconciliationSession?.cwd ?? config.projectRoot;

  try {
    const context = await buildReconciliationContext(
      config,
      claim,
      await store.getTaskDependencies(claim.task.id),
      await store.getActiveReservations(claim.task.id),
      failureReason,
      originalDiff,
    );
    const agentPhase = await runLifecycleAgentPhase({
      commandRunner,
      options,
      logger,
      executionRole: implementationRunnerRole(claim),
      label: 'reconciliation',
      context,
      prompt: reconciliationPrompt(await readPrompt(config.prompts.agent)),
      cwd: reconciliationCwd,
      maxTurns: RECONCILIATION_MAX_TURNS,
      failureReason: 'reconciliation agent reported failure',
    });
    if (!agentPhase.ok) {
      return {
        recovered: false,
        deferred: !shouldFailFromRepairReason(agentPhase.failureReason),
        failureReason: agentPhase.failureReason,
        queuedFollowups: 0,
      };
    }

    const validationCommand = config.validationProfiles[claim.task.validationProfile] ?? config.validationCommand;
    logger.line(`  Reconciliation validation: ${validationCommand}`);
    const validation = await runValidationPhase(
      commandRunner,
      validationCommand,
      reconciliationCwd,
      'reconciliation validation failed',
    );
    if (!validation.ok) {
      const failureReason = validation.failureReason ?? 'reconciliation validation failed';
      const disposition = await resolveValidationFailureDisposition({
        store,
        logger,
        claim,
        commandRunner,
        cwd: reconciliationCwd,
        failureReason,
      });
      if (disposition.kind !== 'non_blocking') {
        logger.line(`  ✗ reconciliation validation failed: ${validation.summary}`);
        return reconciliationFailureResult(disposition.failureReason);
      }
    }

    if (reconciliationSession) {
      const mergeResult = await reconciliationSession.merge();
      if (!mergeResult.ok) {
        logger.line(`  ✗ reconciliation merge failed: ${mergeResult.reason ?? 'merge failed'}`);
        return reconciliationFailureResult(mergeResult.reason ?? 'reconciliation merge failed');
      }
      logger.line('  ✓ Reconciled changes merged to main');
    }

    const finalize = await persistTaskLifecyclePhase({
      store,
      workspaceStrategy,
      logger,
      config,
      commitMessage,
      transition: taskAlreadyCompleted
        ? {
          type: 'append-repair-notes',
          taskId: claim.task.id,
          note: agentPhase.agentResult.note,
        }
        : {
          type: 'complete-claim',
          claim,
          note: `completed after reconciliation: ${agentPhase.agentResult.note || 'reconciled successfully'}`,
          recordFollowupNote: true,
        },
      retryPendingPush: priorFinalizeResult?.pendingPush === true,
      sleep,
    });
    if (!finalize.ok) {
      logger.line(`  ✗ reconciliation finalize failed: ${finalize.finalizeResult.reason ?? 'commit/push failed'}`);
      return reconciliationFailureResult(
        withFailureReason(finalize.finalizeResult, 'reconciliation finalize failed'),
        finalize.queuedFollowups,
      );
    }

    logger.line('  ✓ Reconciliation finalized successfully');
    return reconciliationSuccessResult(finalize.queuedFollowups);
  } finally {
    if (reconciliationSession) {
      await reconciliationSession.teardown();
    }
  }
}
