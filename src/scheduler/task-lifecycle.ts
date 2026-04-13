import type { RunnerLogger } from '../logger.js';
import type { BacklogImplementationRunnerRole } from '../types.js';
import { containsSharedInstallPolicyCode } from '../workspace/shared-install.js';
import type {
  AgentContextPayload,
  AgentResult,
  AgentRunRequest,
  BacklogRunnerConfig,
  BacklogStore,
  BacklogTaskClaim,
  CommandRunner,
  ResolvedRunOptions,
  WorkspaceApplyResult,
  WorkspaceRepairResult,
  WorkspaceStrategy,
} from '../types.js';
import type { PersistLifecyclePhaseResult } from './helpers.js';
import { changedFiles, persistLifecyclePhase, runLoggedAgentPhase } from './helpers.js';
import { classifyValidationFailure, queueNonBlockingValidationFollowup } from './validation-classify.js';

export interface LifecycleAgentPhaseOptions {
  commandRunner: CommandRunner;
  options: ResolvedRunOptions;
  logger: RunnerLogger;
  executionRole: BacklogImplementationRunnerRole;
  label: string;
  context: string | AgentContextPayload;
  prompt: string;
  cwd: string;
  maxTurns: number;
  includeMeta?: boolean;
  failureReason: string;
  onProgress?: AgentRunRequest['onProgress'];
}

export type LifecycleAgentPhaseResult =
  | { ok: true; agentResult: AgentResult }
  | { ok: false; agentResult: AgentResult; failureReason: string };

export async function runLifecycleAgentPhase({
  commandRunner,
  options,
  logger,
  executionRole,
  label,
  context,
  prompt,
  cwd,
  maxTurns,
  includeMeta = false,
  failureReason,
  onProgress,
}: LifecycleAgentPhaseOptions): Promise<LifecycleAgentPhaseResult> {
  const agentResult = await runLoggedAgentPhase({
    commandRunner,
    options,
    logger,
    role: executionRole,
    label,
    context,
    prompt,
    cwd,
    maxTurns,
    includeMeta,
    onProgress,
  });

  if (agentResult.status === 'done') {
    return { ok: true, agentResult };
  }

  return {
    ok: false,
    agentResult,
    failureReason: agentResult.note || failureReason,
  };
}

export type ValidationFailureDisposition =
  | { kind: 'deferred'; failureReason: string }
  | { kind: 'blocking'; failureReason: string }
  | { kind: 'non_blocking'; failureReason: string };

export interface ValidationFailureDispositionOptions {
  store: BacklogStore;
  logger: RunnerLogger;
  claim: BacklogTaskClaim;
  commandRunner: CommandRunner;
  cwd: string;
  failureReason: string;
}

export async function resolveValidationFailureDisposition({
  store,
  logger,
  claim,
  commandRunner,
  cwd,
  failureReason,
}: ValidationFailureDispositionOptions): Promise<ValidationFailureDisposition> {
  if (containsSharedInstallPolicyCode(failureReason)) {
    return { kind: 'deferred', failureReason };
  }

  const classification = classifyValidationFailure(
    claim,
    failureReason,
    await changedFiles(commandRunner, cwd),
  );
  if (classification.blocking) {
    return { kind: 'blocking', failureReason: classification.reason };
  }

  await queueNonBlockingValidationFollowup(store, logger, claim, classification);
  return { kind: 'non_blocking', failureReason: classification.reason };
}

export async function appendRepairNotes(
  store: BacklogStore,
  taskId: string,
  note: string | undefined,
  queuedFollowups: number,
): Promise<void> {
  if (note) {
    await store.appendTaskNote(taskId, `Recovered by remediation: ${note}`);
  } else {
    await store.appendTaskNote(taskId, 'Recovered by remediation');
  }
  if (queuedFollowups > 0) {
    await store.appendTaskNote(taskId, `Follow-up queued by remediation: ${queuedFollowups} task(s)`);
  }
}

export type PersistTaskTransition =
  | {
    type: 'complete-claim';
    claim: BacklogTaskClaim;
    note: string;
    recordFollowupNote?: boolean;
  }
  | {
    type: 'append-repair-notes';
    taskId: string;
    note?: string;
  };

export interface PersistTaskLifecyclePhaseOptions {
  store: BacklogStore;
  workspaceStrategy: WorkspaceStrategy;
  logger: RunnerLogger;
  config: BacklogRunnerConfig;
  commitMessage: string;
  transition: PersistTaskTransition;
  retryPendingPush?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function persistTaskLifecyclePhase({
  store,
  workspaceStrategy,
  logger,
  config,
  commitMessage,
  transition,
  retryPendingPush = false,
  sleep,
}: PersistTaskLifecyclePhaseOptions): Promise<PersistLifecyclePhaseResult> {
  return persistLifecyclePhase({
    store,
    workspaceStrategy,
    logger,
    config,
    commitMessage,
    retryPendingPush,
    sleep,
    onPersisted: async drainResult => {
      if (transition.type === 'complete-claim') {
        await store.completeClaim(transition.claim, transition.note);
        if (transition.recordFollowupNote && drainResult.createdTasks > 0) {
          await store.appendTaskNote(
            transition.claim.task.id,
            `Follow-up queued by remediation: ${drainResult.createdTasks} task(s)`,
          );
        }
        return;
      }

      await appendRepairNotes(store, transition.taskId, transition.note, drainResult.createdTasks);
    },
  });
}

export function reconciliationFailureResult(
  failureReason: string,
  queuedFollowups = 0,
): WorkspaceRepairResult {
  return {
    recovered: false,
    deferred: true,
    failureReason,
    queuedFollowups,
  };
}

export function reconciliationSuccessResult(queuedFollowups = 0): WorkspaceRepairResult {
  return {
    recovered: true,
    deferred: false,
    queuedFollowups,
  };
}

export function withFailureReason(
  finalizeResult: WorkspaceApplyResult,
  fallbackReason: string,
): string {
  return finalizeResult.reason ?? fallbackReason;
}
