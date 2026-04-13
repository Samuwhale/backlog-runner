export type BacklogTool = 'claude' | 'codex';
export type BacklogPassKind = 'discovery';
export const BACKLOG_IMPLEMENTATION_RUNNER_ROLES = ['taskUi', 'taskCode'] as const;
export type BacklogImplementationRunnerRole = typeof BACKLOG_IMPLEMENTATION_RUNNER_ROLES[number];
export const BACKLOG_RUNNER_ROLES = [...BACKLOG_IMPLEMENTATION_RUNNER_ROLES, 'planner'] as const;
export type BacklogRunnerRole = typeof BACKLOG_RUNNER_ROLES[number];
export const BACKLOG_PUBLIC_AGENT_ROLES = ['planner', 'ui', 'code'] as const;
export type BacklogPublicAgentRole = typeof BACKLOG_PUBLIC_AGENT_ROLES[number];
export type BacklogConfigPreset = 'safe' | 'balanced' | 'aggressive';
export type BacklogTaskPriority = 'high' | 'normal' | 'low';
export type BacklogTaskState = 'planned' | 'ready' | 'done' | 'failed' | 'superseded';
export type BacklogTaskKind = 'implementation' | 'research';
export type BacklogExecutionDomain = 'ui_ux' | 'code_logic';
export type ValidationProfileRule = {
  profile: string;
  pathPrefixes: string[];
};
export type BacklogWorkerResultKind =
  | 'completed'
  | 'failed'
  | 'deferred'
  | 'released'
  | 'rate_limited'
  | 'no_progress';

export interface BacklogPassRunnerConfig {
  tool: BacklogTool;
  model?: string;
}

export interface BacklogPassHeuristicsInput {
  includePaths?: string[];
  excludePaths?: string[];
  capabilities?: string[];
}

export interface BacklogPassHeuristics {
  includePaths: string[];
  excludePaths: string[];
  capabilities: string[];
}

export interface BacklogPassConfigInput {
  kind: BacklogPassKind;
  enabled?: boolean;
  description?: string;
  promptFile?: string;
  runner?: BacklogPassRunnerConfig;
  heuristics?: BacklogPassHeuristicsInput;
}

export interface BacklogPassConfig {
  id: string;
  kind: BacklogPassKind;
  enabled: boolean;
  description?: string;
  promptFile: string;
  runner?: BacklogPassRunnerConfig;
  heuristics: BacklogPassHeuristics;
}

export type BacklogValidationConfigInput =
  | string
  | {
      default: string;
      profiles?: Record<string, string>;
      routing?: ValidationProfileRule[];
    };

export type BacklogProviderSelectionInput =
  | BacklogTool
  | 'auto'
  | {
      tool?: BacklogTool | 'auto';
      model?: string;
    };

export interface BacklogDiscoveryPassInput {
  enabled?: boolean;
  description?: string;
  promptFile?: string;
  runner?: BacklogPassRunnerConfig;
  heuristics?: BacklogPassHeuristicsInput;
}

export interface BacklogRunnerConfigInput {
  preset?: BacklogConfigPreset;
  projectRoot?: string;
  paths?: {
    backlog?: string;
    backlogDir?: string;
    candidateQueue?: string;
    candidateRejectLog?: string;
    taskSpecsDir?: string;
    stopFile?: string;
    runtimeReport?: string;
    scriptsDir?: string;
    patterns?: string;
    progress?: string;
    stateDb?: string;
    models?: string;
    runnerLogDir?: string;
    runtimeDir?: string;
    locksDir?: string;
  };
  prompts?: {
    agent?: string;
    planner?: string;
  };
  validation?: BacklogValidationConfigInput;
  classification?: {
    backlogRuntimePaths?: string[];
    uiPathPrefixes?: string[];
  };
  providers?:
    | BacklogTool
    | 'auto'
    | {
        default?: BacklogTool | 'auto';
        agents?: Partial<Record<BacklogPublicAgentRole, BacklogProviderSelectionInput>>;
      };
  workspaceBootstrap?: {
    installCommand?: string;
    repairCommand?: string;
  };
  workspace?: {
    workers?: number;
    useWorktrees?: boolean;
  };
  discovery?: {
    enabled?: boolean;
    promptDir?: string;
    defaults?: {
      runner?: BacklogPassRunnerConfig;
      heuristics?: BacklogPassHeuristicsInput;
    };
    passes?: Record<string, BacklogDiscoveryPassInput>;
  };
}

export interface BacklogRunnerConfig {
  projectRoot: string;
  files: {
    backlog: string;
    candidateQueue: string;
    candidateRejectLog: string;
    taskSpecsDir: string;
    stop: string;
    runtimeReport: string;
    patterns: string;
    progress: string;
    stateDb: string;
    models?: string;
    runnerLogDir: string;
    runtimeDir: string;
    locksDir: string;
  };
  prompts: {
    agent: string;
    planner: string;
  };
  validationCommand: string;
  validationProfiles: Record<string, string>;
  heuristics: {
    backlogRuntimePaths: string[];
    uiPathPrefixes: string[];
    validationProfileRules: ValidationProfileRule[];
  };
  workspaceBootstrap: {
    installCommand: string;
    repairCommand: string;
  };
  runners: Record<BacklogRunnerRole, {
    tool: BacklogTool;
    model?: string;
  }>;
  defaults: {
    workers: number;
    passes: boolean;
    worktrees: boolean;
  };
  discovery: {
    promptDir: string;
    defaults: {
      runner?: BacklogPassRunnerConfig;
      heuristics: BacklogPassHeuristics;
    };
  };
  passes: Record<string, BacklogPassConfig>;
}

export interface RunOverrides {
  /** Global override — when set, every runner uses this tool instead of its configured one. */
  tool?: BacklogTool;
  /** Global override — when set, every runner uses this model instead of its configured one. */
  model?: string;
  /** Per-role overrides used by guided setup for mixed runner configurations. */
  runners?: Partial<Record<BacklogRunnerRole, {
    tool?: BacklogTool;
    model?: string;
  }>>;
  workers?: number;
  passes?: boolean;
  worktrees?: boolean;
  /** When true, stop a detected live orchestrator and take over the repo run. */
  takeover?: boolean;
  interactive?: boolean;
}

export interface ResolvedRunOptions {
  runners: Record<BacklogRunnerRole, {
    tool: BacklogTool;
    model?: string;
  }>;
  workers: number;
  passes: boolean;
  worktrees: boolean;
}

export interface AgentResult {
  status: 'done' | 'failed';
  item: string;
  note: string;
  turns?: number;
  durationSeconds?: number;
  costUsd?: number;
  rawOutput: string;
  rawError: string;
}

export interface AgentContextPayload {
  prefix: string;
  tail: string;
}

export type AgentProgressEvent =
  | {
      type: 'raw-line';
      stream: 'stdout' | 'stderr';
      line: string;
    }
  | {
      type: 'assistant-message';
      message: string;
      rawLine: string;
    };

export interface AgentRunRequest {
  tool: BacklogTool;
  model?: string;
  context: string;
  contextPrefix?: string;
  contextTail?: string;
  prompt: string;
  cwd: string;
  maxTurns?: number;
  schema: string;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
}

export interface ToolValidationResult {
  ok: boolean;
  messages: string[];
}

export interface ValidationCommandResult {
  ok: boolean;
  code: number;
  summary: string;
  stdout: string;
  stderr: string;
  durationSeconds: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  ignoreFailure?: boolean;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandResult>;
  runShell(command: string, options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    ignoreFailure?: boolean;
  }): Promise<CommandResult>;
  which(command: string): Promise<string | null>;
}

export interface LogSink {
  write(line: string): void;
  close(): Promise<void>;
}

export interface BacklogTaskSpec {
  id: string;
  title: string;
  priority: BacklogTaskPriority;
  taskKind: BacklogTaskKind;
  executionDomain?: BacklogExecutionDomain;
  dependsOn: string[];
  touchPaths: string[];
  capabilities: string[];
  validationProfile: string;
  statusNotes: string[];
  state: BacklogTaskState;
  acceptanceCriteria: string[];
  source: BacklogTaskSource;
  createdAt: string;
  updatedAt: string;
}

export type BacklogPassTaskSource = {
  type: 'pass';
  passId: string;
};

export type BacklogTaskSource =
  | BacklogPassTaskSource
  | { type: 'task-followup' }
  | { type: 'planner-pass' }
  | { type: 'manual' };

export type BacklogCandidateSource =
  | BacklogPassTaskSource
  | { type: 'task-followup' }
  | { type: 'manual' };

export interface BacklogCandidateRecord {
  title: string;
  taskKind: BacklogTaskKind;
  priority: BacklogTaskPriority;
  touchPaths: string[];
  acceptanceCriteria: string[];
  executionDomain?: BacklogExecutionDomain;
  validationProfile?: string;
  capabilities?: string[];
  context?: string;
  source: BacklogCandidateSource;
}

export interface PlannerTaskChild {
  title: string;
  taskKind: BacklogTaskKind;
  priority: BacklogTaskPriority;
  touchPaths: string[];
  acceptanceCriteria: string[];
  executionDomain?: BacklogExecutionDomain;
  validationProfile?: string;
  capabilities?: string[];
  context?: string;
}

export interface PlannerSupersedeAction {
  action: 'supersede';
  parentTaskIds: string[];
  children: PlannerTaskChild[];
}

export interface BacklogQueueCounts {
  planned: number;
  ready: number;
  blocked: number;
  inProgress: number;
  failed: number;
  done: number;
}

export interface BacklogDrainResult {
  drained: boolean;
  createdTasks: number;
  skippedDuplicates: number;
  ignoredInvalidLines: number;
  loggedRejects: number;
}

export interface BacklogSyncResult {
  candidates: BacklogDrainResult;
  counts: BacklogQueueCounts;
}

export interface BacklogTaskLease {
  taskId: string;
  runnerId: string;
  claimToken: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface BacklogTaskClaim {
  task: BacklogTaskSpec;
  lease: BacklogTaskLease;
}

export interface TaskLeaseSnapshot {
  taskId: string;
  title: string;
  runnerId: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface TaskReservationSnapshot {
  taskId: string;
  title: string;
  touchPaths: string[];
  capabilities: string[];
  runnerId: string;
  expiresAt: string;
}

export interface TaskDependencySnapshot {
  taskId: string;
  title: string;
  state: BacklogTaskState;
}

export interface TaskBlockage {
  taskId: string;
  reason: string;
  retryAt?: string;
}

export interface TaskActivitySnapshot {
  taskId: string;
  title: string;
  transcriptPath: string;
  milestones: string[];
}

export interface TaskDeferralOptions {
  category?: 'generic' | 'preflight' | 'remediation';
}

export interface BacklogStore {
  ensureProgressFile(): Promise<void>;
  ensureTaskSpecsReady(): Promise<void>;
  close(): Promise<void>;
  getQueueCounts(): Promise<BacklogQueueCounts>;
  getQueueState(): Promise<{ counts: BacklogQueueCounts; blockages: TaskBlockage[]; reapResult: { deadRunnerLeases: number } }>;
  reapStaleRuntimeState(): Promise<{ deadRunnerLeases: number }>;
  claimNextRunnableTasks(limit: number, runnerId: string): Promise<BacklogTaskClaim[]>;
  heartbeatClaim(claim: BacklogTaskClaim): Promise<void>;
  releaseClaim(claim: BacklogTaskClaim): Promise<void>;
  deferClaim(claim: BacklogTaskClaim, note: string, retryAfterMs: number, options?: TaskDeferralOptions): Promise<void>;
  deferTaskById(taskId: string, note: string, retryAfterMs: number, options?: TaskDeferralOptions): Promise<void>;
  appendTaskNote(taskId: string, note: string): Promise<void>;
  completeClaim(claim: BacklogTaskClaim, note: string): Promise<void>;
  failClaim(claim: BacklogTaskClaim, note: string): Promise<void>;
  failTaskById(taskId: string, note: string): Promise<void>;
  enqueueCandidate(candidate: BacklogCandidateRecord): Promise<void>;
  drainCandidateQueue(): Promise<BacklogDrainResult>;
  listPlannerCandidates(limit?: number): Promise<BacklogTaskSpec[]>;
  applyPlannerSupersede(
    action: PlannerSupersedeAction,
    options?: { allowedParentTaskIds?: string[] },
  ): Promise<{ parentTaskIds: string[]; childTaskIds: string[] }>;
  getTaskDependencies(taskId: string): Promise<TaskDependencySnapshot[]>;
  getActiveReservations(excludeTaskId?: string): Promise<TaskReservationSnapshot[]>;
  recordTaskActivity(taskId: string, activity: { transcriptPath: string; milestone?: string }): Promise<void>;
  getTaskBlockage(taskId: string): Promise<TaskBlockage | null>;
  getTaskSpec(taskId: string): Promise<BacklogTaskSpec | null>;
}

export interface WorkspaceSession {
  cwd: string;
  teardown(): Promise<void>;
  merge(): Promise<WorkspaceApplyResult>;
}

export interface WorkspaceStrategy {
  setup(): Promise<WorkspaceSession>;
  commitAndPush(message: string, allowedPaths: string[], options?: WorkspaceCommitOptions): Promise<WorkspaceApplyResult>;
}

export interface WorkspaceCommitOptions {
  retryPendingPush?: boolean;
  sleep?: (ms: number) => Promise<void>;
  scopeMode?: 'only' | 'all-except';
}

export interface WorkspaceApplyResult {
  ok: boolean;
  reason?: string;
  createdCommit?: boolean;
  pushed?: boolean;
  pendingPush?: boolean;
}

export interface WorkspaceRepairResult {
  recovered: boolean;
  deferred: boolean;
  failureReason?: string;
  queuedFollowups: number;
}

export interface BacklogWorkerResult {
  kind: BacklogWorkerResultKind;
  taskId?: string;
  note?: string;
  durationSeconds: number;
  queuedFollowups: number;
  validationSummary?: string;
  retryAt?: string;
}

export interface OrchestratorRuntimeStatus {
  orchestratorId: string;
  pid: number;
  requestedWorkers: number;
  effectiveWorkers: number;
  activeTaskWorkers: Array<{ taskId: string; title: string }>;
  activeControlWorker?: { kind: 'planner' | 'discovery'; passId?: string };
  shutdownRequested: boolean;
  pollIntervalMs: number;
  updatedAt: string;
}

export interface RunnerDependencies {
  commandRunner?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  createLogSink?: (config: BacklogRunnerConfig) => Promise<LogSink>;
}
