import path from 'node:path';
import { buildContextPayload } from './context-cache.js';
import { plannerBatchSize } from './planner.js';
import { inspectTaskSpecStore, taskSort } from './task-specs.js';
import type {
  AgentContextPayload,
  BacklogRunnerConfig,
  BacklogTaskClaim,
  BacklogTaskSpec,
  TaskDependencySnapshot,
  TaskReservationSnapshot,
} from './types.js';
import { normalizeWhitespace, readFileIfExists } from './utils.js';

const EXECUTION_PROGRESS_SECTIONS = 2;
const DISCOVERY_PROGRESS_SECTIONS = 3;
const EXECUTION_PATTERN_ENTRIES = 8;
const DISCOVERY_PATTERN_ENTRIES = 10;
const PATTERN_CHAR_BUDGET = 2_400;
const BACKLOG_ITEM_LIMIT = 12;
const BACKLOG_FALLBACK_CHAR_BUDGET = 2_400;
const PROGRESS_HIGHLIGHTS_PER_ENTRY = 3;
const PROGRESS_LINE_CHAR_LIMIT = 180;

type ProgressDigestEntry = {
  entry: string;
  highlights: string[];
};

type BacklogSummary = {
  source: 'task_specs' | 'backlog_report_fallback';
  queue_counts?: {
    ready: number;
    planned: number;
    failed: number;
    done: number;
  };
  top_actionable?: Array<{
    id: string;
    title: string;
    priority: BacklogTaskSpec['priority'];
    state: BacklogTaskSpec['state'];
  }>;
  fallback_excerpt?: string;
};

function repoRelativeConfigPath(config: BacklogRunnerConfig, absolutePath: string): string {
  return path.posix.normalize(path.relative(config.projectRoot, absolutePath).split(path.sep).join('/'));
}

function trimToBudget(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()} … [truncated]`;
}

function compactText(value: string, maxChars = PROGRESS_LINE_CHAR_LIMIT): string {
  return trimToBudget(normalizeWhitespace(value), maxChars);
}

function normalizeWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/_-]+/g, '');
}

function addWords(target: Set<string>, value: string): void {
  for (const fragment of value.split(/[^a-zA-Z0-9/_-]+/g)) {
    const word = normalizeWord(fragment);
    if (!word || word.length < 4) continue;
    target.add(word);
  }
}

function keywordSetForTask(config: BacklogRunnerConfig, claim: BacklogTaskClaim): Set<string> {
  const keywords = new Set<string>();
  addWords(keywords, claim.task.title);
  addWords(keywords, claim.task.validationProfile);
  for (const note of claim.task.statusNotes) addWords(keywords, note);
  for (const criterion of claim.task.acceptanceCriteria) addWords(keywords, criterion);
  for (const capability of claim.task.capabilities) addWords(keywords, capability);
  for (const touchPath of claim.task.touchPaths) {
    addWords(keywords, touchPath);
    addWords(keywords, path.posix.basename(touchPath));
    for (const segment of touchPath.split('/')) {
      addWords(keywords, segment);
    }
  }
  addWords(keywords, path.relative(config.projectRoot, config.files.progress));
  return keywords;
}

function keywordSetForDiscovery(backlogContent: string): Set<string> {
  const keywords = new Set<string>();
  for (const match of backlogContent.matchAll(/^##\s+(.+)$/gm)) {
    addWords(keywords, match[1] ?? '');
  }
  for (const match of backlogContent.matchAll(/^- \[[ ~x!]\]\s+(.+)$/gm)) {
    addWords(keywords, match[1] ?? '');
  }
  return keywords;
}

function keywordSetForBacklogTasks(tasks: BacklogTaskSpec[]): Set<string> {
  const keywords = new Set<string>();
  for (const task of tasks) {
    addWords(keywords, task.title);
    addWords(keywords, task.validationProfile);
    for (const note of task.statusNotes) addWords(keywords, note);
    for (const criterion of task.acceptanceCriteria) addWords(keywords, criterion);
    for (const capability of task.capabilities) addWords(keywords, capability);
    for (const touchPath of task.touchPaths) {
      addWords(keywords, touchPath);
      addWords(keywords, path.posix.basename(touchPath));
    }
  }
  return keywords;
}

function parsePatternEntries(content: string): string[] {
  const entries: string[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (current.length > 0) entries.push(current.join('\n').trim());
      current = [line];
      continue;
    }
    if (current.length > 0) {
      if (!line.trim() && current[current.length - 1] === '') continue;
      current.push(line);
    }
  }

  if (current.length > 0) entries.push(current.join('\n').trim());
  return entries.filter(Boolean);
}

function scorePattern(text: string, keywords: Set<string>): number {
  const haystack = normalizeWord(text);
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += keyword.length >= 8 ? 3 : 2;
  }
  return score;
}

function selectPatternEntries(content: string, keywords: Set<string>, maxEntries: number): string[] {
  const parsed = parsePatternEntries(content);
  const scored = parsed.map((text, index) => ({
    text,
    index,
    score: scorePattern(text, keywords),
  }));
  const matched = scored
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const fallback = scored.filter(entry => entry.score === 0).sort((left, right) => left.index - right.index);
  const selected = [...matched, ...fallback].slice(0, maxEntries);

  const result: string[] = [];
  let usedChars = 0;
  for (const entry of selected) {
    const compact = compactText(entry.text, 220);
    if (!compact) continue;
    if (usedChars + compact.length > PATTERN_CHAR_BUDGET && result.length > 0) {
      break;
    }
    result.push(compact);
    usedChars += compact.length;
  }

  return result;
}

function parseProgressSections(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/^## /gm)
    .map(section => section.trim())
    .filter(Boolean)
    .map(section => `## ${section}`);
}

function summarizeProgressSection(section: string): ProgressDigestEntry | null {
  const lines = section.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd());
  const heading = compactText(lines[0]?.replace(/^##\s*/, '') ?? '', 120);
  if (!heading) {
    return null;
  }

  const highlights: string[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (trimmed.startsWith('## ')) break;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      highlights.push(compactText(trimmed.slice(2)));
      continue;
    }
    if (trimmed.startsWith('**Learnings') || trimmed.startsWith('Learnings')) {
      highlights.push(compactText(trimmed.replace(/^\*+|\*+$/g, '')));
      continue;
    }
  }

  const selectedHighlights = [...new Set(highlights)].slice(0, PROGRESS_HIGHLIGHTS_PER_ENTRY);
  return {
    entry: heading,
    highlights: selectedHighlights,
  };
}

async function readRecentProgressSummary(progressFile: string, maxSections: number): Promise<ProgressDigestEntry[]> {
  const content = await readFileIfExists(progressFile, '');
  const sections = parseProgressSections(content);
  if (sections.length === 0) {
    return [];
  }
  return sections
    .slice(-maxSections)
    .map(summarizeProgressSection)
    .filter((entry): entry is ProgressDigestEntry => Boolean(entry));
}

function buildBacklogSummary(tasks: BacklogTaskSpec[], fallbackContent: string): BacklogSummary {
  if (tasks.length === 0) {
    const trimmed = fallbackContent.trim();
    return {
      source: 'backlog_report_fallback',
      fallback_excerpt: trimmed ? trimToBudget(trimmed, BACKLOG_FALLBACK_CHAR_BUDGET) : 'Backlog unavailable.',
    };
  }

  return {
    source: 'task_specs',
    queue_counts: {
      ready: tasks.filter(task => task.state === 'ready').length,
      planned: tasks.filter(task => task.state === 'planned').length,
      failed: tasks.filter(task => task.state === 'failed').length,
      done: tasks.filter(task => task.state === 'done').length,
    },
    top_actionable: tasks
      .filter(task => task.state === 'ready' || task.state === 'planned' || task.state === 'failed')
      .sort(taskSort)
      .slice(0, BACKLOG_ITEM_LIMIT)
      .map(task => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        state: task.state,
      })),
  };
}

async function loadBacklogSummary(config: BacklogRunnerConfig): Promise<{ summary: BacklogSummary; keywords: Set<string> }> {
  const [backlogContent, taskSpecStore] = await Promise.all([
    readFileIfExists(config.files.backlog, ''),
    inspectTaskSpecStore(config.files.taskSpecsDir),
  ]);
  const tasks = taskSpecStore.records
    .map(record => record.task)
    .filter(task => task.state !== 'superseded')
    .sort(taskSort);

  if (tasks.length === 0) {
    return {
      summary: buildBacklogSummary([], backlogContent),
      keywords: keywordSetForDiscovery(backlogContent),
    };
  }

  return {
    summary: buildBacklogSummary(tasks, backlogContent),
    keywords: keywordSetForBacklogTasks(tasks),
  };
}

async function buildRepoMemorySection(
  config: BacklogRunnerConfig,
  keywords: Set<string>,
  options: {
    patternEntryLimit: number;
    progressSectionLimit: number;
    backlogState?: { summary: BacklogSummary; keywords: Set<string> };
  },
): Promise<{
  source: string;
  backlog: BacklogSummary;
  pattern_highlights: string[];
  recent_progress: ProgressDigestEntry[];
}> {
  const [patternsContent, progressSummary, backlogState] = await Promise.all([
    readFileIfExists(config.files.patterns, ''),
    readRecentProgressSummary(config.files.progress, options.progressSectionLimit),
    options.backlogState ? Promise.resolve(options.backlogState) : loadBacklogSummary(config),
  ]);

  return {
    source: 'synthesized(task_specs,patterns.md,progress.txt)',
    backlog: backlogState.summary,
    pattern_highlights: selectPatternEntries(patternsContent, keywords.size > 0 ? keywords : backlogState.keywords, options.patternEntryLimit),
    recent_progress: progressSummary,
  };
}

function compactTask(task: BacklogTaskSpec): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    state: task.state,
    task_kind: task.taskKind,
    execution_domain: task.executionDomain ?? null,
    validation_profile: task.validationProfile,
    touch_paths: task.touchPaths,
    capabilities: task.capabilities,
    acceptance_criteria: task.acceptanceCriteria,
    status_notes: task.statusNotes.slice(-6),
  };
}

function sortDependencies(dependencies: TaskDependencySnapshot[]): TaskDependencySnapshot[] {
  return [...dependencies].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function sortReservations(reservations: TaskReservationSnapshot[]): TaskReservationSnapshot[] {
  return [...reservations].sort((left, right) => (
    left.taskId.localeCompare(right.taskId)
    || left.title.localeCompare(right.title)
  ));
}

async function buildExecutionSections(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
): Promise<Array<{ name: string; value: unknown }>> {
  const keywords = keywordSetForTask(config, claim);
  const validationCommand = config.validationProfiles[claim.task.validationProfile] ?? config.validationCommand;
  const repoMemory = await buildRepoMemorySection(config, keywords, {
    patternEntryLimit: EXECUTION_PATTERN_ENTRIES,
    progressSectionLimit: EXECUTION_PROGRESS_SECTIONS,
  });

  return [
    {
      name: 'REPO_MEMORY_JSON',
      value: repoMemory,
    },
    {
      name: 'TASK_BRIEF_JSON',
      value: {
        source: 'task_specs',
        task: compactTask(claim.task),
      },
    },
    {
      name: 'LIVE_STATE_JSON',
      value: {
        source: 'runtime_state+config',
        dependencies: sortDependencies(dependencies).map(dep => ({
          task_id: dep.taskId,
          title: dep.title,
          state: dep.state,
        })),
        active_reservations: sortReservations(reservations).map(reservation => ({
          task_id: reservation.taskId,
          title: reservation.title,
          touch_paths: reservation.touchPaths,
          capabilities: reservation.capabilities,
          expires_at: reservation.expiresAt,
        })),
        validation_command: validationCommand,
        candidate_queue_path: repoRelativeConfigPath(config, config.files.candidateQueue),
        task_specs_dir: repoRelativeConfigPath(config, config.files.taskSpecsDir),
      },
    },
  ];
}

export async function buildExecutionContext(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
): Promise<AgentContextPayload> {
  return buildContextPayload('execution', await buildExecutionSections(config, claim, dependencies, reservations));
}

function renderPathList(items: string[]): string[] {
  return items.map(item => compactText(item, 220));
}

export async function buildWorkspaceRepairContext(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
  options: {
    failureReason: string;
    mode: 'preflight' | 'validation' | 'finalize';
    changedFiles: string[];
    stagedFiles: string[];
    declaredTouchPathFiles: string[];
    additionalFiles: string[];
    validationSummary?: string;
    originalDiff?: string;
  },
): Promise<AgentContextPayload> {
  const sections = await buildExecutionSections(config, claim, dependencies, reservations);
  const trimmedDiff = options.originalDiff ? trimToBudget(options.originalDiff, 8_000) : undefined;
  sections.push({
    name: 'WORKSPACE_REPAIR_JSON',
    value: {
      source: 'workspace_snapshot',
      mode: options.mode,
      failure_reason: compactText(options.failureReason, 240),
      validation_summary: options.validationSummary ? compactText(options.validationSummary, 240) : undefined,
      changed_files: renderPathList(options.changedFiles),
      staged_files: renderPathList(options.stagedFiles),
      declared_touch_path_files: renderPathList(options.declaredTouchPathFiles),
      additional_files: renderPathList(options.additionalFiles),
      relevant_diff: trimmedDiff,
    },
  });
  return buildContextPayload(options.mode === 'finalize' ? 'reconciliation' : 'repair', sections);
}

export async function buildReconciliationContext(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
  failureReason: string,
  originalDiff: string,
): Promise<AgentContextPayload> {
  return buildWorkspaceRepairContext(config, claim, dependencies, reservations, {
    failureReason,
    mode: 'finalize',
    changedFiles: [],
    stagedFiles: [],
    declaredTouchPathFiles: [],
    additionalFiles: [],
    originalDiff,
  });
}

export async function buildDiscoveryContext(
  config: BacklogRunnerConfig,
  passId: string,
): Promise<AgentContextPayload> {
  const backlogState = await loadBacklogSummary(config);
  const repoMemory = await buildRepoMemorySection(config, backlogState.keywords, {
    patternEntryLimit: DISCOVERY_PATTERN_ENTRIES,
    progressSectionLimit: DISCOVERY_PROGRESS_SECTIONS,
    backlogState,
  });
  const currentPass = config.passes[passId];
  const otherPasses = Object.values(config.passes)
    .filter(pass => pass.id !== passId && pass.enabled)
    .sort((left, right) => left.id.localeCompare(right.id));

  return buildContextPayload('discovery', [
    {
      name: 'REPO_MEMORY_JSON',
      value: repoMemory,
    },
    {
      name: 'DISCOVERY_BRIEF_JSON',
      value: {
        source: 'pass_config',
        current_pass: currentPass
          ? {
              id: currentPass.id,
              description: currentPass.description ?? null,
              include_paths: currentPass.heuristics.includePaths,
              exclude_paths: currentPass.heuristics.excludePaths,
              capabilities: currentPass.heuristics.capabilities,
            }
          : {
              id: passId,
              description: null,
              include_paths: [],
              exclude_paths: [],
              capabilities: [],
            },
        other_enabled_passes: otherPasses.map(pass => ({
          id: pass.id,
          description: pass.description ?? null,
        })),
        candidate_queue_path: repoRelativeConfigPath(config, config.files.candidateQueue),
        task_specs_dir: repoRelativeConfigPath(config, config.files.taskSpecsDir),
      },
    },
  ]);
}

export async function buildPlannerContext(
  config: BacklogRunnerConfig,
  plannerCandidates: BacklogTaskSpec[],
): Promise<AgentContextPayload> {
  const backlogState = await loadBacklogSummary(config);
  const repoMemory = await buildRepoMemorySection(config, backlogState.keywords, {
    patternEntryLimit: DISCOVERY_PATTERN_ENTRIES,
    progressSectionLimit: DISCOVERY_PROGRESS_SECTIONS,
    backlogState,
  });

  return buildContextPayload('planner', [
    {
      name: 'REPO_MEMORY_JSON',
      value: repoMemory,
    },
    {
      name: 'PLANNER_BATCH_JSON',
      value: {
        source: 'task_specs',
        max_batch_size: plannerBatchSize(),
        parents: plannerCandidates.slice(0, plannerBatchSize()).map(task => compactTask(task)),
      },
    },
  ]);
}

export async function inspectBacklogState(
  config: BacklogRunnerConfig,
): Promise<{
  generatedReport: boolean;
  hasLegacyTasks: boolean;
  taskSpecCount: number;
  duplicateTaskIds: string[];
}> {
  const [backlogContent, taskSpecStore] = await Promise.all([
    readFileIfExists(config.files.backlog, ''),
    inspectTaskSpecStore(config.files.taskSpecsDir),
  ]);
  return {
    generatedReport: backlogContent.includes('<!-- This file is generated by packages/backlog-runner'),
    hasLegacyTasks: /^- \[[ ~x!]\]\s+/m.test(backlogContent),
    taskSpecCount: taskSpecStore.records.length,
    duplicateTaskIds: taskSpecStore.duplicateTaskIds,
  };
}
