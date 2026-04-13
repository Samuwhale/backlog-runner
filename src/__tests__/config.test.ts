import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig, resolveRunOptions } from '../config.js';

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'backlog-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }))));
});

describe('config', () => {
  it('normalizes relative paths against the config file location', async () => {
    const root = await makeTempDir();
    const config = normalizeBacklogRunnerConfig(
      {
        projectRoot: '.',
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
      },
      path.join(root, 'backlog.config.mjs'),
    );

    expect(config.projectRoot).toBe(root);
    expect(config.files.progress).toBe(path.join(root, 'scripts/backlog/progress.txt'));
    expect(config.files.candidateQueue).toBe(path.join(root, 'backlog', 'inbox.jsonl'));
    expect(config.files.taskSpecsDir).toBe(path.join(root, 'backlog', 'tasks'));
    expect(config.files.runtimeReport).toBe(path.join(root, '.backlog-runner', 'runtime-report.md'));
    expect(config.files.stateDb).toBe(path.join(root, '.backlog-runner', 'state.sqlite'));
    expect(config.prompts.agent).toBe(path.join(root, 'scripts/backlog/agent.md'));
    expect(config.prompts.planner).toBe(path.join(root, 'scripts/backlog/planner.md'));
    expect(config.defaults.workers).toBe(1);
    expect(config.runners.taskUi).toEqual({ tool: 'claude', model: 'opus' });
    expect(config.runners.taskCode).toEqual({ tool: 'codex', model: 'default' });
    expect(config.validationProfiles.repo).toBe('bash scripts/backlog/validate.sh');
  });

  it('resolves per-runner models from models.json and applies global CLI overrides', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'scripts/backlog'), { recursive: true });
    await writeFile(
      path.join(root, 'scripts/backlog/models.json'),
      JSON.stringify({
        aliases: {
          default: { codex: 'gpt-5.4' },
          claudeDefault: { claude: 'claude-opus-4-6' },
          sonnet: { codex: 'gpt-5.5' },
        },
      }),
      'utf8',
    );

    const config = normalizeBacklogRunnerConfig(
      {
        files: {
          backlog: './backlog.md',
          candidateQueue: './backlog/inbox.jsonl',
          stop: './backlog-stop',
          runtimeReport: './.backlog-runner/runtime-report.md',
          patterns: './scripts/backlog/patterns.md',
          progress: './scripts/backlog/progress.txt',
          models: './scripts/backlog/models.json',
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
          planner: { tool: 'codex', model: 'sonnet' },
          product: { tool: 'claude', model: 'claudeDefault' },
          interface: { tool: 'claude', model: 'claudeDefault' },
          ux: { tool: 'codex', model: 'default' },
          code: { tool: 'codex', model: 'default' },
        },
        defaults: {
          workers: 4,
          passes: true,
          worktrees: true,
        },
      },
      path.join(root, 'backlog.config.mjs'),
    );

    const options = await resolveRunOptions(config, {
      workers: 2,
      model: 'sonnet',
      tool: 'codex',
      worktrees: false,
    });

    expect(options.workers).toBe(2);
    expect(options.runners.taskUi).toEqual({ tool: 'codex', model: 'gpt-5.5' });
    expect(options.runners.taskCode).toEqual({ tool: 'codex', model: 'gpt-5.5' });
    expect(options.runners.planner).toEqual({ tool: 'codex', model: 'gpt-5.5' });
    expect(options.runners.product).toEqual({ tool: 'codex', model: 'gpt-5.5' });
    expect(options.worktrees).toBe(false);
  });

  it('resolves per-runner aliases without global overrides', async () => {
    const root = await makeTempDir();
    const config = normalizeBacklogRunnerConfig(
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
          planner: { tool: 'claude', model: 'default' },
          product: { tool: 'codex', model: 'sonnet' },
          interface: { tool: 'claude', model: 'sonnet' },
          ux: { tool: 'claude', model: 'opus' },
          code: { tool: 'codex', model: 'default' },
        },
        defaults: {
          workers: 3,
          passes: true,
          worktrees: true,
        },
      },
      path.join(root, 'backlog.config.mjs'),
    );

    const options = await resolveRunOptions(config);

    expect(options.workers).toBe(3);
    expect(options.runners.taskUi).toEqual({ tool: 'claude', model: 'claude-opus-4-6' });
    expect(options.runners.taskCode).toEqual({ tool: 'codex', model: 'gpt-5.4' });
    expect(options.runners.planner).toEqual({ tool: 'claude', model: 'claude-opus-4-6' });
    expect(options.runners.product).toEqual({ tool: 'codex', model: 'gpt-5.4' });
    expect(options.runners.interface).toEqual({ tool: 'claude', model: 'claude-sonnet-4-6' });
    expect(options.runners.ux).toEqual({ tool: 'claude', model: 'claude-opus-4-6' });
  });

  it('applies per-role overrides ahead of global overrides', async () => {
    const root = await makeTempDir();
    const config = normalizeBacklogRunnerConfig(
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
          planner: { tool: 'claude', model: 'opus' },
          product: { tool: 'codex', model: 'default' },
          interface: { tool: 'claude', model: 'sonnet' },
          ux: { tool: 'claude', model: 'sonnet' },
          code: { tool: 'codex', model: 'default' },
        },
      },
      path.join(root, 'backlog.config.mjs'),
    );

    const options = await resolveRunOptions(config, {
      tool: 'codex',
      model: 'default',
      runners: {
        planner: { tool: 'claude', model: 'opus' },
        taskUi: { tool: 'codex', model: 'gpt-5.4-mini' },
      },
    });

    expect(options.runners.taskUi).toEqual({ tool: 'codex', model: 'gpt-5.4-mini' });
    expect(options.runners.taskCode).toEqual({ tool: 'codex', model: 'gpt-5.4' });
    expect(options.runners.planner).toEqual({ tool: 'claude', model: 'claude-opus-4-6' });
    expect(options.runners.product).toEqual({ tool: 'codex', model: 'gpt-5.4' });
    expect(options.runners.interface).toEqual({ tool: 'codex', model: 'gpt-5.4' });
    expect(options.runners.ux).toEqual({ tool: 'codex', model: 'gpt-5.4' });
  });
});
