import path from 'node:path';
import { plannerBatchSize, plannerContextForTasks } from './planner.js';
import { inspectTaskSpecStore, taskSort } from './task-specs.js';
import type { BacklogRunnerConfig, BacklogTaskClaim, BacklogTaskSpec, TaskDependencySnapshot, TaskReservationSnapshot } from './types.js';
import { readFileIfExists } from './utils.js';

const EXECUTION_PROGRESS_SECTIONS = 2;
const EXECUTION_PROGRESS_CHARS = 3_500;
const DISCOVERY_PROGRESS_SECTIONS = 3;
const DISCOVERY_PROGRESS_CHARS = 4_500;
const EXECUTION_PATTERN_ENTRIES = 10;
const DISCOVERY_PATTERN_ENTRIES = 14;
const PATTERN_CHAR_BUDGET = 6_000;
const BACKLOG_ITEM_LIMIT = 24;
const BACKLOG_CHAR_BUDGET = 5_000;

type PatternEntry = {
  text: string;
  score: number;
  index: number;
};

function repoRelativeConfigPath(config: BacklogRunnerConfig, absolutePath: string): string {
  return path.posix.normalize(path.relative(config.projectRoot, absolutePath).split(path.sep).join('/'));
}

function trimToBudget(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n… [truncated]`;
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

function renderPatternDigest(entries: PatternEntry[], maxEntries: number): string {
  const selected = entries.slice(0, maxEntries);
  const lines: string[] = [];
  let used = 0;

  for (const entry of selected) {
    const next = entry.text.trim();
    if (!next) continue;
    if (used + next.length > PATTERN_CHAR_BUDGET && lines.length > 0) break;
    lines.push(next);
    used += next.length;
  }

  if (lines.length === 0) return '- None';
  const omitted = Math.max(0, entries.length - lines.length);
  const suffix = omitted > 0 ? `\n- … ${omitted} additional patterns omitted` : '';
  return `${lines.join('\n')}${suffix}`;
}

function selectPatternDigest(content: string, keywords: Set<string>, maxEntries: number): string {
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
  return renderPatternDigest([...matched, ...fallback], maxEntries);
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

async function readRecentSections(progressFile: string, maxSections: number, maxChars: number): Promise<string> {
  const content = await readFileIfExists(progressFile, '');
  const sections = parseProgressSections(content);
  if (sections.length === 0) return 'No prior session entries.';
  return trimToBudget(sections.slice(-maxSections).join('\n\n'), maxChars);
}

function renderTaskDigestLabel(task: BacklogTaskSpec): string {
  const prefix = task.priority === 'high' ? '[HIGH] ' : '';
  return `- [${task.state}] ${prefix}${task.title}`;
}

function renderBacklogDigest(tasks: BacklogTaskSpec[], fallbackContent: string): string {
  if (tasks.length === 0) {
    const trimmed = fallbackContent.trim();
    return trimmed ? trimToBudget(trimmed, BACKLOG_CHAR_BUDGET) : 'Backlog unavailable.';
  }

  const counts = {
    ready: tasks.filter(task => task.state === 'ready').length,
    planned: tasks.filter(task => task.state === 'planned').length,
    failed: tasks.filter(task => task.state === 'failed').length,
    done: tasks.filter(task => task.state === 'done').length,
  };
  const actionableItems = tasks
    .filter(task => task.state === 'ready' || task.state === 'planned' || task.state === 'failed')
    .sort(taskSort)
    .slice(0, BACKLOG_ITEM_LIMIT)
    .map(renderTaskDigestLabel);

  const summaryLines = [
    `Queue summary: ${counts.ready} ready · ${counts.planned} planned · ${counts.failed} failed · ${counts.done} done`,
    '',
    'Top actionable items:',
    ...(actionableItems.length > 0 ? actionableItems : ['- None']),
  ];

  if (tasks.length > BACKLOG_ITEM_LIMIT) {
    summaryLines.push(`- … ${tasks.length - BACKLOG_ITEM_LIMIT} additional backlog items omitted`);
  }
  return trimToBudget(summaryLines.join('\n'), BACKLOG_CHAR_BUDGET);
}

async function loadBacklogDigestState(config: BacklogRunnerConfig): Promise<{ digest: string; keywords: Set<string> }> {
  const [backlogContent, taskSpecStore] = await Promise.all([
    readFileIfExists(config.files.backlog, 'Backlog unavailable.'),
    inspectTaskSpecStore(config.files.taskSpecsDir),
  ]);
  const tasks = taskSpecStore.records
    .map(record => record.task)
    .filter(task => task.state !== 'superseded')
    .sort(taskSort);

  if (tasks.length === 0) {
    return {
      digest: renderBacklogDigest([], backlogContent),
      keywords: keywordSetForDiscovery(backlogContent),
    };
  }

  return {
    digest: renderBacklogDigest(tasks, backlogContent),
    keywords: keywordSetForBacklogTasks(tasks),
  };
}

export async function buildExecutionContext(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
): Promise<string> {
  const [patternsContent, recent] = await Promise.all([
    readFileIfExists(config.files.patterns, ''),
    readRecentSections(config.files.progress, EXECUTION_PROGRESS_SECTIONS, EXECUTION_PROGRESS_CHARS),
  ]);
  const keywords = keywordSetForTask(config, claim);
  const validationCommand = config.validationProfiles[claim.task.validationProfile] ?? config.validationCommand;
  const dependencySection = dependencies.length === 0
    ? '- None'
    : dependencies.map(dep => `- ${dep.title} (${dep.taskId}) — ${dep.state}`).join('\n');
  const reservationSection = reservations.length === 0
    ? '- None'
    : reservations.map(reservation => {
        const touchPaths = reservation.touchPaths.length > 0 ? reservation.touchPaths.join(', ') : '(none)';
        const capabilities = reservation.capabilities.length > 0 ? reservation.capabilities.join(', ') : '(none)';
        return `- ${reservation.title} (${reservation.taskId}) — touch_paths: ${touchPaths}; capabilities: ${capabilities}; lease expires: ${reservation.expiresAt}`;
      }).join('\n');
  const acceptanceCriteria = claim.task.acceptanceCriteria.length > 0
    ? claim.task.acceptanceCriteria.map(item => `- ${item}`).join('\n')
    : `- ${claim.task.title}`;

  return `## Relevant Patterns
${selectPatternDigest(patternsContent, keywords, EXECUTION_PATTERN_ENTRIES)}

## Recent Session Digest
${recent}

## Assigned Task
ID: ${claim.task.id}
Title: ${claim.task.title}
Priority: ${claim.task.priority}
Task kind: ${claim.task.taskKind}
Execution domain: ${claim.task.executionDomain ?? 'n/a'}
Validation profile: ${claim.task.validationProfile}

Declared touch_paths (intended starting surface):
${claim.task.touchPaths.map(item => `- ${item}`).join('\n') || '- None'}

Capabilities:
${claim.task.capabilities.map(item => `- ${item}`).join('\n') || '- None'}

Dependencies:
${dependencySection}

Acceptance criteria:
${acceptanceCriteria}

Status notes:
${claim.task.statusNotes.map(item => `- ${item}`).join('\n') || '- None'}

## Active Reservations
${reservationSection}

## Validation Command
The scheduler will run this exact command after your task is complete:
${validationCommand}

Use smaller targeted checks while you work. Do not rerun the full final validation command unless you need it to debug a failure.

## Candidate Queue
If this work reveals another backlog item or context that a later run should keep, append one JSON object per line to:
${repoRelativeConfigPath(config, config.files.candidateQueue)}

Schema:
{"title":"Standalone backlog item title","priority":"high|normal|low","touch_paths":["repo/path"],"acceptance_criteria":["Concrete completion check"],"execution_domain":"ui_ux|code_logic","validation_profile":"optional","capabilities":["optional"],"context":"Optional concise context for the future run","source":{"type":"task-followup"}}

## Stop Rules
- Do not modify backlog.md directly; it is generated from ${repoRelativeConfigPath(config, config.files.taskSpecsDir)}.
- Start from the declared touch_paths, but broaden the edit set when adjacent changes are required to satisfy the task coherently.
- Do not start adjacent cleanup just because it is nearby; adjacent discoveries become follow-up tasks.
- Do not change another active task's reserved files or subsystem surface.
- If task kind is research, inspect code and write concrete follow-up backlog items only. Do not implement product or server code during the research task.`;
}

function renderPathList(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '- None';
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
): Promise<string> {
  const base = await buildExecutionContext(config, claim, dependencies, reservations);
  const trimmedDiff = options.originalDiff
    ? trimToBudget(options.originalDiff, 12_000)
    : null;

  return `${base}

## Workspace Repair Failure
Repair mode: ${options.mode}

Failure reason:
${options.failureReason}

Validation summary:
${options.validationSummary ?? 'None'}

Changed files:
${renderPathList(options.changedFiles)}

Staged files:
${renderPathList(options.stagedFiles)}

Changed files that match declared touch_paths:
${renderPathList(options.declaredTouchPathFiles)}

Additional changed files beyond declared touch_paths:
${renderPathList(options.additionalFiles)}
${trimmedDiff ? `

## Relevant Diff
\`\`\`diff
${trimmedDiff}
\`\`\`` : ''}

## Workspace Repair Goal
- This repository is agent-operated by default. Assume repo changes are agent-originated unless the local code clearly proves otherwise.
- You may inspect, preserve, discard, split into follow-up work, or restage changes when that is the best way to recover the assigned task.
- If you discard or split work, leave an audit trail in progress notes so a later agent can understand the decision.
- If the task is stale or impossible, return failed with a note starting exactly \`stale —\` or \`impossible —\`.
- If the workspace can be repaired so scheduler checks pass, return done.
- Keep the final result coherent with the assigned acceptance criteria. Use declared touch_paths as a guide, not as a hard boundary, while still respecting active reservations and backlog bookkeeping rules.`;
}

export async function buildReconciliationContext(
  config: BacklogRunnerConfig,
  claim: BacklogTaskClaim,
  dependencies: TaskDependencySnapshot[],
  reservations: TaskReservationSnapshot[],
  failureReason: string,
  originalDiff: string,
): Promise<string> {
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
): Promise<string> {
  const [patternsContent, recent, backlogState] = await Promise.all([
    readFileIfExists(config.files.patterns, ''),
    readRecentSections(config.files.progress, DISCOVERY_PROGRESS_SECTIONS, DISCOVERY_PROGRESS_CHARS),
    loadBacklogDigestState(config),
  ]);
  const keywords = backlogState.keywords;
  const currentPass = config.passes[passId];
  const otherPasses = Object.values(config.passes)
    .filter(pass => pass.id !== passId && pass.enabled)
    .map(pass => `- ${pass.id}${pass.description ? `: ${pass.description}` : ''}`)
    .join('\n') || '- None';
  const heuristics = currentPass
    ? [
        `Include path hints:\n${currentPass.heuristics.includePaths.map(item => `- ${item}`).join('\n') || '- None'}`,
        `Exclude path hints:\n${currentPass.heuristics.excludePaths.map(item => `- ${item}`).join('\n') || '- None'}`,
        `Capability hints:\n${currentPass.heuristics.capabilities.map(item => `- ${item}`).join('\n') || '- None'}`,
      ].join('\n\n')
    : 'No current pass metadata available.';

  return `## Relevant Patterns
${selectPatternDigest(patternsContent, keywords, DISCOVERY_PATTERN_ENTRIES)}

## Recent Session Digest
${recent}

## Backlog Digest
${backlogState.digest}

## Current Discovery Pass
Pass id: ${currentPass?.id ?? passId}
Description: ${currentPass?.description ?? 'None'}

${heuristics}

## Other Configured Discovery Passes
${otherPasses}

## Planner Flow
Configured discovery passes write structured JSONL candidate records to ${repoRelativeConfigPath(config, config.files.candidateQueue)}.
The planner step converts those entries into ${repoRelativeConfigPath(config, config.files.taskSpecsDir)}/**/*.yaml and only runnable task specs are eligible for execution.
Do not modify backlog.md directly.`;
}

export async function buildPlannerContext(
  config: BacklogRunnerConfig,
  plannerCandidates: BacklogTaskSpec[],
): Promise<string> {
  const [patternsContent, recent, backlogState] = await Promise.all([
    readFileIfExists(config.files.patterns, ''),
    readRecentSections(config.files.progress, DISCOVERY_PROGRESS_SECTIONS, DISCOVERY_PROGRESS_CHARS),
    loadBacklogDigestState(config),
  ]);
  const keywords = backlogState.keywords;

  return `## Relevant Patterns
${selectPatternDigest(patternsContent, keywords, DISCOVERY_PATTERN_ENTRIES)}

## Recent Session Digest
${recent}

## Backlog Digest
${backlogState.digest}

## Tasks To Refine
Refine at most ${plannerBatchSize()} planner candidates in this pass.
Failed tasks are recovery work and should be treated as higher-priority planner inputs than untouched planned tasks.

${plannerContextForTasks(plannerCandidates)}

## Refinement Rules
- Treat this as a read-only planning pass. Do not edit repo files directly.
- Failed task status notes are recovery evidence. Use them to decide whether to replace the task as-is, narrow it, or emit prerequisite work.
- Prefer one clustered research task when multiple selected items clearly overlap.
- Supersede parents with child tasks; do not keep duplicate parent work alive.
- Prefer research tasks that inspect code and emit concrete implementation follow-up tasks.
- Research children must stay backlog-only; the scheduler will force backlog touch_paths and the backlog validation profile.
- For every selected failed task, either emit a like-for-like replacement child or emit narrower/prerequisite children that explain the recovery path.
- Return one strict JSON object matching the requested schema.`;
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
