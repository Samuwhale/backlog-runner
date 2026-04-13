import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type {
  BacklogCandidateRecord,
  BacklogExecutionDomain,
  BacklogRunnerConfig,
  BacklogTaskKind,
  BacklogTaskPriority,
  BacklogTaskSpec,
  BacklogTaskState,
  PlannerTaskChild,
} from './types.js';
import { normalizeWhitespace } from './utils.js';
import { touchesDependencyManifest } from './workspace/shared-install.js';

const TASK_FILE_PATTERN = /\.ya?ml$/i;

type TaskSpecFileRecord = {
  filePath: string;
  relativePath: string;
  task: BacklogTaskSpec;
};

export function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function toArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => normalizeWhitespace(String(item))).filter(Boolean)
    : [];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

export function createTaskId(title: string): string {
  const normalized = normalizeWhitespace(title);
  return `${slugify(normalized)}-${shortHash(normalized)}`;
}

export function taskPriorityRank(priority: BacklogTaskPriority): number {
  if (priority === 'high') return 0;
  if (priority === 'normal') return 1;
  return 2;
}

export function taskSort(a: BacklogTaskSpec, b: BacklogTaskSpec): number {
  return (
    taskPriorityRank(a.priority) - taskPriorityRank(b.priority) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.title.localeCompare(b.title)
  );
}

function normalizePriority(value: unknown): BacklogTaskPriority | null {
  const normalized = normalizeWhitespace(String(value ?? 'normal')).toLowerCase();
  if (normalized === 'high' || normalized === 'normal' || normalized === 'low') {
    return normalized;
  }
  return null;
}

function isWorkspaceConfigPath(touchPath: string): boolean {
  const baseName = path.posix.basename(touchPath);
  return touchesDependencyManifest(touchPath)
    || touchPath.startsWith('.github/')
    || /^tsconfig(?:\..+)?\.json$/i.test(baseName);
}

function isBacklogRuntimePath(touchPath: string): boolean {
  return touchPath === 'backlog.config.mjs'
    || touchPath === 'backlog.md'
    || touchPath === 'backlog/inbox.jsonl'
    || touchPath === 'backlog-stop'
    || touchPath.startsWith('backlog/')
    || touchPath.startsWith('.backlog-runner/')
    || touchPath.startsWith('scripts/backlog/');
}

function inferCapabilities(touchPaths: string[], config?: Pick<BacklogRunnerConfig, 'heuristics'>): string[] {
  const capabilities = new Set<string>();
  const backlogRuntimePaths = config?.heuristics.backlogRuntimePaths ?? [];
  for (const touchPath of touchPaths) {
    if (isWorkspaceConfigPath(touchPath)) {
      capabilities.add('workspace-config');
    }
    if (
      isBacklogRuntimePath(touchPath)
      || backlogRuntimePaths.some(prefix => touchPath === prefix || touchPath.startsWith(prefix))
    ) {
      capabilities.add('backlog-runtime');
    }
  }
  return [...capabilities];
}

function normalizeExecutionDomain(value: unknown): BacklogExecutionDomain | undefined {
  const normalized = normalizeWhitespace(String(value ?? '')).toLowerCase();
  if (normalized === 'ui_ux' || normalized === 'code_logic') {
    return normalized;
  }
  return undefined;
}

function isUiTouchPath(touchPath: string, config?: Pick<BacklogRunnerConfig, 'heuristics'>): boolean {
  const prefixes = config?.heuristics.uiPathPrefixes ?? [];
  return prefixes.some(prefix => touchPath === prefix || touchPath.startsWith(prefix));
}

export function inferExecutionDomain(
  taskKind: BacklogTaskKind,
  source: BacklogTaskSpec['source'],
  touchPaths: string[],
  explicitDomain?: BacklogExecutionDomain,
  config?: Pick<BacklogRunnerConfig, 'heuristics'>,
): BacklogExecutionDomain | undefined {
  if (taskKind === 'research') {
    return undefined;
  }
  if (explicitDomain) {
    return explicitDomain;
  }
  if (source === 'product-pass' || source === 'interface-pass' || source === 'ux-pass') {
    return 'ui_ux';
  }
  if (source === 'code-pass') {
    return 'code_logic';
  }
  if (touchPaths.length > 0 && touchPaths.every(touchPath => isUiTouchPath(touchPath, config))) {
    return 'ui_ux';
  }
  return 'code_logic';
}

function inferValidationProfile(
  touchPaths: string[],
  validationProfiles: Record<string, string>,
  config?: Pick<BacklogRunnerConfig, 'heuristics'>,
): string {
  if (touchPaths.length === 0) {
    return validationProfiles.repo ? 'repo' : '';
  }

  const rules = config?.heuristics.validationProfileRules ?? [];
  for (const rule of rules) {
    if (
      validationProfiles[rule.profile]
      && rule.pathPrefixes.length > 0
      && touchPaths.every(item => rule.pathPrefixes.some(prefix => item === prefix || item.startsWith(`${prefix}/`)))
    ) {
      return rule.profile;
    }
  }
  return validationProfiles.repo ? 'repo' : Object.keys(validationProfiles)[0] ?? '';
}

function taskFilename(taskSpecsDir: string, taskId: string): string {
  return path.join(taskSpecsDir, `${taskId}.yaml`);
}

function canonicalTaskSpecPath(taskSpecsDir: string, task: BacklogTaskSpec): string {
  if (task.state === 'done') {
    return path.join(taskSpecsDir, 'done', `${task.id}.yaml`);
  }
  return taskFilename(taskSpecsDir, task.id);
}

export function touchPathsOverlap(a: string[], b: string[]): boolean {
  return a.some(left => b.some(right => pathsOverlap(left, right)));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function isPathWithinTouchPaths(filePath: string, touchPaths: string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return touchPaths.some(entry => pathsOverlap(normalized, entry));
}

export function parseTaskSpec(raw: string, filePath: string): BacklogTaskSpec {
  const parsed = YAML.parse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid task spec in ${filePath}`);
  }

  const id = normalizeWhitespace(String(parsed.id ?? ''));
  const title = normalizeWhitespace(String(parsed.title ?? ''));
  const priorityValue = normalizeWhitespace(String(parsed.priority ?? 'normal')).toLowerCase();
  const priority: BacklogTaskPriority =
    priorityValue === 'high' || priorityValue === 'low' ? (priorityValue as BacklogTaskPriority) : 'normal';
  const stateValue = normalizeWhitespace(String(parsed.state ?? 'ready')).toLowerCase();
  const state: BacklogTaskState =
    stateValue === 'planned' || stateValue === 'done' || stateValue === 'failed' || stateValue === 'superseded'
      ? (stateValue as BacklogTaskState)
      : 'ready';
  const taskKindValue = normalizeWhitespace(String(parsed.task_kind ?? 'implementation')).toLowerCase();
  const taskKind: BacklogTaskKind = taskKindValue === 'research' ? 'research' : 'implementation';
  const dependsOn = [...new Set(toArray(parsed.depends_on).map(value => normalizeWhitespace(value)))];
  const touchPaths = [...new Set(toArray(parsed.touch_paths).map(value => normalizeRepoPath(value)).filter(Boolean))];
  const capabilities = [...new Set(toArray(parsed.capabilities).map(value => value.toLowerCase()))];
  const validationProfile = normalizeWhitespace(String(parsed.validation_profile ?? ''));
  const statusNotes = toArray(parsed.status_notes);
  const acceptanceCriteria = toArray(parsed.acceptance_criteria);
  const createdAt = normalizeWhitespace(String(parsed.created_at ?? ''));
  const updatedAt = normalizeWhitespace(String(parsed.updated_at ?? createdAt));
  const sourceValue = normalizeWhitespace(String(parsed.source ?? 'manual')).toLowerCase();
  const validSources = new Set<BacklogTaskSpec['source']>(['product-pass', 'interface-pass', 'ux-pass', 'code-pass', 'task-followup', 'planner-pass', 'manual']);
  if (!validSources.has(sourceValue as BacklogTaskSpec['source'])) {
    throw new Error(`Task spec ${filePath} has invalid source: ${sourceValue || '<empty>'}`);
  }
  const source = sourceValue as BacklogTaskSpec['source'];
  const executionDomain = inferExecutionDomain(
    taskKind,
    source,
    touchPaths,
    normalizeExecutionDomain(parsed.execution_domain),
  );

  if (!id || !title || !validationProfile || !createdAt || !updatedAt) {
    throw new Error(`Task spec ${filePath} is missing required fields`);
  }
  if (taskKind === 'implementation' && !executionDomain) {
    throw new Error(`Task spec ${filePath} is missing required execution_domain`);
  }

  return {
    id,
    title,
    priority,
    taskKind,
    executionDomain,
    dependsOn,
    touchPaths,
    capabilities,
    validationProfile,
    statusNotes,
    state,
    acceptanceCriteria,
    source,
    createdAt,
    updatedAt,
  };
}

async function collectTaskSpecFiles(taskSpecsDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async entry => {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return collectTaskSpecFiles(taskSpecsDir, entryPath);
      }
      if (entry.isFile() && TASK_FILE_PATTERN.test(entry.name)) {
        return [entryPath];
      }
      return [];
    }),
  );

  return nestedFiles
    .flat()
    .sort((left, right) => path.relative(taskSpecsDir, left).localeCompare(path.relative(taskSpecsDir, right)));
}

export async function listTaskSpecFiles(taskSpecsDir: string): Promise<string[]> {
  await mkdir(taskSpecsDir, { recursive: true });
  return collectTaskSpecFiles(taskSpecsDir, taskSpecsDir);
}

function serializeTaskSpec(task: BacklogTaskSpec): string {
  return YAML.stringify({
    id: task.id,
    title: task.title,
    priority: task.priority,
    task_kind: task.taskKind,
    execution_domain: task.taskKind === 'implementation' ? task.executionDomain : undefined,
    depends_on: task.dependsOn,
    touch_paths: task.touchPaths,
    capabilities: task.capabilities,
    validation_profile: task.validationProfile,
    status_notes: task.statusNotes,
    state: task.state,
    acceptance_criteria: task.acceptanceCriteria,
    source: task.source,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }, { indent: 2, lineWidth: 0 });
}

function groupTaskSpecRecords(records: TaskSpecFileRecord[]): Map<string, TaskSpecFileRecord[]> {
  const groups = new Map<string, TaskSpecFileRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.task.id) ?? [];
    existing.push(record);
    groups.set(record.task.id, existing);
  }
  return groups;
}

function taskSpecPathSort(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function chooseAuthoritativeTaskSpec(records: TaskSpecFileRecord[]): TaskSpecFileRecord {
  return [...records].sort((left, right) => (
    right.task.updatedAt.localeCompare(left.task.updatedAt)
    || taskSpecPathSort(left.relativePath, right.relativePath)
  ))[0]!;
}

export async function inspectTaskSpecStore(taskSpecsDir: string): Promise<{
  records: TaskSpecFileRecord[];
  duplicateTaskIds: string[];
}> {
  let records: TaskSpecFileRecord[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const taskSpecFiles = await listTaskSpecFiles(taskSpecsDir);
      records = await Promise.all(
        taskSpecFiles.map(async filePath => ({
          filePath,
          relativePath: normalizeRepoPath(path.relative(taskSpecsDir, filePath)),
          task: parseTaskSpec(await readFile(filePath, 'utf8'), filePath),
        })),
      );
      break;
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      if (code === 'ENOENT' && attempt === 0) {
        continue;
      }
      if (code === 'ENOENT') {
        return { records: [], duplicateTaskIds: [] };
      }
      throw error;
    }
  }
  const duplicateTaskIds = [...groupTaskSpecRecords(records).entries()]
    .filter(([, grouped]) => grouped.length > 1)
    .map(([taskId]) => taskId)
    .sort();
  return { records, duplicateTaskIds };
}

export async function normalizeTaskSpecStore(taskSpecsDir: string): Promise<{
  normalizedTaskIds: string[];
}> {
  const { records } = await inspectTaskSpecStore(taskSpecsDir);
  const normalizedTaskIds: string[] = [];
  for (const [taskId, grouped] of groupTaskSpecRecords(records).entries()) {
    const authoritative = chooseAuthoritativeTaskSpec(grouped);
    const canonicalPath = canonicalTaskSpecPath(taskSpecsDir, authoritative.task);
    const canonicalRelativePath = normalizeRepoPath(path.relative(taskSpecsDir, canonicalPath));
    const needsRewrite = grouped.length > 1 || authoritative.relativePath !== canonicalRelativePath;
    if (!needsRewrite) {
      continue;
    }

    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, serializeTaskSpec(authoritative.task), 'utf8');
    for (const record of grouped) {
      if (record.filePath !== canonicalPath) {
        await rm(record.filePath, { force: true });
      }
    }
    normalizedTaskIds.push(taskId);
  }

  return { normalizedTaskIds: normalizedTaskIds.sort() };
}

export async function readTaskSpecs(taskSpecsDir: string): Promise<BacklogTaskSpec[]> {
  let store = await inspectTaskSpecStore(taskSpecsDir);
  if (store.duplicateTaskIds.length > 0) {
    await normalizeTaskSpecStore(taskSpecsDir);
    store = await inspectTaskSpecStore(taskSpecsDir);
  }
  if (store.duplicateTaskIds.length > 0) {
    throw new Error(`Duplicate task spec ids found: ${store.duplicateTaskIds.join(', ')}. Run \`pnpm backlog:sync\` to normalize backlog/tasks.`);
  }
  return store.records.map(record => record.task).sort(taskSort);
}

export async function writeTaskSpec(taskSpecsDir: string, task: BacklogTaskSpec): Promise<void> {
  const { records } = await inspectTaskSpecStore(taskSpecsDir);
  const duplicatePaths = records
    .filter(record => record.task.id === task.id)
    .map(record => record.filePath);
  const canonicalPath = canonicalTaskSpecPath(taskSpecsDir, task);
  await mkdir(path.dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, serializeTaskSpec(task), 'utf8');
  for (const duplicatePath of duplicatePaths) {
    if (duplicatePath !== canonicalPath) {
      await rm(duplicatePath, { force: true });
    }
  }
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(item => normalizeWhitespace(String(item))).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : null;
}

function normalizePathArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map(item => normalizeRepoPath(String(item)))
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : null;
}

function normalizeCandidateSource(value: unknown): BacklogCandidateRecord['source'] | null {
  const normalized = normalizeWhitespace(String(value ?? '')).toLowerCase();
  if (
    normalized === 'product-pass' ||
    normalized === 'interface-pass' ||
    normalized === 'ux-pass' ||
    normalized === 'code-pass' ||
    normalized === 'task-followup' ||
    normalized === 'manual'
  ) {
    return normalized;
  }
  return null;
}

type CandidateParseResult =
  | { ok: true; candidate: BacklogCandidateRecord }
  | { ok: false; reason: string };

type CandidateMaterializationResult =
  | { ok: true; task: BacklogTaskSpec }
  | { ok: false; reason: string };

export function parseCandidateRecordDetailed(line: string): CandidateParseResult {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'candidate entry must be a JSON object' };
  }

  const title = normalizeWhitespace(String(parsed.title ?? ''));
  const priority = normalizePriority(parsed.priority ?? 'normal');
  const touchPaths = normalizePathArray(parsed.touch_paths);
  const acceptanceCriteria = normalizeStringArray(parsed.acceptance_criteria);
  const source = normalizeCandidateSource(parsed.source);
  if (!title) {
    return { ok: false, reason: 'missing title' };
  }
  if (!priority) {
    return { ok: false, reason: 'invalid priority' };
  }
  if (!touchPaths) {
    return { ok: false, reason: 'missing touch_paths' };
  }
  if (!acceptanceCriteria) {
    return { ok: false, reason: 'missing acceptance_criteria' };
  }
  if (!source) {
    return { ok: false, reason: 'invalid source' };
  }

  const validationProfile = normalizeWhitespace(String(parsed.validation_profile ?? '')) || undefined;
  const executionDomain = normalizeExecutionDomain(parsed.execution_domain);
  const capabilities = Array.isArray(parsed.capabilities)
    ? [...new Set(parsed.capabilities.map(item => normalizeWhitespace(String(item)).toLowerCase()).filter(Boolean))]
    : undefined;
  const context = normalizeWhitespace(String(parsed.context ?? '')) || undefined;

  return {
    ok: true,
    candidate: {
      title,
      priority,
      touchPaths,
      acceptanceCriteria,
      executionDomain,
      validationProfile,
      capabilities: capabilities && capabilities.length > 0 ? capabilities : undefined,
      context,
      source,
    },
  };
}

export function parseCandidateRecord(line: string): BacklogCandidateRecord | null {
  const result = parseCandidateRecordDetailed(line);
  return result.ok ? result.candidate : null;
}

export function createTaskFromCandidateDetailed(
  candidate: BacklogCandidateRecord,
  validationProfiles: Record<string, string>,
  config?: Pick<BacklogRunnerConfig, 'heuristics'>,
  nowIso = new Date().toISOString(),
): CandidateMaterializationResult {
  const title = normalizeWhitespace(candidate.title);
  const touchPaths = [...new Set(candidate.touchPaths.map(value => normalizeRepoPath(value)).filter(Boolean))];
  const acceptanceCriteria = [...new Set(candidate.acceptanceCriteria.map(item => normalizeWhitespace(item)).filter(Boolean))];
  if (!title) {
    return { ok: false, reason: 'missing title after normalization' };
  }
  if (touchPaths.length === 0) {
    return { ok: false, reason: 'candidate resolved to empty touch_paths' };
  }
  if (acceptanceCriteria.length === 0) {
    return { ok: false, reason: 'candidate resolved to empty acceptance_criteria' };
  }

  const validationProfile = candidate.validationProfile
    ? normalizeWhitespace(candidate.validationProfile)
    : inferValidationProfile(touchPaths, validationProfiles, config);
  if (!validationProfile) {
    return { ok: false, reason: 'missing validation_profile' };
  }
  if (!validationProfiles[validationProfile]) {
    return { ok: false, reason: `unknown validation profile "${validationProfile}"` };
  }

  const capabilities = candidate.capabilities && candidate.capabilities.length > 0
    ? [...new Set(candidate.capabilities.map(item => normalizeWhitespace(item).toLowerCase()).filter(Boolean))]
    : inferCapabilities(touchPaths, config);
  const statusNotes = candidate.context ? [`Context: ${candidate.context}`] : [];
  const executionDomain = inferExecutionDomain('implementation', candidate.source, touchPaths, candidate.executionDomain, config);

  return {
    ok: true,
    task: {
      id: createTaskId(title),
      title,
      priority: candidate.priority,
      taskKind: 'implementation',
      executionDomain,
      dependsOn: [],
      touchPaths,
      capabilities,
      validationProfile,
      statusNotes,
      state: 'ready',
      acceptanceCriteria,
      source: candidate.source,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

export function createTaskFromCandidate(
  candidate: BacklogCandidateRecord,
  validationProfiles: Record<string, string>,
  config?: Pick<BacklogRunnerConfig, 'heuristics'>,
  nowIso = new Date().toISOString(),
): BacklogTaskSpec | null {
  const result = createTaskFromCandidateDetailed(candidate, validationProfiles, config, nowIso);
  return result.ok ? result.task : null;
}

export function createTaskFromPlannerChild(
  child: PlannerTaskChild,
  validationProfiles: Record<string, string>,
  config?: Pick<BacklogRunnerConfig, 'heuristics'>,
  nowIso = new Date().toISOString(),
): BacklogTaskSpec | null {
  const title = normalizeWhitespace(child.title);
  const touchPaths = [...new Set(child.touchPaths.map(value => normalizeRepoPath(value)).filter(Boolean))];
  const acceptanceCriteria = [...new Set(child.acceptanceCriteria.map(item => normalizeWhitespace(item)).filter(Boolean))];
  if (!title || touchPaths.length === 0 || acceptanceCriteria.length === 0) {
    return null;
  }

  const validationProfile = child.validationProfile
    ? normalizeWhitespace(child.validationProfile)
    : inferValidationProfile(touchPaths, validationProfiles, config);
  if (!validationProfile || !validationProfiles[validationProfile]) {
    return null;
  }

  const capabilities = child.capabilities && child.capabilities.length > 0
    ? [...new Set(child.capabilities.map(item => normalizeWhitespace(item).toLowerCase()).filter(Boolean))]
    : inferCapabilities(touchPaths, config);
  const statusNotes = child.context ? [`Context: ${normalizeWhitespace(child.context)}`] : [];
  const executionDomain = inferExecutionDomain(child.taskKind, 'planner-pass', touchPaths, child.executionDomain, config);
  if (child.taskKind === 'implementation' && !executionDomain) {
    return null;
  }

  return {
    id: createTaskId(title),
    title,
    priority: child.priority,
    taskKind: child.taskKind,
    executionDomain,
    dependsOn: [],
    touchPaths,
    capabilities,
    validationProfile,
    statusNotes,
    state: 'ready',
    acceptanceCriteria,
    source: 'planner-pass',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function updateTask(task: BacklogTaskSpec, patch: Partial<BacklogTaskSpec>, nowIso = new Date().toISOString()): BacklogTaskSpec {
  return {
    ...task,
    ...patch,
    updatedAt: nowIso,
  };
}

export function renderGeneratedBacklog(tasks: BacklogTaskSpec[]): string {
  const lines = [
    '# UX Improvement Backlog',
    '',
    '<!-- This file is generated by packages/backlog-runner from backlog/tasks/**/*.yaml. -->',
    '<!-- Edit task specs in backlog/tasks/ (including nested directories such as backlog/tasks/done/); do not edit this report directly. -->',
    '',
  ];

  for (const task of tasks.sort(taskSort)) {
    if (task.state === 'superseded') continue;
    const priorityPrefix = task.priority === 'high' ? '[HIGH] ' : '';
    const title = `${priorityPrefix}${task.title}`;
    const marker = task.state === 'done'
      ? 'x'
      : task.state === 'failed'
        ? '!'
        : ' ';
    const suffix = task.state === 'planned' ? ' (Planned)' : '';
    lines.push(`- [${marker}] ${title}${suffix}`);
  }

  lines.push('');
  return lines.join('\n');
}
