import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockPath, withLock } from '../locks.js';
import { gitCommitAndPush, hasUpstream } from './in-place.js';
import type {
  BacklogRunnerConfig,
  CommandRunner,
  WorkspaceApplyResult,
  WorkspaceCommitOptions,
  WorkspaceSession,
  WorkspaceStrategy,
} from '../types.js';
import {
  SHARED_DEPENDENCY_BOOTSTRAP_MARKER,
  formatStaleSharedInstallState,
  inspectSharedInstallState,
  type SharedDependencyBootstrapMarker,
} from './shared-install.js';

async function lineCount(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf8');
    const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return normalized ? normalized.split('\n').length : 0;
  } catch {
    return 0;
  }
}

async function readAppendedLines(filePath: string, baseline: number): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf8');
    const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lines = normalized ? normalized.split('\n') : [];
    return lines.slice(baseline).join('\n').trim();
  } catch {
    return '';
  }
}

async function appendIfPresent(target: string, content: string): Promise<void> {
  if (!content) return;
  await writeFile(target, `${(await readFile(target, 'utf8').catch(() => ''))}${content}\n`, 'utf8');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function externalDependencyNames(manifest: PackageManifest | null): string[] {
  if (!manifest) {
    return [];
  }

  const names = new Set<string>();
  for (const field of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(field ?? {})) {
      if (!version || version.startsWith('workspace:') || version.startsWith('file:') || version.startsWith('link:')) {
        continue;
      }
      names.add(name);
    }
  }

  return [...names];
}

async function readPackageManifest(packageDir: string): Promise<PackageManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

async function ensureDirectorySymlink(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, 'dir');
}

async function verifyManifestDependencies(worktreePackageDir: string, label: string): Promise<string[]> {
  const manifest = await readPackageManifest(worktreePackageDir);
  if (!manifest) {
    return [];
  }

  const missing: string[] = [];
  for (const dependencyName of externalDependencyNames(manifest)) {
    if (!(await pathExists(path.join(worktreePackageDir, 'node_modules', dependencyName)))) {
      missing.push(`${label}:${dependencyName}`);
    }
  }
  return missing;
}

async function writeSharedDependencyBootstrapMarker(
  worktreeDir: string,
  marker: SharedDependencyBootstrapMarker,
): Promise<void> {
  await writeFile(
    path.join(worktreeDir, SHARED_DEPENDENCY_BOOTSTRAP_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
}

async function removeSharedDependencyBootstrapMarker(worktreeDir: string): Promise<void> {
  await rm(path.join(worktreeDir, SHARED_DEPENDENCY_BOOTSTRAP_MARKER), { force: true });
}

async function bootstrapWorkspaceNodeModules(projectRoot: string, worktreeDir: string): Promise<SharedDependencyBootstrapMarker> {
  const missingSources: string[] = [];
  const requiredNodeModules: string[] = [];
  const rootNodeModules = path.join(projectRoot, 'node_modules');
  if (!(await pathExists(rootNodeModules))) {
    missingSources.push('root:node_modules');
  } else {
    await ensureDirectorySymlink(rootNodeModules, path.join(worktreeDir, 'node_modules'));
    requiredNodeModules.push('node_modules');
  }

  const packagesDir = path.join(projectRoot, 'packages');
  let packageNames: string[] = [];
  try {
    packageNames = await readdir(packagesDir);
  } catch {
    packageNames = [];
  }

  for (const packageName of packageNames) {
    const sourceNodeModules = path.join(packagesDir, packageName, 'node_modules');
    if (!(await pathExists(sourceNodeModules))) {
      const manifest = await readPackageManifest(path.join(packagesDir, packageName));
      if (externalDependencyNames(manifest).length > 0) {
        missingSources.push(`packages/${packageName}:node_modules`);
      }
      continue;
    }

    const targetNodeModules = path.join(worktreeDir, 'packages', packageName, 'node_modules');
    await ensureDirectorySymlink(sourceNodeModules, targetNodeModules);
    requiredNodeModules.push(path.posix.join('packages', packageName, 'node_modules'));
  }

  if (missingSources.length > 0) {
    throw new Error(`worktree dependency bootstrap missing source installs: ${missingSources.join(', ')}`);
  }

  const missingDependencies = [
    ...(await verifyManifestDependencies(worktreeDir, 'root')),
  ];
  for (const packageName of packageNames) {
    missingDependencies.push(
      ...(await verifyManifestDependencies(path.join(worktreeDir, 'packages', packageName), `packages/${packageName}`)),
    );
  }

  if (missingDependencies.length > 0) {
    console.warn(`worktree dependency bootstrap: ${missingDependencies.length} dependencies not found at expected paths (may be pnpm-hoisted): ${missingDependencies.join(', ')}`);
  }

  return {
    kind: 'shared-dependency-bootstrap',
    projectRoot,
    requiredNodeModules,
  };
}

async function removeBootstrapWorkspaceNodeModules(worktreeDir: string): Promise<void> {
  await removeSharedDependencyBootstrapMarker(worktreeDir);
  await rm(path.join(worktreeDir, 'node_modules'), { recursive: true, force: true });

  const packagesDir = path.join(worktreeDir, 'packages');
  let packageNames: string[] = [];
  try {
    packageNames = await readdir(packagesDir);
  } catch {
    return;
  }

  await Promise.all(
    packageNames.map(async packageName => {
      await rm(path.join(packagesDir, packageName, 'node_modules'), { recursive: true, force: true });
    }),
  );
}

class GitWorktreeSession implements WorkspaceSession {
  constructor(
    readonly cwd: string,
    private readonly commandRunner: CommandRunner,
    private readonly config: BacklogRunnerConfig,
    private readonly worktreeBaseSha: string,
    private readonly progressBaseline: number,
    private readonly patternsBaseline: number,
  ) {}

  async merge(): Promise<WorkspaceApplyResult> {
    const worktreeProgress = path.join(this.cwd, path.relative(this.config.projectRoot, this.config.files.progress));
    const worktreePatterns = path.join(this.cwd, path.relative(this.config.projectRoot, this.config.files.patterns));
    const progressNew = await readAppendedLines(worktreeProgress, this.progressBaseline);
    const patternsNew = await readAppendedLines(worktreePatterns, this.patternsBaseline);

    await this.commandRunner.run('git', ['checkout', 'HEAD', '--', path.relative(this.cwd, worktreeProgress)], {
      cwd: this.cwd,
      ignoreFailure: true,
    });
    await this.commandRunner.run('git', ['checkout', 'HEAD', '--', path.relative(this.cwd, worktreePatterns)], {
      cwd: this.cwd,
      ignoreFailure: true,
    });

    await removeSharedDependencyBootstrapMarker(this.cwd);
    await removeBootstrapWorkspaceNodeModules(this.cwd);
    const status = await this.commandRunner.run('git', ['status', '--porcelain'], {
      cwd: this.cwd,
      ignoreFailure: true,
    });

    let commitSha = '';
    if (status.stdout.trim()) {
      await this.commandRunner.run('git', ['add', '-A'], { cwd: this.cwd });
      await this.commandRunner.run('git', ['commit', '-m', 'backlog agent work'], {
        cwd: this.cwd,
        ignoreFailure: true,
      });
      const rev = await this.commandRunner.run('git', ['rev-parse', 'HEAD'], { cwd: this.cwd });
      commitSha = rev.stdout.trim();
      if (commitSha === this.worktreeBaseSha) {
        commitSha = '';
      }
    }

    if (!commitSha && !progressNew && !patternsNew) {
      return { ok: true };
    }

    return withLock(lockPath(this.config, 'git'), 30, async () => {
      if (await hasUpstream(this.commandRunner, this.config.projectRoot)) {
        const pull = await this.commandRunner.run('git', ['pull', '--rebase', '--autostash'], {
          cwd: this.config.projectRoot,
          ignoreFailure: true,
        });
        if (pull.code !== 0) {
          return { ok: false, reason: 'git pull --rebase failed before applying worktree changes' };
        }
      }

      if (commitSha) {
        const mergePreview = await this.commandRunner.run(
          'git',
          ['merge-tree', '--write-tree', '--merge-base', this.worktreeBaseSha, 'HEAD', commitSha],
          { cwd: this.config.projectRoot, ignoreFailure: true },
        );
        if (mergePreview.code !== 0) {
          return { ok: false, reason: 'Cherry-pick conflict' };
        }

        const cherryPick = await this.commandRunner.run(
          'git',
          ['cherry-pick', '--no-commit', commitSha],
          { cwd: this.config.projectRoot, ignoreFailure: true },
        );
        if (cherryPick.code !== 0) {
          await this.commandRunner.run('git', ['cherry-pick', '--abort'], {
            cwd: this.config.projectRoot,
            ignoreFailure: true,
          });
          return { ok: false, reason: 'Cherry-pick conflict' };
        }
      }

      await appendIfPresent(this.config.files.progress, progressNew);
      await appendIfPresent(this.config.files.patterns, patternsNew);
      return { ok: true };
    });
  }

  async teardown(): Promise<void> {
    await withLock(lockPath(this.config, 'worktree'), 30, async () => {
      await removeBootstrapWorkspaceNodeModules(this.cwd);
      await this.commandRunner.run('git', ['worktree', 'remove', this.cwd, '--force'], {
        cwd: this.config.projectRoot,
        ignoreFailure: true,
      });
      await rm(this.cwd, { recursive: true, force: true });
      await this.commandRunner.run('git', ['worktree', 'prune'], {
        cwd: this.config.projectRoot,
        ignoreFailure: true,
      });
    });
  }
}

export class GitWorktreeWorkspaceStrategy implements WorkspaceStrategy {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly config: BacklogRunnerConfig,
  ) {}

  async setup(): Promise<WorkspaceSession> {
    const worktreeBaseSha = (await this.commandRunner.run('git', ['rev-parse', 'HEAD'], {
      cwd: this.config.projectRoot,
    })).stdout.trim();
    const worktreeDir = await mkdtemp(path.join(tmpdir(), `backlog-${process.pid}-`));
    await withLock(lockPath(this.config, 'worktree'), 30, async () => {
      try {
        await this.commandRunner.run('git', ['worktree', 'add', '--detach', worktreeDir, 'HEAD', '--quiet'], {
          cwd: this.config.projectRoot,
        });
        const marker = await bootstrapWorkspaceNodeModules(this.config.projectRoot, worktreeDir);
        await writeSharedDependencyBootstrapMarker(worktreeDir, marker);

        const inspection = await inspectSharedInstallState(worktreeDir, {
          requiredNodeModules: marker.requiredNodeModules,
        });
        if (inspection.staleSymlinks.length > 0) {
          throw new Error(formatStaleSharedInstallState(inspection, this.config.workspaceBootstrap));
        }
      } catch (error) {
        await removeBootstrapWorkspaceNodeModules(worktreeDir);
        await this.commandRunner.run('git', ['worktree', 'remove', worktreeDir, '--force'], {
          cwd: this.config.projectRoot,
          ignoreFailure: true,
        });
        await this.commandRunner.run('git', ['worktree', 'prune'], {
          cwd: this.config.projectRoot,
          ignoreFailure: true,
        });
        throw error;
      }
    });

    const progressRelative = path.relative(this.config.projectRoot, this.config.files.progress);
    const patternsRelative = path.relative(this.config.projectRoot, this.config.files.patterns);
    const progressBaseline = await lineCount(path.join(worktreeDir, progressRelative));
    const patternsBaseline = await lineCount(path.join(worktreeDir, patternsRelative));

    return new GitWorktreeSession(
      worktreeDir,
      this.commandRunner,
      this.config,
      worktreeBaseSha,
      progressBaseline,
      patternsBaseline,
    );
  }

  async commitAndPush(
    message: string,
    allowedPaths: string[],
    options: WorkspaceCommitOptions = {},
  ): Promise<WorkspaceApplyResult> {
    return gitCommitAndPush(this.commandRunner, this.config, this.config.projectRoot, message, allowedPaths, options);
  }
}
