import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeCommandOutput } from '../command-output.js';
import { normalizePathForGit, unexpectedFiles } from '../git-scope.js';
import type { RunnerLogger } from '../logger.js';
import { JSON_SCHEMA, isAuthFailure, isRateLimited } from '../providers/common.js';
import { runProvider } from '../providers/index.js';
import { parseGitStatusPaths } from '../utils.js';
import type {
  AgentContextPayload,
  AgentResult,
  AgentRunRequest,
  BacklogDrainResult,
  BacklogRunnerConfig,
  BacklogImplementationRunnerRole,
  BacklogRunnerRole,
  BacklogStore,
  BacklogTaskClaim,
  BacklogWorkerResult,
  CommandRunner,
  ResolvedRunOptions,
  ValidationCommandResult,
  WorkspaceApplyResult,
  WorkspaceStrategy,
} from '../types.js';

export function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function retryTime(): string {
  return new Date(Date.now() + 60_000).toTimeString().slice(0, 8);
}

export function getRunnerConfig(options: ResolvedRunOptions, role: BacklogRunnerRole) {
  return options.runners[role];
}

export function implementationRunnerRole(claim: BacklogTaskClaim): BacklogImplementationRunnerRole {
  return claim.task.executionDomain === 'ui_ux' ? 'taskUi' : 'taskCode';
}

export function logDrainResult(logger: RunnerLogger, label: string, result: BacklogDrainResult): void {
  if (!result.drained) return;

  const details = [];
  if (result.createdTasks > 0) {
    details.push(`${result.createdTasks} task${result.createdTasks === 1 ? '' : 's'} created`);
  }
  if (result.skippedDuplicates > 0) {
    details.push(`${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'} skipped`);
  }
  if (result.ignoredInvalidLines > 0) {
    details.push(`${result.ignoredInvalidLines} invalid entr${result.ignoredInvalidLines === 1 ? 'y' : 'ies'} ignored`);
  }
  if (result.loggedRejects > 0) {
    details.push(`${result.loggedRejects} reject log entr${result.loggedRejects === 1 ? 'y' : 'ies'} recorded`);
  }
  if (details.length === 0) return;
  logger.line(`  ${label}: ${details.join(' · ')}`);
}

export async function changedFiles(commandRunner: CommandRunner, cwd: string): Promise<string[]> {
  const status = await commandRunner.run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    ignoreFailure: true,
  });
  return status.code === 0 ? parseGitStatusPaths(status.stdout) : [];
}

export async function stagedFiles(commandRunner: CommandRunner, cwd: string): Promise<string[]> {
  const staged = await commandRunner.run('git', ['diff', '--cached', '--name-only'], {
    cwd,
    ignoreFailure: true,
  });
  if (staged.code !== 0) {
    return [];
  }
  return staged.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

export function scopeViolations(changed: string[], allowed: string[]): string[] {
  return unexpectedFiles(changed, allowed);
}

export async function validateWorkspaceScope(
  commandRunner: CommandRunner,
  cwd: string,
  allowedPaths: string[],
  label: string,
): Promise<{ ok: boolean; reason?: string }> {
  const modified = await changedFiles(commandRunner, cwd);
  const unexpected = scopeViolations(modified, allowedPaths);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `${label}: touched ${unexpected.slice(0, 8).join(', ')}`,
    };
  }
  return { ok: true };
}

export async function validateWorkspaceScopeDelta(
  commandRunner: CommandRunner,
  cwd: string,
  allowedPaths: string[],
  baselineDirty: Set<string>,
  label: string,
): Promise<{ ok: boolean; reason?: string }> {
  const current = await changedFiles(commandRunner, cwd);
  const newlyModified = current.filter(file => !baselineDirty.has(file));
  const unexpected = scopeViolations(newlyModified, allowedPaths);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `${label}: touched ${unexpected.slice(0, 8).join(', ')}`,
    };
  }
  return { ok: true };
}

export async function validateStagedWorkspace(
  commandRunner: CommandRunner,
  cwd: string,
  allowedPaths: string[],
  label: string,
): Promise<{ ok: boolean; reason?: string }> {
  const staged = await stagedFiles(commandRunner, cwd);
  const unexpected = unexpectedFiles(staged, allowedPaths);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `${label}: staged ${unexpected.slice(0, 8).join(', ')}`,
    };
  }
  return { ok: true };
}

export function bookkeepingPaths(config: BacklogRunnerConfig): string[] {
  return [
    normalizePathForGit(path.relative(config.projectRoot, config.files.candidateQueue)),
    normalizePathForGit(path.relative(config.projectRoot, config.files.taskSpecsDir)),
    normalizePathForGit(path.relative(config.projectRoot, config.files.backlog)),
    normalizePathForGit(path.relative(config.projectRoot, config.files.progress)),
    normalizePathForGit(path.relative(config.projectRoot, config.files.patterns)),
  ];
}

export function taskExecutionPaths(config: BacklogRunnerConfig, touchPaths: string[]): string[] {
  return [...new Set([...touchPaths.map(normalizePathForGit), ...bookkeepingPaths(config)])];
}

export function taskCommitExclusionPaths(config: BacklogRunnerConfig): string[] {
  return [
    normalizePathForGit(path.relative(config.projectRoot, config.files.runtimeDir)),
    normalizePathForGit(path.relative(config.projectRoot, config.files.stop)),
  ].filter(Boolean);
}

export async function runValidationCommand(
  commandRunner: CommandRunner,
  command: string,
  cwd: string,
): Promise<ValidationCommandResult> {
  const startedAt = Date.now();
  const result = await commandRunner.runShell(command, {
    cwd,
    ignoreFailure: true,
  });
  const durationSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  return {
    ok: result.code === 0,
    code: result.code,
    summary: summarizeCommandOutput(result.stdout, result.stderr),
    stdout: result.stdout,
    stderr: result.stderr,
    durationSeconds,
  };
}

export interface LoggedAgentPhaseOptions {
  commandRunner: CommandRunner;
  options: ResolvedRunOptions;
  logger: RunnerLogger;
  role: BacklogRunnerRole;
  label: string;
  context: string | AgentContextPayload;
  prompt: string;
  cwd: string;
  maxTurns: number;
  includeMeta?: boolean;
  onProgress?: AgentRunRequest['onProgress'];
}

export async function runLoggedAgentPhase({
  commandRunner,
  options,
  logger,
  role,
  label,
  context,
  prompt,
  cwd,
  maxTurns,
  includeMeta = false,
  onProgress,
}: LoggedAgentPhaseOptions): Promise<AgentResult> {
  const runner = getRunnerConfig(options, role);
  const contextPayload = typeof context === 'string'
    ? { context }
    : {
        context: `${context.prefix}\n\n${context.tail}`,
        contextPrefix: context.prefix,
        contextTail: context.tail,
      };
  const result = await runProvider(commandRunner, {
    tool: runner.tool,
    model: runner.model,
    ...contextPayload,
    prompt,
    cwd,
    maxTurns,
    schema: JSON_SCHEMA,
    onProgress,
  });

  logger.line(`  ${result.status === 'done' ? '✓' : '✗'} ${label}: ${result.item}`);
  if (result.note) logger.line(`    ${result.note}`);
  if (includeMeta) {
    const meta = [
      result.turns ? `${result.turns} turns` : '',
      result.durationSeconds ? formatDuration(result.durationSeconds) : '',
      result.costUsd ? `$${result.costUsd.toFixed(2)}` : '',
    ].filter(Boolean);
    if (meta.length > 0) {
      logger.line(`    ${meta.join(' · ')}`);
    }
  }

  return result;
}

export interface ValidationPhaseResult {
  ok: boolean;
  summary: string;
  durationSeconds: number;
  failureReason?: string;
}

export async function runValidationPhase(
  commandRunner: CommandRunner,
  command: string,
  cwd: string,
  failurePrefix: string,
): Promise<ValidationPhaseResult> {
  const result = await runValidationCommand(commandRunner, command, cwd);
  return {
    ok: result.ok,
    summary: result.summary,
    durationSeconds: result.durationSeconds,
    failureReason: result.ok ? undefined : `${failurePrefix}: ${result.summary}`,
  };
}

export async function verifyValidationPhase(
  commandRunner: CommandRunner,
  command: string,
  cwd: string,
  failurePrefix: string,
): Promise<{ ok: boolean; reason?: string }> {
  const result = await runValidationPhase(commandRunner, command, cwd, failurePrefix);
  return result.ok
    ? { ok: true }
    : { ok: false, reason: result.failureReason };
}

export async function readPrompt(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export async function diffForPaths(
  commandRunner: CommandRunner,
  cwd: string,
  allowedPaths?: string[],
): Promise<string> {
  if (!allowedPaths || allowedPaths.length === 0) {
    const result = await commandRunner.run('git', ['diff', '--no-ext-diff'], {
      cwd,
      ignoreFailure: true,
    });
    return result.code === 0 ? result.stdout.trim() : '';
  }
  const result = await commandRunner.run('git', ['diff', '--no-ext-diff', '--', ...allowedPaths], {
    cwd,
    ignoreFailure: true,
  });
  return result.code === 0 ? result.stdout.trim() : '';
}

export function normalizeInlineNote(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function drainCandidateQueuePhase(
  store: BacklogStore,
  logger: RunnerLogger,
  label = 'Candidate planner',
): Promise<BacklogDrainResult> {
  const result = await store.drainCandidateQueue();
  logDrainResult(logger, label, result);
  return result;
}

export interface PersistLifecyclePhaseOptions {
  store: BacklogStore;
  workspaceStrategy: WorkspaceStrategy;
  logger: RunnerLogger;
  config: BacklogRunnerConfig;
  commitMessage: string;
  retryPendingPush?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onPersisted: (drainResult: BacklogDrainResult) => Promise<void>;
}

export interface PersistLifecyclePhaseResult {
  ok: boolean;
  queuedFollowups: number;
  finalizeResult: WorkspaceApplyResult;
}

export async function persistLifecyclePhase({
  store,
  workspaceStrategy,
  logger,
  config,
  commitMessage,
  retryPendingPush = false,
  sleep,
  onPersisted,
}: PersistLifecyclePhaseOptions): Promise<PersistLifecyclePhaseResult> {
  const drainResult = await drainCandidateQueuePhase(store, logger);
  const finalizeResult = await workspaceStrategy.commitAndPush(
    commitMessage,
    taskCommitExclusionPaths(config),
    { retryPendingPush, sleep, scopeMode: 'all-except' },
  );
  if (finalizeResult.ok) {
    await onPersisted(drainResult);
  }
  return {
    ok: finalizeResult.ok,
    queuedFollowups: drainResult.createdTasks,
    finalizeResult,
  };
}

export function workerDurationSeconds(startedAt: number): number {
  return Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
}

export function taskWorkerResult(
  kind: BacklogWorkerResult['kind'],
  claim: BacklogTaskClaim,
  startedAt: number,
  options: Partial<Omit<BacklogWorkerResult, 'kind' | 'taskId' | 'durationSeconds' | 'queuedFollowups'>> & {
    queuedFollowups?: number;
  } = {},
): BacklogWorkerResult {
  return {
    kind,
    taskId: claim.task.id,
    durationSeconds: workerDurationSeconds(startedAt),
    queuedFollowups: options.queuedFollowups ?? 0,
    note: options.note,
    validationSummary: options.validationSummary,
    retryAt: options.retryAt,
  };
}

export function genericWorkerResult(
  kind: BacklogWorkerResult['kind'],
  startedAt: number,
  options: Partial<Omit<BacklogWorkerResult, 'kind' | 'durationSeconds' | 'queuedFollowups'>> & {
    queuedFollowups?: number;
  } = {},
): BacklogWorkerResult {
  return {
    kind,
    durationSeconds: workerDurationSeconds(startedAt),
    queuedFollowups: options.queuedFollowups ?? 0,
    note: options.note,
    taskId: options.taskId,
    validationSummary: options.validationSummary,
    retryAt: options.retryAt,
  };
}

export type AgentErrorKind = 'auth' | 'rate_limited' | 'other';

export function classifyAgentError(error: unknown): { kind: AgentErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (isAuthFailure(message)) return { kind: 'auth', message };
  if (isRateLimited(message)) return { kind: 'rate_limited', message };
  return { kind: 'other', message };
}
