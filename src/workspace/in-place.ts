import { lockPath, withLock } from '../locks.js';
import { sleep as defaultSleep } from '../process.js';
import { isWorktreeBootstrapArtifact, normalizePathForGit } from '../git-scope.js';
import { parseGitStatusPaths } from '../utils.js';
import type {
  BacklogRunnerConfig,
  CommandRunner,
  WorkspaceApplyResult,
  WorkspaceCommitOptions,
  WorkspaceSession,
  WorkspaceStrategy,
} from '../types.js';

function summarizeGitFailure(stdout: string, stderr: string): string {
  const lines = [stdout, stderr]
    .join('\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return lines.slice(-6).join(' | ') || 'git command failed';
}

async function collectChangedFiles(commandRunner: CommandRunner, cwd: string): Promise<string[]> {
  const status = await commandRunner.run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    ignoreFailure: true,
  });
  return status.code === 0 ? parseGitStatusPaths(status.stdout) : [];
}

async function collectStagedFiles(commandRunner: CommandRunner, cwd: string): Promise<string[]> {
  const result = await commandRunner.run('git', ['diff', '--cached', '--name-only'], {
    cwd,
    ignoreFailure: true,
  });
  return result.code === 0
    ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    : [];
}

function pathMatchesPrefix(file: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
}

function excludedCommitFiles(files: string[], excludedPaths: string[]): string[] {
  return files.filter(file => {
    const normalized = normalizePathForGit(file);
    return isWorktreeBootstrapArtifact(normalized) || pathMatchesPrefix(normalized, excludedPaths);
  });
}

export async function hasUpstream(commandRunner: CommandRunner, cwd: string): Promise<boolean> {
  const result = await commandRunner.run(
    'git', ['rev-parse', '--abbrev-ref', '@{upstream}'],
    { cwd, ignoreFailure: true },
  );
  return result.code === 0;
}

async function pushWithRetries(
  commandRunner: CommandRunner,
  cwd: string,
  sleep: (ms: number) => Promise<void>,
): Promise<WorkspaceApplyResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const push = await commandRunner.run('git', ['push'], { cwd, ignoreFailure: true });
    if (push.code === 0) {
      return { ok: true, pushed: true };
    }
    const pull = await commandRunner.run('git', ['pull', '--rebase', '--autostash'], { cwd, ignoreFailure: true });
    if (pull.code !== 0) {
      return { ok: false, reason: `git pull --rebase failed: ${summarizeGitFailure(pull.stdout, pull.stderr)}` };
    }
    await sleep((attempt + 1) * 2000);
  }

  return {
    ok: false,
    reason: 'git push failed after retries; local commit preserved for inspection',
    pendingPush: true,
  };
}

export async function gitCommitAndPush(
  commandRunner: CommandRunner,
  config: BacklogRunnerConfig,
  cwd: string,
  message: string,
  scopePaths: string[],
  options: WorkspaceCommitOptions = {},
): Promise<WorkspaceApplyResult> {
  return withLock(lockPath(config, 'git'), 30, async () => {
    const sleep = options.sleep ?? defaultSleep;
    const scopeMode = options.scopeMode ?? 'only';
    const changedFiles = await collectChangedFiles(commandRunner, cwd);
    if (changedFiles.length === 0) {
      if (!options.retryPendingPush || !await hasUpstream(commandRunner, cwd)) {
        return { ok: true };
      }
      return pushWithRetries(commandRunner, cwd, sleep);
    }

    const stagedBefore = await collectStagedFiles(commandRunner, cwd);
    const excludedStagedBefore = excludedCommitFiles(stagedBefore, scopeMode === 'all-except' ? scopePaths : []);
    if (excludedStagedBefore.length > 0) {
      return { ok: false, reason: `refusing to commit excluded staged files: ${excludedStagedBefore.slice(0, 8).join(', ')}` };
    }

    const commitCandidates = scopeMode === 'all-except'
      ? changedFiles.filter(file => !excludedCommitFiles([file], scopePaths).length)
      : changedFiles.filter(file => pathMatchesPrefix(normalizePathForGit(file), scopePaths));
    if (commitCandidates.length > 0) {
      await commandRunner.run('git', ['add', '-A', '--', ...commitCandidates], { cwd });
    }

    const stagedAfter = await collectStagedFiles(commandRunner, cwd);
    const excludedStagedAfter = excludedCommitFiles(stagedAfter, scopeMode === 'all-except' ? scopePaths : []);
    if (excludedStagedAfter.length > 0) {
      return { ok: false, reason: `refusing to commit excluded staged files: ${excludedStagedAfter.slice(0, 8).join(', ')}` };
    }

    const stagedCommitCandidates = scopeMode === 'all-except'
      ? stagedAfter.filter(file => !excludedCommitFiles([file], scopePaths).length)
      : stagedAfter.filter(file => pathMatchesPrefix(normalizePathForGit(file), scopePaths));
    if (stagedCommitCandidates.length === 0) {
      return { ok: true };
    }

    const commit = await commandRunner.run('git', ['commit', '-m', message], { cwd, ignoreFailure: true });
    if (commit.code !== 0) {
      return { ok: false, reason: `git commit failed: ${summarizeGitFailure(commit.stdout, commit.stderr)}` };
    }

    if (!await hasUpstream(commandRunner, cwd)) {
      return { ok: true, createdCommit: true };
    }

    const pushResult = await pushWithRetries(commandRunner, cwd, sleep);
    if (pushResult.ok) {
      return { ok: true, createdCommit: true, pushed: true };
    }

    return {
      ...pushResult,
      createdCommit: true,
      pendingPush: true,
    };
  });
}

class InPlaceSession implements WorkspaceSession {
  constructor(readonly cwd: string) {}

  async teardown(): Promise<void> {
    // nothing to do
  }

  async merge(): Promise<WorkspaceApplyResult> {
    return { ok: true };
  }
}

export class InPlaceWorkspaceStrategy implements WorkspaceStrategy {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly config: BacklogRunnerConfig,
  ) {}

  async setup(): Promise<WorkspaceSession> {
    return new InPlaceSession(this.config.projectRoot);
  }

  async commitAndPush(
    message: string,
    allowedPaths: string[],
    options: WorkspaceCommitOptions = {},
  ): Promise<WorkspaceApplyResult> {
    return gitCommitAndPush(this.commandRunner, this.config, this.config.projectRoot, message, allowedPaths, options);
  }
}
