import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../config.js';
import { createCommandRunner } from '../process.js';
import type { CommandResult, CommandRunner } from '../types.js';
import { GitWorktreeWorkspaceStrategy } from '../workspace/git-worktree.js';
import { gitCommitAndPush } from '../workspace/in-place.js';
import { SHARED_DEPENDENCY_BOOTSTRAP_MARKER } from '../workspace/shared-install.js';

const tempDirs: string[] = [];

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'backlog-worktree-test-'));
  tempDirs.push(root);
  await mkdir(path.join(root, 'scripts/backlog'), { recursive: true });
  await mkdir(path.join(root, 'backlog'), { recursive: true });
  await mkdir(path.join(root, 'packages/core/src'), { recursive: true });
  await mkdir(path.join(root, 'packages/core/node_modules/.bin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'workspace-test',
    private: true,
    devDependencies: {},
  }, null, 2), 'utf8');
  await writeFile(path.join(root, 'backlog.md'), '- [ ] item\n', 'utf8');
  await writeFile(path.join(root, 'backlog/inbox.jsonl'), '', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/patterns.md'), '# Patterns\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/progress.txt'), '# Backlog Progress Log\nStarted: today\n---\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/archive.md'), '# Backlog Archive\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/agent.md'), 'agent', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/planner.md'), 'planner', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/product.md'), 'product', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/ux.md'), 'ux', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/code.md'), 'code', 'utf8');
  await writeFile(path.join(root, 'packages/core/package.json'), JSON.stringify({
    name: '@workspace-test/core',
    private: true,
    type: 'module',
    devDependencies: {},
  }, null, 2), 'utf8');
  await writeFile(path.join(root, 'packages/core/src/index.ts'), 'export const example = true;\n', 'utf8');
  await writeFile(path.join(root, 'feature.txt'), 'before\n', 'utf8');

  const runner = createCommandRunner();
  await runner.run('git', ['init'], { cwd: root });
  await runner.run('git', ['config', 'user.email', 'backlog@test.local'], { cwd: root });
  await runner.run('git', ['config', 'user.name', 'Backlog Runner'], { cwd: root });
  await runner.run('git', ['add', '-A'], { cwd: root });
  await runner.run('git', ['commit', '-m', 'initial'], { cwd: root });

  const config = normalizeBacklogRunnerConfig(
    {
      files: {
        backlog: './backlog.md',
        candidateQueue: './backlog/inbox.jsonl',
        stop: './backlog-stop',
        patterns: './scripts/backlog/patterns.md',
        progress: './scripts/backlog/progress.txt',
        runnerLogDir: './scripts/backlog',
        runtimeDir: './.backlog-runner',
      },
      prompts: {
        agent: './scripts/backlog/agent.md',
        planner: './scripts/backlog/planner.md',
        product: './scripts/backlog/product.md',
        interface: './scripts/backlog/interface.md',
        ux: './scripts/backlog/ux.md',
        code: './scripts/backlog/code.md',
      },
      validationCommand: 'bash scripts/backlog/validate.sh',
      runners: {
        taskUi: { tool: 'claude', model: 'opus' },
        taskCode: { tool: 'codex', model: 'default' },
        planner: { tool: 'codex', model: 'default' },
        product: { tool: 'codex', model: 'default' },
        interface: { tool: 'claude', model: 'sonnet' },
        ux: { tool: 'codex', model: 'default' },
        code: { tool: 'codex', model: 'default' },
      },
    },
    path.join(root, 'backlog.config.mjs'),
  );

  return { root, config, runner };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('git worktree strategy', () => {
  it('merges worktree changes back to the main repo', async () => {
    const { root, config, runner } = await makeRepo();
    const strategy = new GitWorktreeWorkspaceStrategy(runner, config);
    const session = await strategy.setup();

    const rootNodeModules = path.join(session.cwd, 'node_modules');
    const packageNodeModules = path.join(session.cwd, 'packages/core/node_modules');
    const markerPath = path.join(session.cwd, SHARED_DEPENDENCY_BOOTSTRAP_MARKER);
    expect((await lstat(rootNodeModules)).isSymbolicLink()).toBe(true);
    expect((await lstat(packageNodeModules)).isSymbolicLink()).toBe(true);
    expect((await lstat(markerPath)).isFile()).toBe(true);

    await writeFile(path.join(session.cwd, 'feature.txt'), 'after\n', 'utf8');
    await writeFile(
      path.join(session.cwd, 'scripts/backlog/progress.txt'),
      '# Backlog Progress Log\nStarted: today\n---\n## entry\nbody\n---\n',
      'utf8',
    );

    const merge = await session.merge();
    await session.teardown();
    const status = await runner.run('git', ['status', '--porcelain'], { cwd: root });

    expect(merge.ok).toBe(true);
    expect(await readFile(path.join(root, 'feature.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(path.join(root, 'scripts/backlog/progress.txt'), 'utf8')).toContain('## entry');
    expect(status.stdout).not.toContain('node_modules');
    await expect(lstat(markerPath)).rejects.toThrow();
  }, 15000);

  it('fails cleanly on merge conflicts without overwriting main repo changes', async () => {
    const { root, config, runner } = await makeRepo();
    const strategy = new GitWorktreeWorkspaceStrategy(runner, config);
    const session = await strategy.setup();

    await writeFile(path.join(session.cwd, 'feature.txt'), 'worktree change\n', 'utf8');
    await writeFile(path.join(root, 'feature.txt'), 'main change\n', 'utf8');
    await runner.run('git', ['add', 'feature.txt'], { cwd: root });
    await runner.run('git', ['commit', '-m', 'main repo change'], { cwd: root });

    const merge = await session.merge();
    await session.teardown();

    expect(merge.ok).toBe(false);
    expect(merge.reason).toBe('Cherry-pick conflict');
    expect(await readFile(path.join(root, 'feature.txt'), 'utf8')).toBe('main change\n');
  }, 15000);

  it('warns but does not throw when a declared dependency is missing from the bootstrapped worktree', async () => {
    const { root, config, runner } = await makeRepo();
    await writeFile(path.join(root, 'packages/core/package.json'), JSON.stringify({
      name: '@workspace-test/core',
      private: true,
      type: 'module',
      dependencies: {
        'missing-dependency': '^1.0.0',
      },
    }, null, 2), 'utf8');
    await runner.run('git', ['add', 'packages/core/package.json'], { cwd: root });
    await runner.run('git', ['commit', '-m', 'declare missing dependency'], { cwd: root });

    const strategy = new GitWorktreeWorkspaceStrategy(runner, config);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const session = await strategy.setup();
    await session.teardown();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('packages/core:missing-dependency'),
    );
    warnSpy.mockRestore();
  });

  it('fails setup when a shared install symlink resolves into a temp backlog worktree', async () => {
    const { root, config, runner } = await makeRepo();
    const poisonedRoot = await mkdtemp(path.join(tmpdir(), 'backlog-poison-test-'));
    tempDirs.push(poisonedRoot);
    await mkdir(path.join(poisonedRoot, 'node_modules/.pnpm/fake@1.0.0/node_modules'), { recursive: true });
    await symlink(
      path.join(poisonedRoot, 'node_modules/.pnpm/fake@1.0.0/node_modules'),
      path.join(root, 'packages/core/node_modules/fake'),
      'dir',
    );

    const strategy = new GitWorktreeWorkspaceStrategy(runner, config);

    await expect(strategy.setup()).rejects.toThrow(/BACKLOG_STALE_SHARED_INSTALL_STATE/);
  });

  it('does not push on a clean tree unless the runner explicitly retries a pending push', async () => {
    const { root, config } = await makeRepo();
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push(`run:${command} ${args.join(' ')}`.trim());
        if (command === 'git' && args[0] === 'status') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'remote') {
          return { code: 0, stdout: 'origin', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async runShell(): Promise<CommandResult> {
        return { code: 0, stdout: '', stderr: '' };
      },
      async which(): Promise<string | null> {
        return '/usr/bin/mock';
      },
    };

    const result = await gitCommitAndPush(runner, config, root, 'chore(backlog): done – test item', ['feature.txt']);

    expect(result.ok).toBe(true);
    expect(calls).not.toContain('run:git push');
  });

  it('retries push failures without waiting on real timers and succeeds when the remote recovers', async () => {
    const { root, config } = await makeRepo();
    const calls: string[] = [];
    const sleeps: number[] = [];
    let pushFailuresRemaining = 2;
    const runner: CommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push(`run:${command} ${args.join(' ')}`.trim());
        if (command === 'git' && args[0] === 'status') {
          return { code: 0, stdout: ' M feature.txt', stderr: '' };
        }
        if (command === 'git' && args[0] === 'diff' && args[1] === '--cached') {
          return { code: 0, stdout: args.includes('--name-only') ? 'feature.txt' : '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'remote') {
          return { code: 0, stdout: 'origin', stderr: '' };
        }
        if (command === 'git' && args[0] === 'push') {
          if (pushFailuresRemaining > 0) {
            pushFailuresRemaining -= 1;
            return { code: 1, stdout: '', stderr: 'push failed' };
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'pull') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async runShell(): Promise<CommandResult> {
        return { code: 0, stdout: '', stderr: '' };
      },
      async which(): Promise<string | null> {
        return '/usr/bin/mock';
      },
    };

    const result = await gitCommitAndPush(
      runner,
      config,
      root,
      'chore(backlog): done – test item',
      ['feature.txt'],
      { sleep: async ms => { sleeps.push(ms); } },
    );

    expect(result).toMatchObject({ ok: true, createdCommit: true, pushed: true });
    expect(calls.filter(call => call === 'run:git push')).toHaveLength(3);
    expect(calls.filter(call => call === 'run:git pull --rebase --autostash')).toHaveLength(2);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('returns a pending-push failure after exhausting push retries', async () => {
    const { root, config } = await makeRepo();
    const sleeps: number[] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        if (command === 'git' && args[0] === 'status') {
          return { code: 0, stdout: ' M feature.txt', stderr: '' };
        }
        if (command === 'git' && args[0] === 'diff' && args[1] === '--cached') {
          return { code: 0, stdout: args.includes('--name-only') ? 'feature.txt' : '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'remote') {
          return { code: 0, stdout: 'origin', stderr: '' };
        }
        if (command === 'git' && args[0] === 'push') {
          return { code: 1, stdout: '', stderr: 'push failed' };
        }
        if (command === 'git' && args[0] === 'pull') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async runShell(): Promise<CommandResult> {
        return { code: 0, stdout: '', stderr: '' };
      },
      async which(): Promise<string | null> {
        return '/usr/bin/mock';
      },
    };

    const result = await gitCommitAndPush(
      runner,
      config,
      root,
      'chore(backlog): done – test item',
      ['feature.txt'],
      { sleep: async ms => { sleeps.push(ms); } },
    );

    expect(result).toMatchObject({
      ok: false,
      createdCommit: true,
      pendingPush: true,
      reason: 'git push failed after retries; local commit preserved for inspection',
    });
    expect(sleeps).toEqual([2000, 4000, 6000]);
  });

  it('can commit the full tracked diff while excluding backlog runtime noise', async () => {
    const { root, config, runner } = await makeRepo();
    await mkdir(path.join(root, '.backlog-runner'), { recursive: true });

    await writeFile(path.join(root, 'feature.txt'), 'after\n', 'utf8');
    await writeFile(path.join(root, 'packages/core/src/renamed.ts'), 'export const renamed = true;\n', 'utf8');
    await rm(path.join(root, 'packages/core/src/index.ts'));
    await writeFile(path.join(root, '.backlog-runner/runtime-report.md'), 'runtime noise\n', 'utf8');

    const result = await gitCommitAndPush(
      runner,
      config,
      root,
      'chore(backlog): done – full diff',
      ['.backlog-runner', 'backlog-stop'],
      { scopeMode: 'all-except' },
    );

    const committed = await runner.run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root });
    const status = await runner.run('git', ['status', '--porcelain'], { cwd: root });

    expect(result).toMatchObject({ ok: true, createdCommit: true });
    expect(committed.stdout).toContain('feature.txt');
    expect(committed.stdout).toContain('packages/core/src/index.ts');
    expect(committed.stdout).toContain('packages/core/src/renamed.ts');
    expect(committed.stdout).not.toContain('.backlog-runner/runtime-report.md');
    expect(status.stdout).toContain('.backlog-runner/');
  });
});
