import type { RunnerLogger } from '../logger.js';
import { normalizeRepoPath } from '../task-specs.js';
import type { BacklogCandidateRecord, BacklogStore, BacklogTaskClaim } from '../types.js';
import {
  BOOTSTRAP_MARKER_PATTERNS,
  MODULE_RESOLUTION_ERROR_PATTERNS,
  PACKAGE_RELATIVE_SRC_PATH_PATTERN,
  REPO_PATH_PATTERN,
  WORKTREE_LOCATION_PATTERNS,
} from './constants.js';
import { logDrainResult, normalizeInlineNote } from './helpers.js';
import { containsSharedInstallPolicyCode } from '../workspace/shared-install.js';

export type ValidationFailureClassification =
  | { blocking: true; reason: string }
  | { blocking: false; reason: string; followup: BacklogCandidateRecord };

function normalizeValidationReason(reason: string): string {
  return reason
    .replace(/^reconciliation\s+validation\s+failed:\s*/i, '')
    .replace(/^validation\s+failed:\s*/i, '')
    .trim();
}

function sanitizeValidationPath(filePath: string): string {
  return normalizeRepoPath(filePath.replace(/[(:].*$/, '').replace(/[),.;]+$/, ''));
}

function packageContextForPath(filePath: string): string {
  const normalized = sanitizeValidationPath(filePath);
  const parts = normalized.split('/');
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0]) {
    return parts[0];
  }
  return 'repo-root';
}

function inferChangedFileContext(changedFiles: string[]): string[] {
  const contexts = new Set<string>();
  for (const filePath of changedFiles) {
    const context = packageContextForPath(filePath);
    if (context !== 'repo-root') {
      contexts.add(context);
    }
  }
  return [...contexts];
}

function prefixRelativeSourcePaths(reason: string, changedFiles: string[]): string[] {
  const contexts = inferChangedFileContext(changedFiles);
  if (contexts.length !== 1) {
    return [];
  }

  const [context] = contexts;
  if (!context) {
    return [];
  }

  return [...reason.matchAll(PACKAGE_RELATIVE_SRC_PATH_PATTERN)]
    .filter(match => {
      const start = match.index ?? 0;
      return start === 0 || reason[start - 1] !== '/';
    })
    .map(match => sanitizeValidationPath(`${context}/${match[0]}`));
}

function extractValidationPaths(reason: string, changedFiles: string[]): string[] {
  const paths = new Set<string>();
  for (const match of reason.matchAll(REPO_PATH_PATTERN)) {
    paths.add(sanitizeValidationPath(match[1]));
  }
  for (const path of prefixRelativeSourcePaths(reason, changedFiles)) {
    paths.add(path);
  }
  return [...paths];
}

function isExplicitWorkspaceValidationIssue(reason: string): boolean {
  const hasModuleResolutionSignal = MODULE_RESOLUTION_ERROR_PATTERNS.some(pattern => pattern.test(reason));
  if (!hasModuleResolutionSignal) {
    return false;
  }

  const hasWorktreeLocation = WORKTREE_LOCATION_PATTERNS.some(pattern => pattern.test(reason));
  const hasBootstrapMarker = BOOTSTRAP_MARKER_PATTERNS.some(pattern => pattern.test(reason));
  return hasWorktreeLocation || hasBootstrapMarker;
}

function buildWorkspaceValidationFollowup(
  claim: BacklogTaskClaim,
  reason: string,
): BacklogCandidateRecord {
  return {
    title: 'Repair worktree validation environment',
    taskKind: 'implementation',
    priority: 'high',
    touchPaths: [
      'src/workspace/git-worktree.ts',
      'src/validate.ts',
    ],
    acceptanceCriteria: [
      'Fresh worktrees bootstrap dependency resolution reliably before validation reruns.',
      'Repo validation reruns no longer fail with missing-module workspace errors unrelated to completed task code.',
    ],
    executionDomain: 'code_logic',
    context: `Task "${claim.task.title}" completed its scoped work, but validation surfaced a worktree/bootstrap issue instead of a task-local defect: ${reason}`,
    source: { type: 'task-followup' },
  };
}

function buildUnrelatedValidationFollowup(
  claim: BacklogTaskClaim,
  reason: string,
  touchPaths: string[],
): BacklogCandidateRecord {
  return {
    title: `Resolve unrelated validation failure after ${claim.task.title}`,
    taskKind: 'implementation',
    priority: 'normal',
    touchPaths,
    acceptanceCriteria: [
      `Validation errors in ${touchPaths.join(', ')} are resolved.`,
      'The unrelated validation failure no longer blocks repo validation.',
    ],
    executionDomain: 'code_logic',
    context: `Task "${claim.task.title}" completed its scoped work, but validation surfaced an unrelated failure outside its touch_paths: ${reason}`,
    source: { type: 'task-followup' },
  };
}

export function classifyValidationFailure(
  claim: BacklogTaskClaim,
  reason: string,
  changedFiles: string[] = [],
): ValidationFailureClassification {
  const normalizedReason = normalizeValidationReason(reason);
  if (containsSharedInstallPolicyCode(normalizedReason)) {
    return { blocking: true, reason };
  }
  const implicatedPaths = extractValidationPaths(normalizedReason, changedFiles);
  const normalizedChangedFiles = changedFiles.map(filePath => normalizeRepoPath(filePath));
  const changedFileSet = new Set(normalizedChangedFiles);
  const changedContexts = new Set(normalizedChangedFiles.map(packageContextForPath));

  if (isExplicitWorkspaceValidationIssue(normalizedReason)) {
    return {
      blocking: false,
      reason,
      followup: buildWorkspaceValidationFollowup(claim, normalizedReason),
    };
  }

  if (implicatedPaths.length > 0) {
    const implicatedContexts = new Set(implicatedPaths.map(packageContextForPath));
    const matchesChangedFile = implicatedPaths.some(filePath => changedFileSet.has(filePath));
    const sharesChangedContext = [...implicatedContexts].some(context => changedContexts.has(context));
    if (matchesChangedFile || sharesChangedContext) {
      return { blocking: true, reason };
    }

    return {
      blocking: false,
      reason,
      followup: buildUnrelatedValidationFollowup(claim, normalizedReason, implicatedPaths),
    };
  }

  return { blocking: true, reason };
}

export async function queueNonBlockingValidationFollowup(
  store: BacklogStore,
  logger: RunnerLogger,
  claim: BacklogTaskClaim,
  failure: Extract<ValidationFailureClassification, { blocking: false }>,
): Promise<void> {
  await store.enqueueCandidate(failure.followup);
  const drained = await store.drainCandidateQueue();
  await store.appendTaskNote(claim.task.id, `Non-blocking validation issue deferred to follow-up: ${normalizeInlineNote(failure.reason)}`);
  logDrainResult(logger, 'Candidate planner', drained);
  logger.line(`  ⚠ Non-blocking validation issue queued as follow-up: ${failure.followup.title}`);
}
