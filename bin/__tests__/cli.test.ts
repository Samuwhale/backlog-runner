import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { normalizeBacklogRunnerConfig } from '../../src/config.js';
import { LiveOrchestratorError } from '../../src/scheduler/index.js';
import type { BacklogRunnerConfig, RunOverrides } from '../../src/types.js';
import type { BacklogRunnerStatus } from '../../src/status.js';

class BufferWriter {
  output = '';

  write(chunk: string): void {
    this.output += chunk;
  }
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'backlog-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(root: string): BacklogRunnerConfig {
  return normalizeBacklogRunnerConfig(
    {
      files: {
        backlog: './backlog.md',
        candidateQueue: './backlog/inbox.jsonl',
        stop: './backlog-stop',
        runtimeReport: './.backlog-runner/runtime-report.md',
        patterns: './scripts/backlog/patterns.md',
        progress: './scripts/backlog/progress.txt',
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
      defaults: {
        workers: 2,
        passes: true,
        worktrees: true,
      },
    },
    path.join(root, 'backlog.config.mjs'),
  );
}

function makeStatus(overrides: Partial<BacklogRunnerStatus> = {}): BacklogRunnerStatus {
  return {
    counts: {
      ready: 2,
      blocked: 1,
      planned: 3,
      inProgress: 1,
      failed: 0,
      done: 4,
    },
    orchestrator: null,
    files: {
      backlog: '/tmp/backlog.md',
      runtimeReport: '/tmp/runtime-report.md',
      candidateQueue: '/tmp/inbox.jsonl',
      candidateRejectLog: '/tmp/candidate-rejections.jsonl',
    },
    sections: {
      activeLeases: ['- Task A (task-a)'],
      activeReservations: ['- Task A (task-a) — touch_paths: packages/core/src/a.ts; capabilities: (none)'],
      activeTaskProgress: ['- Task A (task-a) — transcript: /tmp/task-a.jsonl', '  - Inspecting repo state.'],
      plannerCandidates: ['- task-b: planned'],
      otherBlockages: ['- task-c: waiting on dependency'],
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('cli', () => {
  it('prints top-level help with exit code 0', async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(['--help'], { stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('Usage: backlog-runner <command> [options]');
    expect(stdout.output).toContain('start');
    expect(stdout.output).toContain('doctor');
    expect(stderr.output).toBe('');
  });

  it('prints command-specific help with exit code 0', async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(['start', '--help'], { stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('backlog-runner start');
    expect(stdout.output).toContain('--no-worktrees');
    expect(stderr.output).toBe('');
  });

  it('auto-discovers backlog.config.mjs from the current working directory', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const config = makeConfig(root);
    const loadConfig = vi.fn(async () => config);
    const syncBacklogRunner = vi.fn(async () => ({
      candidates: { drained: false, createdTasks: 0, skippedDuplicates: 0, ignoredInvalidLines: 0, loggedRejects: 0 },
      counts: { ready: 0, blocked: 0, planned: 0, inProgress: 0, failed: 0, done: 0 },
    }));

    const exitCode = await runCli(
      ['sync'],
      { stdout: new BufferWriter(), stderr: new BufferWriter() },
      { cwd: () => root, loadConfig, syncBacklogRunner },
    );

    expect(exitCode).toBe(0);
    expect(loadConfig).toHaveBeenCalledWith(path.join(root, 'backlog.config.mjs'));
  });

  it('fails with a clear message when config auto-discovery misses', async () => {
    const root = await makeTempDir();
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(['sync'], { stdout, stderr }, { cwd: () => root });

    expect(exitCode).toBe(1);
    expect(stderr.output).toContain('No backlog config found.');
    expect(stderr.output).toContain('--config <path>');
  });

  it('rejects options that do not belong to the selected command', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(['sync', '--workers', '2'], { stdout, stderr }, { cwd: () => root });

    expect(exitCode).toBe(1);
    expect(stderr.output).toContain("Unknown option --workers for 'sync'");
    expect(stderr.output).toContain('sync --help');
  });

  it('renders idle status output', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const config = makeConfig(root);
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(
      ['status'],
      { stdout, stderr },
      {
        cwd: () => root,
        loadConfig: async () => config,
        readBacklogRunnerStatus: async () => makeStatus(),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('Backlog Runner Status');
    expect(stdout.output).toContain('Queue: 2 ready · 1 blocked · 3 planned · 1 in-progress · 0 failed · 4 done');
    expect(stdout.output).toContain('Orchestrator: idle');
    expect(stdout.output).toContain('Backlog report: /tmp/backlog.md');
    expect(stderr.output).toBe('');
  });

  it('renders active status output with verbose runtime sections', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const config = makeConfig(root);
    const stdout = new BufferWriter();

    const exitCode = await runCli(
      ['status', '--verbose'],
      { stdout, stderr: new BufferWriter() },
      {
        cwd: () => root,
        loadConfig: async () => config,
        readBacklogRunnerStatus: async () => makeStatus({
          orchestrator: {
            orchestratorId: 'orch-1',
            pid: 12345,
            requestedWorkers: 3,
            effectiveWorkers: 2,
            activeTaskWorkers: [{ taskId: 'task-a', title: 'Task A' }],
            activeControlWorker: { kind: 'planner' },
            shutdownRequested: false,
            pollIntervalMs: 15000,
            updatedAt: new Date().toISOString(),
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('Orchestrator: running (orch-1)');
    expect(stdout.output).toContain('Workers: 3 requested · 2 effective');
    expect(stdout.output).toContain('Active task workers: Task A (task-a)');
    expect(stdout.output).toContain('Active control worker: planner');
    expect(stdout.output).toContain('Active leases');
    expect(stdout.output).toContain('Active task progress');
    expect(stdout.output).toContain('Inspecting repo state.');
    expect(stdout.output).toContain('Planner candidates awaiting refinement');
  });

  it('accepts pnpm argument separators before command options', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const config = makeConfig(root);
    const stdout = new BufferWriter();

    const exitCode = await runCli(
      ['status', '--', '--verbose'],
      { stdout, stderr: new BufferWriter() },
      {
        cwd: () => root,
        loadConfig: async () => config,
        readBacklogRunnerStatus: async () => makeStatus(),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('Backlog Runner Status');
  });

  it('retries start with takeover after confirming a live orchestrator prompt', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'backlog.config.mjs'), 'export default {};', 'utf8');
    const config = makeConfig(root);
    const liveStatus = {
      orchestratorId: 'orch-live',
      pid: 4242,
      requestedWorkers: 2,
      effectiveWorkers: 2,
      activeTaskWorkers: [{ taskId: 'task-a', title: 'Task A' }],
      shutdownRequested: false,
      pollIntervalMs: 3000,
      updatedAt: new Date().toISOString(),
    } satisfies NonNullable<BacklogRunnerStatus['orchestrator']>;
    const runBacklogRunner = vi.fn(async (_config: BacklogRunnerConfig, _overrides: RunOverrides) => undefined);
    runBacklogRunner.mockRejectedValueOnce(new LiveOrchestratorError(config, liveStatus));
    runBacklogRunner.mockResolvedValueOnce(undefined);

    const exitCode = await runCli(
      ['start'],
      { stdout: new BufferWriter(), stderr: new BufferWriter() },
      {
        cwd: () => root,
        isInteractive: () => true,
        loadConfig: async () => config,
        confirmLiveOrchestratorTakeover: async () => true,
        runBacklogRunner,
      },
    );

    expect(exitCode).toBe(0);
    expect(runBacklogRunner).toHaveBeenCalledTimes(2);
    expect(runBacklogRunner.mock.calls[1]![1]).toMatchObject({ takeover: true });
  });

  it('suggests the new command names for removed legacy commands', async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();

    const exitCode = await runCli(['run'], { stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.output).toContain("Unknown command 'run'. Did you mean 'start'?");
  });
});
