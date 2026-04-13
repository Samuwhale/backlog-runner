import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureConfigReady, resolveRunOptions } from '../config.js';
import { createDefaultLogSink, RunnerLogger } from '../logger.js';
import { isOrchestratorStatusLive, ORCHESTRATOR_STATUS_FILE } from '../orchestrator-status.js';
import { plannerBatchSize } from '../planner.js';
import { createCommandRunner, sleep as defaultSleep } from '../process.js';
import { createFileBackedTaskStore } from '../store/task-store.js';
import { fileExists, isPidAlive } from '../utils.js';
import type {
  BacklogRunnerConfig,
  BacklogStore,
  BacklogSyncResult,
  BacklogTaskClaim,
  BacklogWorkerResult,
  OrchestratorRuntimeStatus,
  RunnerDependencies,
  RunOverrides,
  WorkspaceStrategy,
} from '../types.js';
import { BACKLOG_RUNNER_ROLES } from '../types.js';
import { GitWorktreeWorkspaceStrategy } from '../workspace/git-worktree.js';
import { InPlaceWorkspaceStrategy } from '../workspace/in-place.js';
import { formatStaleSharedInstallState, inspectSharedInstallState } from '../workspace/shared-install.js';
import {
  EMPTY_QUEUE_POLL_INTERVAL_MS,
  ORCHESTRATOR_POLL_INTERVAL_MS,
  PLANNER_LANE_READY_TARGET,
  PLANNER_NO_PROGRESS_COOLDOWN_MS,
  RATE_LIMIT_BACKOFF_MS,
} from './constants.js';
import { formatDuration, genericWorkerResult, getRunnerConfig, logDrainResult } from './helpers.js';
import { runDiscoveryWorker, runPlannerWorker, runTaskWorker } from './workers.js';

const BLOCKED_DISCOVERY_MAX_BACKOFF_MS = 10 * 60 * 1000;
type DiscoveryLaunchMode = 'empty' | 'blocked';
const ORCHESTRATOR_TAKEOVER_GRACE_MS = 15_000;
const ORCHESTRATOR_TAKEOVER_KILL_TIMEOUT_MS = 10_000;

type ActiveControlWorker = {
  kind: 'planner' | 'discovery';
  promise: Promise<BacklogWorkerResult>;
  batchKey?: string;
  passId?: string;
  discoveryMode?: DiscoveryLaunchMode;
};

function describeActiveControlWorker(worker: ActiveControlWorker | null): string {
  return worker ? worker.kind : 'idle';
}

function collectActiveControlPromises(worker: ActiveControlWorker | null): Promise<BacklogWorkerResult>[] {
  return worker ? [worker.promise] : [];
}

function renderLoopSummary(options: {
  iteration: number;
  ready: number;
  blocked: number;
  planned: number;
  inProgress: number;
  taskWorkers: number;
  effectiveWorkers: number;
  activeControlKind: string;
  previousCompletedTaskDuration: number;
}): string[] {
  return [
    '═══════════════════════════════════════════════════════════════',
    `  #${options.iteration} · ${options.ready} ready · ${options.blocked} blocked · ${options.planned} planned · ${options.inProgress} in-progress` +
      (options.previousCompletedTaskDuration ? ` · last task ${formatDuration(options.previousCompletedTaskDuration)}` : ''),
    `  Active workers: ${options.taskWorkers}/${options.effectiveWorkers} task · ${options.activeControlKind} control`,
    '═══════════════════════════════════════════════════════════════',
  ];
}

async function writeOrchestratorStatus(config: BacklogRunnerConfig, status: OrchestratorRuntimeStatus): Promise<void> {
  try {
    await writeFile(
      path.join(config.files.runtimeDir, ORCHESTRATOR_STATUS_FILE),
      `${JSON.stringify(status, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    if (!shouldIgnoreOrchestratorStatusError(error)) {
      throw error;
    }
  }
}

async function clearOrchestratorStatus(config: BacklogRunnerConfig): Promise<void> {
  try {
    await rm(path.join(config.files.runtimeDir, ORCHESTRATOR_STATUS_FILE), { force: true });
  } catch (error) {
    if (!shouldIgnoreOrchestratorStatusError(error)) {
      throw error;
    }
  }
}

async function readOrchestratorStatus(config: BacklogRunnerConfig): Promise<OrchestratorRuntimeStatus | null> {
  try {
    const content = await readFile(path.join(config.files.runtimeDir, ORCHESTRATOR_STATUS_FILE), 'utf8');
    return JSON.parse(content) as OrchestratorRuntimeStatus;
  } catch {
    return null;
  }
}

function shouldIgnoreOrchestratorStatusError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EINVAL';
}

export class LiveOrchestratorError extends Error {
  constructor(
    readonly config: BacklogRunnerConfig,
    readonly status: OrchestratorRuntimeStatus,
  ) {
    super(formatLiveOrchestratorMessage(config, status));
    this.name = 'LiveOrchestratorError';
  }
}

function formatLiveOrchestratorMessage(config: BacklogRunnerConfig, status: OrchestratorRuntimeStatus): string {
  const activeTasks = status.activeTaskWorkers.map(worker => worker.title);
  const activeTaskSummary = activeTasks.length === 0
    ? 'No active task workers were recorded in the last status heartbeat.'
    : `Active task workers: ${activeTasks.join(' · ')}.`;
  const shutdownSummary = status.shutdownRequested
    ? 'The existing orchestrator has already been asked to stop; wait for it to settle before starting a new one.'
    : `To stop it cleanly, run: touch ${config.files.stop}`;
  return `Another backlog orchestrator is already running (${status.orchestratorId}, pid ${status.pid}). ${activeTaskSummary} Runtime report: ${config.files.runtimeReport}. ${shutdownSummary}`;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function waitForPollInterval(
  sleep: (ms: number) => Promise<void>,
  ms: number,
): Promise<void> {
  await sleep(ms);
  await yieldToEventLoop();
}

async function waitForOrchestratorExit(
  config: BacklogRunnerConfig,
  orchestratorId: string,
  orchestratorPid: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentStatus = await readOrchestratorStatus(config);
    if (!isPidAlive(orchestratorPid)) {
      return true;
    }
    if (!currentStatus) {
      await waitForPollInterval(sleep, Math.min(ORCHESTRATOR_POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
      continue;
    }
    if (currentStatus.orchestratorId !== orchestratorId) {
      await waitForPollInterval(sleep, Math.min(ORCHESTRATOR_POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
      continue;
    }
    if (!isPidAlive(currentStatus.pid)) {
      return true;
    }
    await waitForPollInterval(sleep, Math.min(ORCHESTRATOR_POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
  }
  return false;
}

async function takeOverLiveOrchestrator(
  config: BacklogRunnerConfig,
  logger: RunnerLogger,
  status: OrchestratorRuntimeStatus,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  logger.line(`  Live orchestrator detected: ${status.orchestratorId} (pid ${status.pid})`);
  if (!status.shutdownRequested) {
    await writeFile(config.files.stop, 'stop\n', 'utf8');
    logger.line(`  Requested shutdown for existing orchestrator via ${config.files.stop}`);
  } else {
    logger.line('  Existing orchestrator already has shutdown requested — waiting for it to settle.');
  }

  const stoppedGracefully = await waitForOrchestratorExit(
    config,
    status.orchestratorId,
    status.pid,
    ORCHESTRATOR_TAKEOVER_GRACE_MS,
    sleep,
  );
  if (!stoppedGracefully && isPidAlive(status.pid)) {
    logger.line(`  Existing orchestrator did not stop in time — sending SIGTERM to pid ${status.pid}`);
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {
      // The process may already have exited; the liveness check below decides the next step.
    }
  }

  const stoppedAfterSignal = stoppedGracefully || await waitForOrchestratorExit(
    config,
    status.orchestratorId,
    status.pid,
    ORCHESTRATOR_TAKEOVER_KILL_TIMEOUT_MS,
    sleep,
  );
  if (!stoppedAfterSignal) {
    throw new Error(
      `Timed out waiting for orchestrator ${status.orchestratorId} (pid ${status.pid}) to stop. Runtime report: ${config.files.runtimeReport}`,
    );
  }

  await clearOrchestratorStatus(config);
  await rm(config.files.stop, { force: true });
  logger.line(`  Existing orchestrator stopped — taking over with a new run.`);
}

function shouldAttemptPlannerBatch(
  batchKey: string,
  waitingPlannerBatchKey: string | null,
): boolean {
  return batchKey !== waitingPlannerBatchKey;
}

async function pruneGitWorktrees(
  commandRunner: ReturnType<typeof createCommandRunner>,
  config: BacklogRunnerConfig,
  logger: RunnerLogger,
): Promise<void> {
  const result = await commandRunner.run('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: config.projectRoot,
    ignoreFailure: true,
  });
  if (result.code !== 0) {
    logger.line('  WARNING: git worktree prune --expire now failed');
  }
}

async function currentPlannerBatchKey(
  store: BacklogStore,
): Promise<string> {
  const plannerCandidates = await store.listPlannerCandidates(plannerBatchSize());
  return plannerCandidates.map(task => task.id).join(',');
}

async function ensureOrchestratorAvailable(
  config: BacklogRunnerConfig,
  logger: RunnerLogger,
  options: { takeover?: boolean; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  const status = await readOrchestratorStatus(config);
  if (!status) return;

  if (isOrchestratorStatusLive(status)) {
    if (options.takeover) {
      await takeOverLiveOrchestrator(config, logger, status, options.sleep);
      return;
    }
    throw new LiveOrchestratorError(config, status);
  }

  await clearOrchestratorStatus(config);
  logger.line(`  Reclaimed stale orchestrator status: ${status.orchestratorId} (pid ${status.pid ?? 'unknown'})`);
}

async function ensureSharedInstallStartupReadiness(
  config: BacklogRunnerConfig,
  logger: RunnerLogger,
  worktreesEnabled: boolean,
): Promise<void> {
  if (!worktreesEnabled) {
    return;
  }

  const inspection = await inspectSharedInstallState(config.projectRoot);
  if (inspection.staleSymlinks.length === 0) {
    return;
  }

  const message = formatStaleSharedInstallState(inspection, config.workspaceBootstrap);
  logger.line(`  ✗ ${message}`);
  throw new Error(message);
}

export async function syncBacklogRunner(config: BacklogRunnerConfig): Promise<BacklogSyncResult> {
  await ensureConfigReady(config);
  const store = createFileBackedTaskStore(config);
  try {
    await store.ensureProgressFile();
    await store.ensureTaskSpecsReady();
    const candidates = await store.drainCandidateQueue();
    const counts = await store.getQueueCounts();
    return { candidates, counts };
  } finally {
    await store.close();
  }
}

export async function runBacklogRunner(
  config: BacklogRunnerConfig,
  overrides: RunOverrides = {},
  dependencies: RunnerDependencies = {},
): Promise<void> {
  await ensureConfigReady(config);
  const sleep = dependencies.sleep ?? defaultSleep;
  const logSink = await (dependencies.createLogSink?.(config) ?? createDefaultLogSink(config));
  const logger = new RunnerLogger(logSink);
  const commandRunner = dependencies.commandRunner ?? createCommandRunner();
  const store = createFileBackedTaskStore(config);
  const options = await resolveRunOptions(config, overrides);
  const effectiveWorkers = options.worktrees ? options.workers : 1;
  const workspaceStrategy: WorkspaceStrategy = options.worktrees
    ? new GitWorktreeWorkspaceStrategy(commandRunner, config)
    : new InPlaceWorkspaceStrategy(commandRunner, config);
  const orchestratorId = `${process.pid}-${Date.now()}`;
  let ownsOrchestratorStatus = false;

  await ensureOrchestratorAvailable(config, logger, { takeover: overrides.takeover, sleep });
  await ensureSharedInstallStartupReadiness(config, logger, options.worktrees);

  if (options.worktrees) {
    await pruneGitWorktrees(commandRunner, config, logger);
  }

  let stopRequested = false;
  let fatalError: Error | null = null;
  let rateLimitUntil = 0;
  let discoveryCooldownUntil = 0;
  let blockedDiscoveryCooldownUntil = 0;
  let blockedDiscoveryBackoffMs = EMPTY_QUEUE_POLL_INTERVAL_MS;
  let plannerCooldownBatchKey: string | null = null;
  let plannerCooldownUntil = 0;
  let iteration = 0;
  let previousCompletedTaskDuration = 0;
  let lastLoopSummaryKey = '';
  let lastBlockedStateKey = '';

  const taskWorkers = new Map<string, { title: string; promise: Promise<BacklogWorkerResult> }>();
  let controlWorker: ActiveControlWorker | null = null;

  const updateStatus = async (): Promise<void> => {
    ownsOrchestratorStatus = true;
    const status: OrchestratorRuntimeStatus = {
      orchestratorId,
      pid: process.pid,
      requestedWorkers: options.workers,
      effectiveWorkers,
      activeTaskWorkers: [...taskWorkers.entries()].map(([taskId, worker]) => ({ taskId, title: worker.title })),
      activeControlWorker: controlWorker
        ? controlWorker.kind === 'planner'
          ? { kind: 'planner' }
          : { kind: 'discovery', passId: controlWorker.passId }
        : undefined,
      shutdownRequested: stopRequested || fatalError !== null,
      pollIntervalMs: ORCHESTRATOR_POLL_INTERVAL_MS,
      updatedAt: new Date().toISOString(),
    };
    await writeOrchestratorStatus(config, status);
    await store.getQueueCounts();
  };

  const resetBlockedDiscoveryBackoff = (): void => {
    blockedDiscoveryCooldownUntil = 0;
    blockedDiscoveryBackoffMs = EMPTY_QUEUE_POLL_INTERVAL_MS;
  };

  const handleTaskWorkerResult = (result: BacklogWorkerResult): void => {
    if (result.durationSeconds > 0) {
      previousCompletedTaskDuration = result.durationSeconds;
    }
    if (result.kind === 'rate_limited') {
      rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    }
  };

  const handleControlWorkerResult = (
    kind: 'planner' | 'discovery',
    batchKey: string | undefined,
    result: BacklogWorkerResult,
    discoveryMode?: DiscoveryLaunchMode,
  ): void => {
    if (result.kind === 'rate_limited') {
      rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      return;
    }
    if (kind === 'planner') {
      if (result.kind === 'completed') {
        plannerCooldownBatchKey = null;
        plannerCooldownUntil = 0;
        return;
      }
      plannerCooldownBatchKey = batchKey ?? null;
      plannerCooldownUntil = Date.now() + PLANNER_NO_PROGRESS_COOLDOWN_MS;
      return;
    }
    if (kind === 'discovery') {
      if (discoveryMode === 'blocked') {
        if (result.kind === 'completed') {
          resetBlockedDiscoveryBackoff();
          return;
        }
        blockedDiscoveryCooldownUntil = Date.now() + blockedDiscoveryBackoffMs;
        blockedDiscoveryBackoffMs = Math.min(BLOCKED_DISCOVERY_MAX_BACKOFF_MS, blockedDiscoveryBackoffMs * 2);
        return;
      }
      discoveryCooldownUntil = result.kind === 'completed' ? 0 : Date.now() + EMPTY_QUEUE_POLL_INTERVAL_MS;
    }
  };

  const launchTaskWorker = (claim: BacklogTaskClaim): void => {
    const promise = runTaskWorker(
      config,
      store,
      workspaceStrategy,
      commandRunner,
      logger,
      options,
      claim,
      sleep,
    )
      .then(result => {
        handleTaskWorkerResult(result);
        return result;
      })
      .catch(error => {
        fatalError = error instanceof Error ? error : new Error(String(error));
        logger.line(`  ✗ ${fatalError.message}`);
        return genericWorkerResult('failed', Date.now(), { note: fatalError.message });
      })
      .finally(async () => {
        taskWorkers.delete(claim.task.id);
        try {
          await updateStatus();
        } catch {
          // Orchestrator status persistence is best-effort while workers settle.
        }
      });
    taskWorkers.set(claim.task.id, { title: claim.task.title, promise });
  };

  const launchPlannerWorker = (batchKey: string): void => {
    const promise = runPlannerWorker(
      config,
      store,
      workspaceStrategy,
      commandRunner,
      logger,
      options,
    )
      .then(result => {
        handleControlWorkerResult('planner', batchKey, result);
        return result;
      })
      .catch(error => {
        fatalError = error instanceof Error ? error : new Error(String(error));
        logger.line(`  ✗ ${fatalError.message}`);
        return genericWorkerResult('failed', Date.now(), { note: fatalError.message });
      })
      .finally(async () => {
        controlWorker = null;
        try {
          await updateStatus();
        } catch {
          // Orchestrator status persistence is best-effort while workers settle.
        }
      });
    controlWorker = { kind: 'planner', promise, batchKey };
  };

  const launchDiscoveryWorker = (discoveryMode: DiscoveryLaunchMode): Promise<BacklogWorkerResult> => {
    const promise = runDiscoveryWorker(
      config,
      store,
      workspaceStrategy,
      commandRunner,
      logger,
      options,
      sleep,
      (passId) => { if (controlWorker) controlWorker.passId = passId; },
    )
      .then(result => {
        handleControlWorkerResult('discovery', undefined, result, discoveryMode);
        if (discoveryMode === 'blocked') {
          if (result.kind === 'completed') {
            logger.line('  Blocked-state discovery made progress — resuming normal scheduling.');
          } else if (result.kind === 'no_progress') {
            logger.line(`  Blocked-state discovery made no progress — retrying in ${formatDuration(Math.ceil((blockedDiscoveryCooldownUntil - Date.now()) / 1000))}.`);
          }
        }
        return result;
      })
      .catch(error => {
        fatalError = error instanceof Error ? error : new Error(String(error));
        logger.line(`  ✗ ${fatalError.message}`);
        return genericWorkerResult('failed', Date.now(), { note: fatalError.message });
      })
      .finally(async () => {
        controlWorker = null;
        try {
          await updateStatus();
        } catch {
          // Orchestrator status persistence is best-effort while workers settle.
        }
      });
    controlWorker = { kind: 'discovery', promise, discoveryMode };
    return promise;
  };

  const onSignal = () => {
    stopRequested = true;
    logger.line('');
    logger.line('  → Stop requested — stopping new dispatch and waiting for in-flight workers.');
    void updateStatus();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await store.ensureProgressFile();
    await store.ensureTaskSpecsReady();
    const startupReap = await store.reapStaleRuntimeState();
    if (startupReap.deadRunnerLeases > 0) {
      logger.line(`  Reclaimed ${startupReap.deadRunnerLeases} dead-runner lease${startupReap.deadRunnerLeases === 1 ? '' : 's'}.`);
    }
    logDrainResult(logger, 'Candidate planner', await store.drainCandidateQueue());

    logger.line('');
    logger.line('╔═══════════════════════════════════════════════════════════════╗');
    logger.line('║  TypeScript Backlog Runner                                  ║');
    logger.line('╚═══════════════════════════════════════════════════════════════╝');
    logger.line(`  Orchestrator: ${orchestratorId}`);
    logger.line(`  Workers:      ${effectiveWorkers}${effectiveWorkers !== options.workers ? ` (requested ${options.workers})` : ''}`);
    logger.line(`  Mode:         ${options.worktrees ? 'parallel (worktrees)' : 'single (shared workspace)'}`);
    logger.line(`  Passes:       ${options.passes ? 'enabled' : 'disabled'}`);
    logger.line('  Runners:');
    for (const role of BACKLOG_RUNNER_ROLES) {
      const runner = getRunnerConfig(options, role);
      logger.line(`    ${role.padEnd(9, ' ')} ${runner.tool}${runner.model ? ` · ${runner.model}` : ''}`);
    }
    logger.line(`  Stop:         Ctrl+C  (or: touch ${config.files.stop})`);
    await updateStatus();

    while (!stopRequested && !fatalError && !(await fileExists(config.files.stop))) {
      iteration += 1;
      logDrainResult(logger, 'Candidate planner', await store.drainCandidateQueue());
      const queueState = await store.getQueueState();
      if (queueState.reapResult.deadRunnerLeases > 0) {
        logger.line(`  Reclaimed ${queueState.reapResult.deadRunnerLeases} dead-runner lease${queueState.reapResult.deadRunnerLeases === 1 ? '' : 's'}.`);
      }
      const counts = queueState.counts;
      const activeControlKind = describeActiveControlWorker(controlWorker);
      const blockedOnlyIdle = (
        !controlWorker
        && taskWorkers.size === 0
        && counts.ready === 0
        && counts.planned === 0
        && counts.failed === 0
        && counts.inProgress === 0
        && counts.blocked > 0
      );
      const blockedStateKey = (
        blockedOnlyIdle
      )
        ? JSON.stringify({
            ready: counts.ready,
            blocked: counts.blocked,
            planned: counts.planned,
            inProgress: counts.inProgress,
            failed: counts.failed,
            activeControlKind,
            blockages: [...queueState.blockages]
              .map(blockage => `${blockage.taskId}:${blockage.reason}:${blockage.retryAt ?? ''}`)
              .sort(),
          })
        : '';
      if (blockedStateKey !== lastBlockedStateKey) {
        resetBlockedDiscoveryBackoff();
        lastBlockedStateKey = blockedStateKey;
      }
      const loopSummary = renderLoopSummary({
        iteration,
        ready: counts.ready,
        blocked: counts.blocked,
        planned: counts.planned,
        inProgress: counts.inProgress,
        taskWorkers: taskWorkers.size,
        effectiveWorkers,
        activeControlKind,
        previousCompletedTaskDuration,
      });
      const loopSummaryKey = JSON.stringify({
        ready: counts.ready,
        blocked: counts.blocked,
        planned: counts.planned,
        inProgress: counts.inProgress,
        taskWorkers: taskWorkers.size,
        effectiveWorkers,
        activeControlKind,
        previousCompletedTaskDuration,
      });
      const now = Date.now();
      if (loopSummaryKey !== lastLoopSummaryKey) {
        logger.line('');
        for (const line of loopSummary) {
          logger.line(line);
        }
        lastLoopSummaryKey = loopSummaryKey;
      }

      await updateStatus();

      if (now < rateLimitUntil) {
        logger.line(`  Rate limit backoff active until ${new Date(rateLimitUntil).toTimeString().slice(0, 8)}.`);
        await waitForPollInterval(sleep, ORCHESTRATOR_POLL_INTERVAL_MS);
        continue;
      }

      if (!controlWorker && (counts.failed > 0 || (counts.planned > 0 && counts.ready < PLANNER_LANE_READY_TARGET))) {
        const batchKey = await currentPlannerBatchKey(store);
        const plannerCooldownActive = plannerCooldownBatchKey === batchKey && now < plannerCooldownUntil;
        if (batchKey && shouldAttemptPlannerBatch(batchKey, plannerCooldownActive ? plannerCooldownBatchKey : null)) {
          launchPlannerWorker(batchKey);
          await updateStatus();
          continue;
        }
      }

      if (taskWorkers.size < effectiveWorkers) {
        const claims = await store.claimNextRunnableTasks(effectiveWorkers - taskWorkers.size, orchestratorId);
        for (const claim of claims) {
          launchTaskWorker(claim);
        }
        if (claims.length > 0) {
          await updateStatus();
          continue;
        }
      }

      if (
        !controlWorker
        && taskWorkers.size === 0
        && counts.ready === 0
        && counts.planned === 0
        && counts.failed === 0
        && counts.inProgress === 0
        && options.passes
      ) {
        if (counts.blocked === 0 && now >= discoveryCooldownUntil) {
          logger.line('  No tasks found — running discovery passes to replenish backlog…');
          await launchDiscoveryWorker('empty');
          await updateStatus();
          continue;
        }
        if (counts.blocked > 0 && now >= blockedDiscoveryCooldownUntil) {
          logger.line('  No runnable tasks remain — running discovery passes to unblock backlog…');
          await launchDiscoveryWorker('blocked');
          await updateStatus();
          continue;
        }
      }

      if (!controlWorker && taskWorkers.size === 0 && counts.ready === 0 && counts.planned === 0 && counts.failed === 0) {
        if (!options.passes) {
          logger.line(counts.blocked > 0
            ? '  No runnable tasks remain and discovery passes are disabled — stopping.'
            : '  Task queue empty and discovery passes are disabled — stopping.');
          break;
        }
      }

      if (!controlWorker && taskWorkers.size === 0 && counts.ready === 0 && (counts.planned > 0 || counts.failed > 0)) {
        const batchKey = await currentPlannerBatchKey(store);
        const plannerStalled = batchKey && plannerCooldownBatchKey === batchKey && Date.now() < plannerCooldownUntil;
        if (plannerStalled) {
          logger.line('  No runnable tasks remain and planner refinement made no progress — stopping.');
          break;
        }
      }

      await waitForPollInterval(sleep, ORCHESTRATOR_POLL_INTERVAL_MS);
    }

    if (fatalError || stopRequested || await fileExists(config.files.stop)) {
      await updateStatus();
    }

    if (controlWorker || taskWorkers.size > 0) {
      logger.line('');
      logger.line('  Waiting for in-flight workers to settle…');
      await Promise.allSettled([
        ...[...taskWorkers.values()].map(worker => worker.promise),
        ...collectActiveControlPromises(controlWorker),
      ]);
    }

    if (fatalError) {
      throw fatalError;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (ownsOrchestratorStatus) {
      await clearOrchestratorStatus(config);
    }
    try {
      await store.close();
    } finally {
      await logger.close();
    }
  }
}
