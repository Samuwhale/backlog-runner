import path from 'node:path';
import { createAgentTranscriptRecorder } from '../agent-progress.js';
import { buildDiscoveryContext, buildExecutionContext, buildPlannerContext } from '../context.js';
import { normalizePathForGit } from '../git-scope.js';
import type { RunnerLogger } from '../logger.js';
import { withLock, lockPath } from '../locks.js';
import { PLANNER_RESULT_SCHEMA, parsePlannerSupersedeAction, plannerBatchSize } from '../planner.js';
import { runProvider } from '../providers/index.js';
import { JSON_SCHEMA } from '../providers/common.js';
import { normalizeWhitespace } from '../utils.js';
import type {
  AgentResult,
  BacklogPassType,
  BacklogRunnerConfig,
  BacklogStore,
  BacklogTaskClaim,
  BacklogWorkerResult,
  CommandRunner,
  ResolvedRunOptions,
  WorkspaceSession,
  WorkspaceStrategy,
} from '../types.js';
import { BACKLOG_DISCOVERY_PASSES } from '../types.js';
import {
  MAIN_REPO_INSTALL_REQUIRED_CODE,
  containsSharedInstallPolicyCode,
  formatSharedInstallRecoveryInstruction,
  touchesDependencyManifest,
} from '../workspace/shared-install.js';
import { PREFLIGHT_DEFERRAL_MS } from './constants.js';
import {
  bookkeepingPaths,
  changedFiles,
  classifyAgentError,
  diffForPaths,
  formatDuration,
  genericWorkerResult,
  getRunnerConfig,
  implementationRunnerRole,
  logDrainResult,
  readPrompt,
  retryTime,
  runValidationPhase,
  taskExecutionPaths,
  taskWorkerResult,
  validateStagedWorkspace,
  validateWorkspaceScope,
  validateWorkspaceScopeDelta,
  verifyValidationPhase,
} from './helpers.js';
import {
  applyClaimRepairOutcome,
  attemptTaskReconciliation,
  tryWithRemediation,
} from './remediation.js';
import {
  persistTaskLifecyclePhase,
  resolveValidationFailureDisposition,
  runLifecycleAgentPhase,
  withFailureReason,
} from './task-lifecycle.js';

async function runSingleDiscoveryPass(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  workspaceStrategy: WorkspaceStrategy,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  passType: BacklogPassType,
  sleep?: (ms: number) => Promise<void>,
): Promise<BacklogWorkerResult> {
  const startedAt = Date.now();
  logger.line('');
  logger.line('================================================================');
  logger.line(`  ★ Maintenance Pass: ${passType}`);
  logger.line('================================================================');

  const session = await workspaceStrategy.setup();
  try {
    const baselineDirty = new Set(await changedFiles(commandRunner, session.cwd));
    const context = await buildDiscoveryContext(config);
    const runner = getRunnerConfig(options, passType);
    const result = await runProvider(commandRunner, {
      tool: runner.tool,
      model: runner.model,
      context,
      prompt: await readPrompt(config.passes[passType].promptFile),
      cwd: session.cwd,
      maxTurns: 50,
      schema: JSON_SCHEMA,
    });

    if (result.status === 'failed') {
      logger.line(`  ✗ ${passType} pass failed: ${result.item}`);
      if (result.note) logger.line(`    ${result.note}`);
      return genericWorkerResult('no_progress', startedAt, { note: result.note || 'agent reported failure' });
    }

    logger.line(`  ✓ ${passType} pass: ${result.item}`);
    if (result.note) logger.line(`    ${result.note}`);

    const workspaceCheck = await validateWorkspaceScopeDelta(
      commandRunner,
      session.cwd,
      [
        normalizePathForGit(path.relative(config.projectRoot, config.files.candidateQueue)),
        normalizePathForGit(path.relative(config.projectRoot, config.files.progress)),
        normalizePathForGit(path.relative(config.projectRoot, config.files.patterns)),
      ],
      baselineDirty,
      'discovery pass touched non-planner files',
    );
    if (!workspaceCheck.ok) {
      logger.line(`  WARNING: ${workspaceCheck.reason}`);
      return genericWorkerResult('no_progress', startedAt, { note: workspaceCheck.reason });
    }

    const commitMessage = `chore(backlog): ${passType} pass – ${result.item || 'maintenance'}`;
    let persisted = false;
    await withLock(lockPath(config, 'git'), 30, async () => {
      const mergeResult = await session.merge();
      if (!mergeResult.ok) {
        logger.line(`  ✗ ${passType} pass merge failed: ${mergeResult.reason ?? 'unknown'}`);
        return;
      }

      logDrainResult(logger, 'Candidate planner', await store.drainCandidateQueue());
      const finalizeResult = await workspaceStrategy.commitAndPush(commitMessage, bookkeepingPaths(config), { sleep });
      if (!finalizeResult.ok) {
        logger.line(`  ✗ ${passType} pass finalize failed: ${finalizeResult.reason ?? 'unknown'}`);
        return;
      }
      persisted = true;
    });
    if (!persisted) {
      return genericWorkerResult('no_progress', startedAt, { note: `${passType} pass succeeded but persistence failed` });
    }
    return genericWorkerResult('completed', startedAt);
  } catch (error) {
    const classified = classifyAgentError(error);
    if (classified.kind === 'auth') {
      throw new Error('Authentication/permission error — check your API key and tool setup');
    }
    if (classified.kind === 'rate_limited') {
      logger.line(`  ⚠ Rate limit hit during ${passType} pass — skipping`);
      return genericWorkerResult('rate_limited', startedAt, { note: classified.message });
    }
    logger.line(`  · ${passType} pass skipped — ${classified.message}`);
    return genericWorkerResult('no_progress', startedAt, { note: classified.message });
  } finally {
    await session.teardown();
  }
}

export async function runDiscoveryWorker(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  workspaceStrategy: WorkspaceStrategy,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  sleep?: (ms: number) => Promise<void>,
  onPassStart?: (passType: BacklogPassType) => void,
): Promise<BacklogWorkerResult> {
  const startedAt = Date.now();
  const before = await store.getQueueCounts();
  for (const passType of BACKLOG_DISCOVERY_PASSES) {
    onPassStart?.(passType);
    const result = await runSingleDiscoveryPass(config, store, workspaceStrategy, commandRunner, logger, options, passType, sleep);
    if (result.kind === 'rate_limited') {
      return genericWorkerResult('rate_limited', startedAt, { note: result.note });
    }
  }
  const after = await store.getQueueCounts();
  const changed = before.ready !== after.ready
    || before.planned !== after.planned
    || before.failed !== after.failed
    || before.blocked !== after.blocked
    || before.inProgress !== after.inProgress
    || before.done !== after.done;
  return genericWorkerResult(changed ? 'completed' : 'no_progress', startedAt);
}

export async function runPlannerWorker(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  workspaceStrategy: WorkspaceStrategy,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
): Promise<BacklogWorkerResult> {
  const startedAt = Date.now();
  return withLock(lockPath(config, 'planner'), 30, async () => {
    const plannerCandidates = await store.listPlannerCandidates(plannerBatchSize());
    if (plannerCandidates.length === 0) {
      return genericWorkerResult('no_progress', startedAt, { note: 'no planner candidates' });
    }

    logger.line('');
    logger.line('================================================================');
    logger.line('  ★ Planner Refinement Pass');
    logger.line('================================================================');

    const session = await workspaceStrategy.setup();
    try {
      const baselineDirty = new Set(await changedFiles(commandRunner, session.cwd));
      const context = await buildPlannerContext(config, plannerCandidates);
      const runner = getRunnerConfig(options, 'planner');
      const result = await runProvider(commandRunner, {
        tool: runner.tool,
        model: runner.model,
        context,
        prompt: await readPrompt(config.prompts.planner),
        cwd: session.cwd,
        maxTurns: 50,
        schema: PLANNER_RESULT_SCHEMA,
      });

      if (result.status !== 'done') {
        logger.line(`  · planner refinement skipped — ${result.note || 'planner reported failure'}`);
        return genericWorkerResult('no_progress', startedAt, { note: result.note || 'planner reported failure' });
      }

      const workspaceCheck = await validateWorkspaceScopeDelta(
        commandRunner,
        session.cwd,
        [],
        baselineDirty,
        'planner pass touched repo files',
      );
      if (!workspaceCheck.ok) {
        logger.line(`  WARNING: ${workspaceCheck.reason}`);
        return genericWorkerResult('no_progress', startedAt, { note: workspaceCheck.reason });
      }

      const action = parsePlannerSupersedeAction(result.rawOutput, config);
      if (!action) {
        logger.line('  WARNING: planner pass returned invalid structured action payload');
        return genericWorkerResult('no_progress', startedAt, { note: 'planner pass returned invalid structured action payload' });
      }

      const applied = await store.applyPlannerSupersede(action, {
        allowedParentTaskIds: plannerCandidates.map(task => task.id),
      });
      logger.line(`  ✓ planner pass: ${result.item}`);
      if (result.note) logger.line(`    ${result.note}`);
      logger.line(`  ✓ superseded ${applied.parentTaskIds.length} planner candidate${applied.parentTaskIds.length === 1 ? '' : 's'} with ${applied.childTaskIds.length} child task${applied.childTaskIds.length === 1 ? '' : 's'}`);
      return genericWorkerResult('completed', startedAt, { note: result.note });
    } catch (error) {
      const classified = classifyAgentError(error);
      if (classified.kind === 'auth') {
        throw new Error('Authentication/permission error — check your API key and tool setup');
      }
      if (classified.kind === 'rate_limited') {
        logger.line('  ⚠ Rate limit hit during planner refinement — skipping');
        return genericWorkerResult('rate_limited', startedAt, { note: classified.message });
      }
      logger.line(`  · planner refinement skipped — ${classified.message}`);
      return genericWorkerResult('no_progress', startedAt, { note: classified.message });
    } finally {
      await session.teardown();
    }
  });
}

type TaskPhaseResult<T> =
  | { kind: 'continue'; value: T }
  | { kind: 'stop'; result: BacklogWorkerResult };

interface TaskWorkerPhaseContext {
  config: BacklogRunnerConfig;
  store: BacklogStore;
  workspaceStrategy: WorkspaceStrategy;
  commandRunner: CommandRunner;
  logger: RunnerLogger;
  options: ResolvedRunOptions;
  claim: BacklogTaskClaim;
  startedAt: number;
  session: WorkspaceSession;
  transcriptRecorder: Awaited<ReturnType<typeof createAgentTranscriptRecorder>> | null;
  sleep?: (ms: number) => Promise<void>;
}

interface TaskPreflightPhaseValue {
  allowedPaths: string[];
}

interface TaskExecutionPhaseValue extends TaskPreflightPhaseValue {
  agentResult: AgentResult;
  validationCommand: string;
}

interface TaskValidationPhaseValue extends TaskExecutionPhaseValue {
  validationSummary?: string;
}

function continueTaskPhase<T>(value: T): TaskPhaseResult<T> {
  return { kind: 'continue', value };
}

function stopTaskPhase<T>(result: BacklogWorkerResult): TaskPhaseResult<T> {
  return { kind: 'stop', result };
}

async function runTaskPreflightPhase(
  phaseContext: TaskWorkerPhaseContext,
): Promise<TaskPhaseResult<TaskPreflightPhaseValue>> {
  const {
    config,
    store,
    commandRunner,
    logger,
    options,
    claim,
    startedAt,
    session,
  } = phaseContext;
  const allowedPaths = taskExecutionPaths(config, claim.task.touchPaths);

  const stagedPreflight = await validateStagedWorkspace(
    commandRunner,
    session.cwd,
    allowedPaths,
    'dirty workspace preflight',
  );
  if (!stagedPreflight.ok) {
    logger.line(`  WARNING: ${stagedPreflight.reason}`);
    const outcome = await tryWithRemediation(config, store, commandRunner, logger, options, claim, startedAt, {
      mode: 'preflight',
      cwd: session.cwd,
      allowedPaths,
      failureReason: stagedPreflight.reason ?? 'dirty workspace preflight',
      verify: async () => validateStagedWorkspace(commandRunner, session.cwd, allowedPaths, 'dirty workspace preflight'),
    });
    if (!('ok' in outcome)) {
      return stopTaskPhase(outcome);
    }
  }

  if (session.cwd !== config.projectRoot) {
    const mainRepoStagedPreflight = await validateStagedWorkspace(
      commandRunner,
      config.projectRoot,
      allowedPaths,
      'main repo staged preflight',
    );
    if (!mainRepoStagedPreflight.ok) {
      logger.line('  WARNING: main checkout has unexpected staged files — deferring task');
      logger.line(`  (reason: ${mainRepoStagedPreflight.reason})`);
      await store.deferClaim(claim, mainRepoStagedPreflight.reason ?? 'main checkout not clean', 60_000, { category: 'preflight' });
      return stopTaskPhase(taskWorkerResult('deferred', claim, startedAt, {
        note: `main checkout not clean: ${mainRepoStagedPreflight.reason}`,
      }));
    }
  }

  return continueTaskPhase({ allowedPaths });
}

async function runTaskExecutionPhase(
  phaseContext: TaskWorkerPhaseContext,
  preflight: TaskPreflightPhaseValue,
): Promise<TaskPhaseResult<TaskExecutionPhaseValue>> {
  const {
    config,
    store,
    commandRunner,
    logger,
    options,
    claim,
    startedAt,
    session,
    transcriptRecorder,
  } = phaseContext;
  const executionRole = implementationRunnerRole(claim);

  const executionRunner = getRunnerConfig(options, executionRole);
  logger.line(`  Running agent… (started ${new Date().toTimeString().slice(0, 8)})`);
  logger.line(`  Execution domain: ${claim.task.executionDomain} via ${executionRole} (${executionRunner.tool}${executionRunner.model ? ` · ${executionRunner.model}` : ''})`);
  const context = await buildExecutionContext(
    config,
    session.cwd,
    claim,
    await store.getTaskDependencies(claim.task.id),
    await store.getActiveReservations(claim.task.id),
  );
  const agentPhase = await runLifecycleAgentPhase({
    commandRunner,
    options,
    logger,
    executionRole,
    label: 'task run',
    context,
    prompt: await readPrompt(config.prompts.agent),
    cwd: session.cwd,
    maxTurns: 50,
    includeMeta: true,
    failureReason: 'agent reported failure',
    onProgress: async event => {
      if (transcriptRecorder) {
        await transcriptRecorder.record(event);
      }
      if (event.type === 'assistant-message') {
        const milestone = normalizeWhitespace(event.message);
        if (milestone) {
          await store.recordTaskActivity(claim.task.id, {
            transcriptPath: transcriptRecorder?.transcriptPath ?? '',
            milestone,
          });
        }
      }
    },
  });

  if (!agentPhase.ok) {
    await store.failClaim(claim, agentPhase.failureReason);
    return stopTaskPhase(taskWorkerResult('failed', claim, startedAt, {
      note: agentPhase.failureReason,
    }));
  }

  return continueTaskPhase({
    ...preflight,
    agentResult: agentPhase.agentResult,
    validationCommand: config.validationProfiles[claim.task.validationProfile] ?? config.validationCommand,
  });
}

async function runTaskValidationPhase(
  phaseContext: TaskWorkerPhaseContext,
  execution: TaskExecutionPhaseValue,
): Promise<TaskPhaseResult<TaskValidationPhaseValue>> {
  const {
    config,
    store,
    commandRunner,
    logger,
    options,
    claim,
    startedAt,
    session,
  } = phaseContext;

  logger.line('');
  logger.line(`  Running validation profile "${claim.task.validationProfile}": ${execution.validationCommand}`);
  const validation = await runValidationPhase(
    commandRunner,
    execution.validationCommand,
    session.cwd,
    'validation failed',
  );
  if (validation.ok) {
    logger.line(
      `  ✓ validation passed (${formatDuration(validation.durationSeconds) || `${validation.durationSeconds}s`})`,
    );
    return continueTaskPhase({
      ...execution,
      validationSummary: undefined,
    });
  }

  const validationSummary = validation.summary;
  const failureReason = validation.failureReason ?? `validation failed: ${validation.summary}`;
  if (containsSharedInstallPolicyCode(failureReason)) {
    await store.deferClaim(claim, failureReason, PREFLIGHT_DEFERRAL_MS, { category: 'preflight' });
    logger.line(`  ⚠ ${failureReason} — deferred for retry`);
    return stopTaskPhase(taskWorkerResult('deferred', claim, startedAt, {
      note: failureReason,
      validationSummary,
    }));
  }

  const outcome = await tryWithRemediation(config, store, commandRunner, logger, options, claim, startedAt, {
    mode: 'validation',
    cwd: session.cwd,
    allowedPaths: execution.allowedPaths,
    failureReason,
    validationSummary,
    verify: async () => verifyValidationPhase(
      commandRunner,
      execution.validationCommand,
      session.cwd,
      'validation failed',
    ),
  });
  if ('ok' in outcome) {
    logger.line('  ✓ validation recovered by remediation');
    return continueTaskPhase({
      ...execution,
      validationSummary,
    });
  }

  const validationDisposition = await resolveValidationFailureDisposition({
    store,
    logger,
    claim,
    commandRunner,
    cwd: session.cwd,
    failureReason: outcome.note ?? failureReason,
  });
  if (validationDisposition.kind !== 'non_blocking') {
    return stopTaskPhase(outcome);
  }
  return continueTaskPhase({
    ...execution,
    validationSummary,
  });
}

async function runTaskFinalizePhase(
  phaseContext: TaskWorkerPhaseContext,
  validation: TaskValidationPhaseValue,
): Promise<BacklogWorkerResult> {
  const {
    config,
    store,
    workspaceStrategy,
    commandRunner,
    logger,
    options,
    claim,
    startedAt,
    session,
    sleep,
  } = phaseContext;
  const message = `chore(backlog): done – ${validation.agentResult.item || claim.task.title}`;

  return withLock(lockPath(config, 'git'), 30, async (): Promise<BacklogWorkerResult> => {
    logger.line('');

    if (options.worktrees) {
      logger.line(`  Merging to main: ${claim.task.title}`);
      const originalDiff = await diffForPaths(commandRunner, session.cwd, validation.allowedPaths);
      const mergeResult = await session.merge();
      if (!mergeResult.ok) {
        const recovered = await attemptTaskReconciliation(
          config,
          store,
          workspaceStrategy,
          commandRunner,
          logger,
          options,
          claim,
          mergeResult.reason ?? 'merge failed',
          originalDiff,
          false,
          message,
          mergeResult,
          sleep,
        );
        if (!recovered.recovered) {
          await applyClaimRepairOutcome(store, logger, claim, recovered, mergeResult.reason ?? 'merge failed');
          return taskWorkerResult(recovered.deferred ? 'deferred' : 'failed', claim, startedAt, {
            note: recovered.failureReason ?? mergeResult.reason ?? 'merge failed',
            queuedFollowups: recovered.queuedFollowups,
            validationSummary: validation.validationSummary,
          });
        }
        return taskWorkerResult('completed', claim, startedAt, {
          note: validation.agentResult.note || 'completed',
          queuedFollowups: recovered.queuedFollowups,
          validationSummary: validation.validationSummary,
        });
      }
      logger.line('  ✓ Merged code changes to main');
    } else {
      logger.line(`  Finalizing code changes: ${claim.task.title}`);
    }

    const persisted = await persistTaskLifecyclePhase({
      store,
      workspaceStrategy,
      logger,
      config,
      commitMessage: message,
      transition: {
        type: 'complete-claim',
        claim,
        note: validation.agentResult.note || 'completed',
      },
      sleep,
    });
    if (!persisted.ok) {
      const failReason = options.worktrees ? 'finalize failed after merge' : 'commit/push failed';
      const recovered = await attemptTaskReconciliation(
        config,
        store,
        workspaceStrategy,
        commandRunner,
        logger,
        options,
        claim,
        persisted.finalizeResult.reason ?? failReason,
        await diffForPaths(commandRunner, config.projectRoot),
        false,
        message,
        persisted.finalizeResult,
        sleep,
      );
      if (!recovered.recovered) {
        await applyClaimRepairOutcome(store, logger, claim, recovered, withFailureReason(persisted.finalizeResult, failReason));
        return taskWorkerResult(recovered.deferred ? 'deferred' : 'failed', claim, startedAt, {
          note: recovered.failureReason ?? withFailureReason(persisted.finalizeResult, failReason),
          queuedFollowups: recovered.queuedFollowups,
          validationSummary: validation.validationSummary,
        });
      }
      return taskWorkerResult('completed', claim, startedAt, {
        note: validation.agentResult.note || 'completed',
        queuedFollowups: recovered.queuedFollowups,
        validationSummary: validation.validationSummary,
      });
    }

    logger.line(`  ✓ Marked done after ${options.worktrees ? 'merge' : 'finalize'}`);
    return taskWorkerResult('completed', claim, startedAt, {
      note: validation.agentResult.note || 'completed',
      queuedFollowups: persisted.queuedFollowups,
      validationSummary: validation.validationSummary,
    });
  });
}

export async function runTaskWorker(
  config: BacklogRunnerConfig,
  store: BacklogStore,
  workspaceStrategy: WorkspaceStrategy,
  commandRunner: CommandRunner,
  logger: RunnerLogger,
  options: ResolvedRunOptions,
  claim: BacklogTaskClaim,
  sleep?: (ms: number) => Promise<void>,
): Promise<BacklogWorkerResult> {
  const startedAt = Date.now();
  logger.line(`  → ${claim.task.title} (${claim.task.id})`);
  let transcriptRecorder: Awaited<ReturnType<typeof createAgentTranscriptRecorder>> | null = null;

  const dependencyManifestTask = claim.task.touchPaths.some(touchesDependencyManifest);
  if (options.worktrees && dependencyManifestTask) {
    const reason = `dependency refresh required from main repo [${MAIN_REPO_INSTALL_REQUIRED_CODE}]: task touches dependency manifests that must be refreshed from the main repo root. Recovery: ${formatSharedInstallRecoveryInstruction(config.workspaceBootstrap.repairCommand, config.workspaceBootstrap.installCommand)}`;
    await store.deferClaim(claim, reason, PREFLIGHT_DEFERRAL_MS, { category: 'preflight' });
    logger.line(`  ⚠ ${reason} — deferred for retry`);
    return taskWorkerResult('deferred', claim, startedAt, { note: reason });
  }

  let session: WorkspaceSession;
  try {
    session = await workspaceStrategy.setup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.deferClaim(claim, `workspace setup failed: ${message}`, PREFLIGHT_DEFERRAL_MS, { category: 'preflight' });
    logger.line(`  ⚠ workspace setup failed: ${message} — deferred for retry`);
    return taskWorkerResult('deferred', claim, startedAt, { note: message });
  }

  if (options.worktrees) {
    logger.line(`  Worktree: ${session.cwd}`);
  }

  const heartbeat = setInterval(() => {
    void store.heartbeatClaim(claim).catch(() => undefined);
  }, 30_000);
  heartbeat.unref?.();

  try {
    transcriptRecorder = await createAgentTranscriptRecorder(config, claim);
    await store.recordTaskActivity(claim.task.id, {
      transcriptPath: transcriptRecorder.transcriptPath,
    });
    const phaseContext: TaskWorkerPhaseContext = {
      config,
      store,
      workspaceStrategy,
      commandRunner,
      logger,
      options,
      claim,
      startedAt,
      session,
      transcriptRecorder,
      sleep,
    };

    const preflightPhase = await runTaskPreflightPhase(phaseContext);
    if (preflightPhase.kind === 'stop') {
      return preflightPhase.result;
    }

    const executionPhase = await runTaskExecutionPhase(phaseContext, preflightPhase.value);
    if (executionPhase.kind === 'stop') {
      return executionPhase.result;
    }

    const validationPhase = await runTaskValidationPhase(phaseContext, executionPhase.value);
    if (validationPhase.kind === 'stop') {
      return validationPhase.result;
    }

    return runTaskFinalizePhase(phaseContext, validationPhase.value);
  } catch (error) {
    const classified = classifyAgentError(error);
    if (classified.kind === 'auth') {
      await store.releaseClaim(claim);
      throw new Error('Authentication/permission error — check your API key and tool setup');
    }
    if (classified.kind === 'rate_limited') {
      logger.line('');
      logger.line(`  ⚠ Rate limit hit — unclaiming task, retry at ${retryTime()}`);
      await store.releaseClaim(claim);
      return taskWorkerResult('rate_limited', claim, startedAt, { note: classified.message });
    }
    logger.line(`  ⚠ ${classified.message} — unclaiming task`);
    await store.releaseClaim(claim);
    return taskWorkerResult('released', claim, startedAt, { note: classified.message });
  } finally {
    clearInterval(heartbeat);
    await transcriptRecorder?.close();
    await session.teardown();
  }
}
