import { randomUUID } from 'node:crypto';
import { access, appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lockPath, withLock } from '../locks.js';
import { RuntimeStateStore } from '../runtime-state.js';
import { normalizeWhitespace } from '../utils.js';
import {
  createTaskFromPlannerChild,
  createTaskFromCandidateDetailed,
  normalizeRepoPath,
  normalizeTaskSpecStore,
  parseCandidateRecordDetailed,
  readTaskSpecs,
  renderGeneratedBacklog,
  taskPriorityRank,
  taskSort,
  touchPathsOverlap,
  updateTask,
  writeTaskSpec,
} from '../task-specs.js';
import type {
  BacklogCandidateRecord,
  BacklogDrainResult,
  BacklogQueueCounts,
  BacklogRunnerConfig,
  BacklogStore,
  BacklogTaskClaim,
  BacklogTaskPriority,
  BacklogTaskSpec,
  PlannerSupersedeAction,
  TaskBlockage,
  TaskDeferralOptions,
  TaskActivitySnapshot,
  TaskDependencySnapshot,
  OrchestratorRuntimeStatus,
  TaskLeaseSnapshot,
  TaskReservationSnapshot,
} from '../types.js';

type RuntimeSnapshot = {
  tasks: BacklogTaskSpec[];
  activeTaskIds: Set<string>;
  activeLeases: TaskLeaseSnapshot[];
  activeReservations: TaskReservationSnapshot[];
  activeTaskProgress: TaskActivitySnapshot[];
  blockages: TaskBlockage[];
  counts: BacklogQueueCounts;
};

type CandidateRejectLogEntry = {
  recorded_at: string;
  stage: 'parse' | 'materialize' | 'duplicate';
  reason: string;
  raw_line: string;
  candidate?: {
    title: string;
    priority: string;
    touch_paths: string[];
    acceptance_criteria: string[];
    validation_profile?: string;
    execution_domain?: string;
    capabilities?: string[];
    context?: string;
    source: string;
  };
  task_id?: string;
};

function plannerCandidateSort(a: BacklogTaskSpec, b: BacklogTaskSpec): number {
  const stateRank = (task: BacklogTaskSpec): number => (task.state === 'failed' ? 0 : 1);
  return stateRank(a) - stateRank(b) || taskSort(a, b);
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function truncateInline(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, content, 'utf8');
  await rename(tempFile, filePath);
}

async function appendCandidateRejectLog(filePath: string, entries: CandidateRejectLogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const payload = entries.map(entry => `${JSON.stringify(entry)}\n`).join('');
  await appendFile(filePath, payload, 'utf8');
}

function reservationConflict(task: BacklogTaskSpec, reservation: TaskReservationSnapshot): boolean {
  const capabilityConflict = task.capabilities.some(capability => reservation.capabilities.includes(capability));
  return capabilityConflict || touchPathsOverlap(task.touchPaths, reservation.touchPaths);
}

function renderDeferralReason(note: string, options: TaskDeferralOptions = {}): string {
  if (options.category === 'remediation') {
    return `remediation: ${note}`;
  }
  return note;
}

function renderDeferralStatusNote(note: string, retryAt: string, options: TaskDeferralOptions = {}): string {
  if (options.category === 'remediation') {
    return `Deferred after remediation: ${note} until ${retryAt}`;
  }
  return `Deferred: ${note} until ${retryAt}`;
}

function highestPriority(tasks: BacklogTaskSpec[]): BacklogTaskPriority | null {
  if (tasks.length === 0) return null;
  return tasks.reduce<BacklogTaskPriority>((current, task) => (
    taskPriorityRank(task.priority) < taskPriorityRank(current) ? task.priority : current
  ), tasks[0]!.priority);
}

async function readOrchestratorStatus(runtimeDir: string): Promise<OrchestratorRuntimeStatus | null> {
  try {
    const content = await readFile(path.join(runtimeDir, 'orchestrator-status.json'), 'utf8');
    return JSON.parse(content) as OrchestratorRuntimeStatus;
  } catch {
    return null;
  }
}

export class FileBackedTaskStore implements BacklogStore {
  private runtime: RuntimeStateStore | null = null;

  constructor(private readonly config: BacklogRunnerConfig) {}

  private get backlogLock(): string {
    return lockPath(this.config, 'backlog');
  }

  private async getRuntime(): Promise<RuntimeStateStore> {
    if (!this.runtime) {
      this.runtime = await RuntimeStateStore.create(this.config.files.stateDb);
    }
    return this.runtime;
  }

  async close(): Promise<void> {
    if (!this.runtime) return;
    this.runtime.close();
    this.runtime = null;
  }

  async ensureProgressFile(): Promise<void> {
    try {
      await access(this.config.files.progress);
    } catch {
      await writeFile(
        this.config.files.progress,
        `# Backlog Progress Log\nStarted: ${new Date().toString()}\n---\n`,
        'utf8',
      );
    }
  }

  async ensureTaskSpecsReady(): Promise<void> {
    await this.getRuntime();
    await withLock(this.backlogLock, 30, async () => {
      await normalizeTaskSpecStore(this.config.files.taskSpecsDir);
      await this.refreshEverything();
    });
  }

  private async loadTasks(): Promise<BacklogTaskSpec[]> {
    return readTaskSpecs(this.config.files.taskSpecsDir);
  }

  private taskIndex(tasks: BacklogTaskSpec[]): Map<string, BacklogTaskSpec> {
    return new Map(tasks.map(task => [task.id, task]));
  }

  private computeBlockages(
    tasks: BacklogTaskSpec[],
    activeReservations: TaskReservationSnapshot[],
    activeTaskIds: Set<string>,
    activeDeferrals: TaskBlockage[],
  ): TaskBlockage[] {
    const taskIndex = this.taskIndex(tasks);
    const blockages: TaskBlockage[] = [];

    for (const task of tasks) {
      if (task.state === 'done' || task.state === 'failed' || task.state === 'superseded' || activeTaskIds.has(task.id)) {
        continue;
      }

      let reason = '';
      if (task.state === 'planned') {
        reason = 'planner pending';
      } else if (task.touchPaths.length === 0) {
        reason = 'missing touch_paths';
      } else if (!task.validationProfile) {
        reason = 'missing validation_profile';
      } else if (!this.config.validationProfiles[task.validationProfile]) {
        reason = `unknown validation profile "${task.validationProfile}"`;
      } else {
        const unresolvedDeps = task.dependsOn
          .flatMap(depId => {
            const dep = taskIndex.get(depId);
            return !dep || dep.state !== 'done'
              ? [dep?.title ?? `missing dependency: ${depId}`]
              : [];
          });
        if (unresolvedDeps.length > 0) {
          reason = `waiting on dependency: ${unresolvedDeps.join(', ')}`;
        }
      }

      if (!reason) {
        const conflict = activeReservations.find(reservation => reservationConflict(task, reservation));
        if (conflict) {
          reason = `waiting on active reservation: ${conflict.title}`;
        }
      }

      if (reason) {
        blockages.push({ taskId: task.id, reason });
      }
    }

    const blockedIds = new Set(blockages.map(blockage => blockage.taskId));
    for (const deferral of activeDeferrals) {
      const task = taskIndex.get(deferral.taskId);
      if (!task || task.state !== 'ready' || activeTaskIds.has(task.id) || blockedIds.has(task.id)) {
        continue;
      }
      blockages.push(deferral);
      blockedIds.add(deferral.taskId);
    }

    return blockages;
  }

  private async refreshRuntime(tasks?: BacklogTaskSpec[]): Promise<RuntimeSnapshot> {
    const runtime = await this.getRuntime();
    const loadedTasks = tasks ?? await this.loadTasks();
    const taskIndex = this.taskIndex(loadedTasks);
    const activeTaskIds = runtime.listActiveTaskIds();
    const activeLeases = runtime.listActiveLeases(taskIndex);
    const activeReservations = runtime.listActiveReservations(taskIndex);
    const activeTaskProgress = runtime.listActiveTaskActivity(taskIndex);
    const activeDeferrals = runtime.listActiveDeferrals();
    const blockages = this.computeBlockages(loadedTasks, activeReservations, activeTaskIds, activeDeferrals);
    runtime.syncBlockers(blockages);

    const blockedIds = new Set(blockages.map(blockage => blockage.taskId));
    const counts: BacklogQueueCounts = {
      planned: loadedTasks.filter(task => task.state === 'planned').length,
      ready: loadedTasks.filter(task => task.state === 'ready' && !activeTaskIds.has(task.id) && !blockedIds.has(task.id)).length,
      blocked: loadedTasks.filter(task => task.state === 'ready' && !activeTaskIds.has(task.id) && blockedIds.has(task.id)).length,
      inProgress: activeTaskIds.size,
      failed: loadedTasks.filter(task => task.state === 'failed').length,
      done: loadedTasks.filter(task => task.state === 'done').length,
    };

    return {
      tasks: loadedTasks,
      activeTaskIds,
      activeLeases,
      activeReservations,
      activeTaskProgress,
      blockages,
      counts,
    };
  }

  private async writeBacklogReport(tasks: BacklogTaskSpec[]): Promise<void> {
    const report = renderGeneratedBacklog(tasks);
    await atomicWrite(this.config.files.backlog, report);
  }

  private async writeRuntimeReport(snapshot: RuntimeSnapshot): Promise<void> {
    const orchestratorStatus = await readOrchestratorStatus(this.config.files.runtimeDir);
    const plannerCandidates = snapshot.tasks
      .filter(task => task.state === 'planned' || task.state === 'failed')
      .sort(plannerCandidateSort);
    const otherBlockages = snapshot.blockages.filter(blockage => blockage.reason !== 'planner pending');
    const lines = [
      '# Backlog Runner Runtime Status',
      '',
      `Generated: ${new Date().toISOString()}`,
      ...(orchestratorStatus
        ? [
            '',
            `Orchestrator: ${orchestratorStatus.orchestratorId}`,
            `Workers: ${orchestratorStatus.effectiveWorkers}/${orchestratorStatus.requestedWorkers}`,
            `Shutdown requested: ${orchestratorStatus.shutdownRequested ? 'yes' : 'no'}`,
            `Poll interval: ${Math.floor(orchestratorStatus.pollIntervalMs / 1000)}s`,
            `Active task workers: ${orchestratorStatus.activeTaskWorkers.length === 0 ? 'none' : orchestratorStatus.activeTaskWorkers.map(worker => `${worker.title} (${worker.taskId})`).join(' · ')}`,
            `Active control worker: ${orchestratorStatus.activeControlWorker ? orchestratorStatus.activeControlWorker.kind === 'discovery' ? `discovery${orchestratorStatus.activeControlWorker.passType ? `:${orchestratorStatus.activeControlWorker.passType}` : ''}` : 'planner' : 'none'}`,
          ]
        : []),
      '',
      `Queue: ${snapshot.counts.ready} ready · ${snapshot.counts.blocked} blocked · ${snapshot.counts.planned} planned · ${snapshot.counts.inProgress} in-progress · ${snapshot.counts.failed} failed · ${snapshot.counts.done} done`,
      '',
      '## Active Leases',
      ...(snapshot.activeLeases.length === 0
        ? ['- None']
        : snapshot.activeLeases.map(lease => `- ${lease.title} (${lease.taskId}) — runner ${lease.runnerId}; claimed ${lease.claimedAt}; heartbeat ${lease.heartbeatAt}; lease expires ${lease.expiresAt}`)),
      '',
      '## Active Reservations',
      ...(snapshot.activeReservations.length === 0
        ? ['- None']
        : snapshot.activeReservations.map(reservation => {
            const touchPaths = reservation.touchPaths.length > 0 ? reservation.touchPaths.join(', ') : '(none)';
            const capabilities = reservation.capabilities.length > 0 ? reservation.capabilities.join(', ') : '(none)';
            return `- ${reservation.title} (${reservation.taskId}) — touch_paths: ${touchPaths}; capabilities: ${capabilities}`;
          })),
      '',
      '## Active Task Progress',
      ...(snapshot.activeTaskProgress.length === 0
        ? ['- None']
        : snapshot.activeTaskProgress.flatMap(activity => [
            `- ${activity.title} (${activity.taskId}) — transcript: ${activity.transcriptPath}`,
            ...(activity.milestones.length === 0
              ? ['  - No milestones yet']
              : activity.milestones.map(milestone => `  - ${truncateInline(milestone)}`)),
          ])),
      '',
      '## Planner Candidates Awaiting Refinement',
      ...(plannerCandidates.length === 0
        ? ['- None']
        : plannerCandidates.map(task => `- ${task.id}: ${task.state}`)),
      '',
      '## Other Blockages',
      ...(otherBlockages.length === 0
        ? ['- None']
        : otherBlockages.map(blockage => {
            const retrySuffix = blockage.retryAt ? ` (retry after ${blockage.retryAt})` : '';
            return `- ${blockage.taskId}: ${blockage.reason}${retrySuffix}`;
          })),
      '',
    ];
    await atomicWrite(this.config.files.runtimeReport, lines.join('\n'));
  }

  private async refreshRuntimeAndWriteLiveReport(tasks?: BacklogTaskSpec[]): Promise<RuntimeSnapshot> {
    const snapshot = await this.refreshRuntime(tasks);
    await this.writeRuntimeReport(snapshot);
    return snapshot;
  }

  private async refreshEverything(tasks?: BacklogTaskSpec[]): Promise<RuntimeSnapshot> {
    const snapshot = await this.refreshRuntimeAndWriteLiveReport(tasks);
    await this.writeBacklogReport(snapshot.tasks);
    return snapshot;
  }

  async getQueueCounts(): Promise<BacklogQueueCounts> {
    return withLock(this.backlogLock, 30, async () => (await this.refreshRuntimeAndWriteLiveReport()).counts);
  }

  async getQueueState(): Promise<{ counts: BacklogQueueCounts; blockages: TaskBlockage[]; reapResult: { deadRunnerLeases: number } }> {
    return withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      const reapResult = runtime.reapStaleRuntimeState();
      const snapshot = await this.refreshRuntimeAndWriteLiveReport();
      return {
        counts: snapshot.counts,
        blockages: snapshot.blockages,
        reapResult: { deadRunnerLeases: reapResult.deadRunnerLeases },
      };
    });
  }

  async reapStaleRuntimeState(): Promise<{ deadRunnerLeases: number }> {
    return withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      const result = runtime.reapStaleRuntimeState();
      return {
        deadRunnerLeases: result.deadRunnerLeases,
      };
    });
  }

  async claimNextRunnableTasks(limit: number, runnerId: string): Promise<BacklogTaskClaim[]> {
    return withLock(this.backlogLock, 30, async () => {
      if (limit <= 0) {
        return [];
      }
      const runtime = await this.getRuntime();
      const tasks = await this.loadTasks();
      const snapshot = await this.refreshRuntimeAndWriteLiveReport(tasks);
      const blockages = new Set(snapshot.blockages.map(blockage => blockage.taskId));
      const candidates = tasks
        .filter(task => task.state === 'ready' && !snapshot.activeTaskIds.has(task.id) && !blockages.has(task.id))
        .sort(taskSort);
      if (candidates.length === 0) {
        return [];
      }

      const claimed: BacklogTaskClaim[] = [];
      const claimedReservations: TaskReservationSnapshot[] = [];
      for (const candidate of candidates) {
        if (claimed.length >= limit) {
          break;
        }
        if (claimedReservations.some(reservation => reservationConflict(candidate, reservation))) {
          continue;
        }
        const lease = runtime.claimTask(candidate, runnerId, randomUUID());
        if (!lease) {
          continue;
        }
        claimed.push({ task: candidate, lease });
        claimedReservations.push({
          taskId: candidate.id,
          title: candidate.title,
          touchPaths: candidate.touchPaths,
          capabilities: candidate.capabilities,
          runnerId,
          expiresAt: lease.expiresAt,
        });
      }
      await this.refreshRuntimeAndWriteLiveReport(tasks);
      return claimed;
    });
  }

  async heartbeatClaim(claim: BacklogTaskClaim): Promise<void> {
    const runtime = await this.getRuntime();
    runtime.heartbeatClaim(claim);
  }

  async releaseClaim(claim: BacklogTaskClaim): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      runtime.releaseClaim(claim);
      await this.refreshRuntimeAndWriteLiveReport();
    });
  }

  async appendTaskNote(taskId: string, note: string): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const normalizedNote = normalizeWhitespace(note);
      await this.updateTask(taskId, task => updateTask(task, {
        statusNotes: [...task.statusNotes, normalizedNote],
      }));
      await this.refreshEverything();
    });
  }

  async deferClaim(
    claim: BacklogTaskClaim,
    note: string,
    retryAfterMs: number,
    options: TaskDeferralOptions = {},
  ): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      const normalizedNote = normalizeWhitespace(note);
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      await this.updateTask(claim.task.id, task => updateTask(task, {
        statusNotes: [...task.statusNotes, renderDeferralStatusNote(normalizedNote, retryAt, options)],
      }));
      runtime.deferTask(claim.task.id, renderDeferralReason(normalizedNote, options), retryAt);
      runtime.releaseClaim(claim);
      await this.refreshEverything();
    });
  }

  async deferTaskById(
    taskId: string,
    note: string,
    retryAfterMs: number,
    options: TaskDeferralOptions = {},
  ): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      const normalizedNote = normalizeWhitespace(note);
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      await this.updateTask(taskId, task => updateTask(task, {
        state: 'ready',
        statusNotes: [...task.statusNotes, renderDeferralStatusNote(normalizedNote, retryAt, options)],
      }));
      runtime.deferTask(taskId, renderDeferralReason(normalizedNote, options), retryAt);
      await this.refreshEverything();
    });
  }

  private async persistTask(task: BacklogTaskSpec): Promise<void> {
    await writeTaskSpec(this.config.files.taskSpecsDir, task);
  }

  private async updateTask(taskId: string, updater: (task: BacklogTaskSpec) => BacklogTaskSpec): Promise<BacklogTaskSpec | null> {
    const tasks = await this.loadTasks();
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) return null;
    const next = updater(task);
    await this.persistTask(next);
    return next;
  }

  async completeClaim(claim: BacklogTaskClaim, note: string): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      await this.updateTask(claim.task.id, task => updateTask(task, {
        state: 'done',
        statusNotes: [...task.statusNotes, `Completed: ${normalizeWhitespace(note)}`],
      }));
      runtime.clearTaskDeferral(claim.task.id);
      runtime.releaseClaim(claim);
      await this.refreshEverything();
    });
  }

  async failClaim(claim: BacklogTaskClaim, note: string): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      await this.updateTask(claim.task.id, task => updateTask(task, {
        state: 'failed',
        statusNotes: [...task.statusNotes, `Failed: ${normalizeWhitespace(note)}`],
      }));
      runtime.clearTaskDeferral(claim.task.id);
      runtime.releaseClaim(claim);
      await this.refreshEverything();
    });
  }

  async failTaskById(taskId: string, note: string): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      const runtime = await this.getRuntime();
      await this.updateTask(taskId, task => updateTask(task, {
        state: 'failed',
        statusNotes: [...task.statusNotes, `Failed: ${normalizeWhitespace(note)}`],
      }));
      runtime.clearTaskDeferral(taskId);
      await this.refreshEverything();
    });
  }

  async enqueueCandidate(candidate: BacklogCandidateRecord): Promise<void> {
    await withLock(this.backlogLock, 30, async () => {
      await appendFile(this.config.files.candidateQueue, `${JSON.stringify({
        title: candidate.title,
        priority: candidate.priority,
        touch_paths: candidate.touchPaths,
        acceptance_criteria: candidate.acceptanceCriteria,
        validation_profile: candidate.validationProfile,
        capabilities: candidate.capabilities,
        context: candidate.context,
        source: candidate.source,
      })}\n`, 'utf8');
    });
  }

  private taskExists(tasks: BacklogTaskSpec[], candidate: BacklogTaskSpec): boolean {
    return tasks.some(task => task.id === candidate.id);
  }

  async drainCandidateQueue(): Promise<BacklogDrainResult> {
    return withLock(this.backlogLock, 30, async () => {
      let queueContent = '';
      try {
        queueContent = await readFile(this.config.files.candidateQueue, 'utf8');
      } catch {
        return { drained: false, createdTasks: 0, skippedDuplicates: 0, ignoredInvalidLines: 0, loggedRejects: 0 };
      }

      if (!/\S/.test(queueContent)) {
        return { drained: false, createdTasks: 0, skippedDuplicates: 0, ignoredInvalidLines: 0, loggedRejects: 0 };
      }

      const tasks = await this.loadTasks();
      let createdTasks = 0;
      let skippedDuplicates = 0;
      let ignoredInvalidLines = 0;
      const rejectedEntries: CandidateRejectLogEntry[] = [];
      const recordedAt = new Date().toISOString();

      for (const line of splitLines(queueContent).map(value => value.trim()).filter(Boolean)) {
        const parsed = parseCandidateRecordDetailed(line);
        if (!parsed.ok) {
          ignoredInvalidLines += 1;
          rejectedEntries.push({
            recorded_at: recordedAt,
            stage: 'parse',
            reason: parsed.reason,
            raw_line: line,
          });
          continue;
        }
        const candidate = parsed.candidate;
        const materialized = createTaskFromCandidateDetailed(candidate, this.config.validationProfiles, this.config);
        if (!materialized.ok) {
          ignoredInvalidLines += 1;
          rejectedEntries.push({
            recorded_at: recordedAt,
            stage: 'materialize',
            reason: materialized.reason,
            raw_line: line,
            candidate: {
              title: candidate.title,
              priority: candidate.priority,
              touch_paths: candidate.touchPaths,
              acceptance_criteria: candidate.acceptanceCriteria,
              validation_profile: candidate.validationProfile,
              execution_domain: candidate.executionDomain,
              capabilities: candidate.capabilities,
              context: candidate.context,
              source: candidate.source,
            },
          });
          continue;
        }
        const task = materialized.task;
        if (this.taskExists(tasks, task)) {
          skippedDuplicates += 1;
          rejectedEntries.push({
            recorded_at: recordedAt,
            stage: 'duplicate',
            reason: `task "${task.id}" already exists`,
            raw_line: line,
            candidate: {
              title: candidate.title,
              priority: candidate.priority,
              touch_paths: candidate.touchPaths,
              acceptance_criteria: candidate.acceptanceCriteria,
              validation_profile: candidate.validationProfile,
              execution_domain: candidate.executionDomain,
              capabilities: candidate.capabilities,
              context: candidate.context,
              source: candidate.source,
            },
            task_id: task.id,
          });
          continue;
        }
        tasks.push(task);
        await this.persistTask(task);
        createdTasks += 1;
      }

      await appendCandidateRejectLog(this.config.files.candidateRejectLog, rejectedEntries);
      await atomicWrite(this.config.files.candidateQueue, '');
      await this.refreshEverything(tasks.sort(taskSort));
      return {
        drained: true,
        createdTasks,
        skippedDuplicates,
        ignoredInvalidLines,
        loggedRejects: rejectedEntries.length,
      };
    });
  }

  async listPlannerCandidates(limit = Number.POSITIVE_INFINITY): Promise<BacklogTaskSpec[]> {
    const tasks = await this.loadTasks();
    return tasks
      .filter(task => task.state === 'failed' || task.state === 'planned')
      .sort(plannerCandidateSort)
      .slice(0, limit);
  }

  async applyPlannerSupersede(
    action: PlannerSupersedeAction,
    options: { allowedParentTaskIds?: string[] } = {},
  ): Promise<{ parentTaskIds: string[]; childTaskIds: string[] }> {
    return withLock(this.backlogLock, 30, async () => {
      if (new Set(action.parentTaskIds).size !== action.parentTaskIds.length) {
        throw new Error('Planner action referenced duplicate parent task ids');
      }
      const allowedParentTaskIds = options.allowedParentTaskIds ? new Set(options.allowedParentTaskIds) : null;
      if (allowedParentTaskIds && action.parentTaskIds.some(taskId => !allowedParentTaskIds.has(taskId))) {
        throw new Error('Planner action referenced parent task outside the selected planning batch');
      }

      const tasks = await this.loadTasks();
      const taskIndex = this.taskIndex(tasks);
      const parents = action.parentTaskIds
        .map(taskId => taskIndex.get(taskId))
        .filter((task): task is BacklogTaskSpec => Boolean(task));
      if (parents.length !== action.parentTaskIds.length) {
        throw new Error('Planner action referenced unknown parent task');
      }
      if (parents.some(task => task.state !== 'planned' && task.state !== 'failed')) {
        throw new Error('Planner action referenced non-recoverable parent task');
      }

      const nowIso = new Date().toISOString();
      const childTasks = action.children.map(child => createTaskFromPlannerChild(child, this.config.validationProfiles, this.config, nowIso));
      if (childTasks.some(task => task === null)) {
        throw new Error('Planner action produced invalid child task');
      }

      const failedParents = parents.filter(task => task.state === 'failed');
      const failedPriorityFloor = highestPriority(failedParents);
      const materializedChildren = (childTasks as BacklogTaskSpec[]).map(task => {
        if (!failedPriorityFloor || taskPriorityRank(task.priority) <= taskPriorityRank(failedPriorityFloor)) {
          return task;
        }
        return updateTask(task, {
          priority: failedPriorityFloor,
          statusNotes: [
            ...task.statusNotes,
            `Priority elevated to ${failedPriorityFloor} to preserve failed-parent urgency.`,
          ],
        }, nowIso);
      });
      const childIds = materializedChildren.map(task => task.id);
      const duplicateChildIds = childIds.filter((taskId, index) => childIds.indexOf(taskId) !== index);
      if (duplicateChildIds.length > 0) {
        throw new Error(`Planner action produced duplicate child task ids: ${[...new Set(duplicateChildIds)].join(', ')}`);
      }
      const existingIds = childIds.filter(taskId => taskIndex.has(taskId));
      if (existingIds.length > 0) {
        throw new Error(`Planner action produced duplicate child task ids: ${existingIds.join(', ')}`);
      }

      for (const child of materializedChildren) {
        await this.persistTask(child);
      }

      for (const parent of parents) {
        await this.persistTask(updateTask(parent, {
          state: 'superseded',
          statusNotes: [...parent.statusNotes, `Superseded by planner-pass: ${childIds.join(', ')}`],
        }, nowIso));
      }

      await this.refreshEverything();
      return { parentTaskIds: action.parentTaskIds, childTaskIds: childIds };
    });
  }

  async getTaskDependencies(taskId: string): Promise<TaskDependencySnapshot[]> {
    const tasks = await this.loadTasks();
    const taskIndex = this.taskIndex(tasks);
    const task = taskIndex.get(taskId);
    if (!task) return [];
    return task.dependsOn
      .map(depId => taskIndex.get(depId))
      .filter((dep): dep is BacklogTaskSpec => Boolean(dep))
      .map(dep => ({ taskId: dep.id, title: dep.title, state: dep.state }));
  }

  async getActiveReservations(excludeTaskId?: string): Promise<TaskReservationSnapshot[]> {
    const runtime = await this.getRuntime();
    const tasks = await this.loadTasks();
    return runtime.listActiveReservations(this.taskIndex(tasks), excludeTaskId);
  }

  async recordTaskActivity(taskId: string, activity: { transcriptPath: string; milestone?: string }): Promise<void> {
    const runtime = await this.getRuntime();
    runtime.recordTaskActivity(taskId, activity.transcriptPath, activity.milestone);
    await withLock(this.backlogLock, 30, async () => {
      await this.refreshRuntimeAndWriteLiveReport();
    });
  }

  async getTaskBlockage(taskId: string): Promise<TaskBlockage | null> {
    const runtime = await this.getRuntime();
    return runtime.getBlockage(taskId);
  }

  async getTaskSpec(taskId: string): Promise<BacklogTaskSpec | null> {
    const tasks = await this.loadTasks();
    return tasks.find(task => task.id === taskId) ?? null;
  }

}

export function createFileBackedTaskStore(config: BacklogRunnerConfig): BacklogStore {
  return new FileBackedTaskStore(config);
}
