import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../config.js';
import {
  validateBacklogRunner,
  validateBacklogState,
  validateCommandReadiness,
  validateGitReadiness,
  validatePromptContracts,
  validateSharedInstallReadiness,
} from '../validate.js';
import type { BacklogRunnerConfig, CommandResult, CommandRunOptions, CommandRunner } from '../types.js';

const tempDirs: string[] = [];

function createCommandRunner(overrides: {
  run?: (command: string, args: string[], options?: { input?: string }) => Promise<CommandResult>;
  runShell?: (command: string) => Promise<CommandResult>;
  which?: (command: string) => Promise<string | null>;
} = {}): CommandRunner {
  return {
    async run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandResult> {
      if (overrides.run) {
        return overrides.run(command, args, options);
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { code: 0, stdout: 'true', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async runShell(command: string): Promise<CommandResult> {
      if (overrides.runShell) {
        return overrides.runShell(command);
      }
      return { code: 0, stdout: '/usr/bin/mock\n', stderr: '' };
    },
    async which(command: string): Promise<string | null> {
      if (overrides.which) {
        return overrides.which(command);
      }
      return command === 'git' ? '/usr/bin/git' : '/usr/bin/mock';
    },
  };
}

async function makeFixture(options: {
  backlogContent?: string;
  taskFiles?: Record<string, string>;
  validationCommand?: string;
  candidateQueue?: boolean;
} = {}): Promise<BacklogRunnerConfig> {
  const root = await mkdtemp(path.join(tmpdir(), 'backlog-validate-test-'));
  tempDirs.push(root);

  await mkdir(path.join(root, 'scripts/backlog'), { recursive: true });
  await mkdir(path.join(root, 'backlog/tasks'), { recursive: true });
  await mkdir(path.join(root, 'backlog'), { recursive: true });
  await writeFile(path.join(root, 'backlog.md'), options.backlogContent ?? '# Backlog\n', 'utf8');
  if (options.candidateQueue !== false) {
    await writeFile(path.join(root, 'backlog/inbox.jsonl'), '', 'utf8');
  }
  await writeFile(path.join(root, 'backlog-stop'), '', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/patterns.md'), '# Patterns\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/progress.txt'), '# Progress\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/agent.md'), 'agent prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/planner.md'), 'planner prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/product.md'), 'product prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/interface.md'), 'interface prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/ux.md'), 'ux prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/code.md'), 'code prompt', 'utf8');

  for (const [name, content] of Object.entries(options.taskFiles ?? {})) {
    const filePath = path.join(root, 'backlog/tasks', name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  return normalizeBacklogRunnerConfig(
    {
      files: {
        backlog: './backlog.md',
        candidateQueue: './backlog/inbox.jsonl',
        taskSpecsDir: './backlog/tasks',
        stop: './backlog-stop',
        runtimeReport: './.backlog-runner/runtime-report.md',
        patterns: './scripts/backlog/patterns.md',
        progress: './scripts/backlog/progress.txt',
        stateDb: './.backlog-runner/state.sqlite',
        runnerLogDir: './.backlog-runner/logs',
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
      validationCommand: options.validationCommand ?? 'bash scripts/backlog/validate.sh',
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
        workers: 1,
        passes: false,
        worktrees: false,
      },
    },
    path.join(root, 'backlog.config.mjs'),
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('validate helpers', () => {
  it('flags a missing validation script', async () => {
    const config = await makeFixture();

    const result = await validateCommandReadiness(config, createCommandRunner());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('validation command');
  });

  it('flags a missing validation executable for non-script commands', async () => {
    const config = await makeFixture({ validationCommand: 'pnpm lint' });

    await expect(
      validateCommandReadiness(
        config,
        createCommandRunner({
          runShell: async () => ({ code: 1, stdout: '', stderr: '' }),
        }),
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('accepts task spec store when task specs exist', async () => {
    const config = await makeFixture({
      backlogContent: '# UX Improvement Backlog\n\n<!-- This file is generated by packages/backlog-runner from backlog/tasks/**/*.yaml. -->\n',
      taskFiles: {
        'task-a.yaml': 'id: task-a\ntitle: Task A\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: ready\nacceptance_criteria:\n  - Task A\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:00:00.000Z\n',
      },
    });

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(true);
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects legacy markdown backlog mode when task specs are empty', async () => {
    const config = await makeFixture({
      backlogContent: '# Backlog\n\n- [ ] Legacy task\n',
    });

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('legacy'))).toBe(true);
  });

  it('rejects stale backlog reports when task specs exist', async () => {
    const config = await makeFixture({
      backlogContent: '# Backlog\n',
      taskFiles: {
        'task-a.yaml': 'id: task-a\ntitle: Task A\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: ready\nacceptance_criteria:\n  - Task A\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:00:00.000Z\n',
      },
    });

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('backlog.md'))).toBe(true);
  });

  it('rejects legacy backlog-inbox.md files', async () => {
    const config = await makeFixture({
      backlogContent: '# UX Improvement Backlog\n\n<!-- This file is generated by packages/backlog-runner from backlog/tasks/**/*.yaml. -->\n',
      taskFiles: {
        'task-a.yaml': 'id: task-a\ntitle: Task A\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: ready\nacceptance_criteria:\n  - Task A\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:00:00.000Z\n',
      },
    });
    await writeFile(path.join(config.projectRoot, 'backlog-inbox.md'), '# legacy inbox\n', 'utf8');

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('backlog-inbox.md'))).toBe(true);
  });

  it('rejects duplicate task spec ids', async () => {
    const config = await makeFixture({
      backlogContent: '# UX Improvement Backlog\n\n<!-- This file is generated by packages/backlog-runner from backlog/tasks/**/*.yaml. -->\n',
      taskFiles: {
        'task-a.yaml': 'id: task-a\ntitle: Task A\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: ready\nacceptance_criteria:\n  - Task A\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:00:00.000Z\n',
        'done/task-a.yaml': 'id: task-a\ntitle: Task A archived\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: done\nacceptance_criteria:\n  - Task A archived\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:01:00.000Z\n',
      },
    });

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('duplicate'))).toBe(true);
  });

  it('flags a missing candidate queue file', async () => {
    const config = await makeFixture({ candidateQueue: false });

    const result = await validateBacklogState(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('candidate queue'))).toBe(true);
  });

  it('rejects planner prompts that still reference legacy markdown instructions', async () => {
    const config = await makeFixture();
    await writeFile(path.join(config.projectRoot, 'scripts/backlog/planner.md'), 'Use backlog-inbox.md. Every item MUST start with `- [ ] `', 'utf8');

    const result = await validatePromptContracts(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('planner') && m.includes('legacy'))).toBe(true);
  });

  it('rejects agent prompts that still require final validation before success', async () => {
    const config = await makeFixture();
    await writeFile(
      path.join(config.projectRoot, 'scripts/backlog/agent.md'),
      'Do NOT report success unless that injected validation command exits 0.',
      'utf8',
    );

    const result = await validatePromptContracts(config);
    expect(result.ok).toBe(false);
    expect(result.messages.some(m => m.includes('agent') && m.includes('validation'))).toBe(true);
  });

  it('checks git readiness without worktree add/remove when worktrees are disabled', async () => {
    const calls: string[] = [];
    const config = await makeFixture();

    const result = await validateGitReadiness(
      config,
      false,
      createCommandRunner({
        run: async (command, args) => {
          calls.push(`${command} ${args.join(' ')}`);
          if (command === 'git' && args[0] === 'rev-parse') {
            return { code: 0, stdout: 'true', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['git rev-parse --is-inside-work-tree']);
  });

  it('checks git worktree add/remove readiness when worktrees are enabled', async () => {
    const calls: string[] = [];
    const config = await makeFixture();

    const result = await validateGitReadiness(
      config,
      true,
      createCommandRunner({
        run: async (command, args) => {
          calls.push(`${command} ${args.join(' ')}`);
          if (command === 'git' && args[0] === 'rev-parse') {
            return { code: 0, stdout: 'true', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls.some(call => call.startsWith('git worktree add --detach '))).toBe(true);
    expect(calls.some(call => call.startsWith('git worktree remove '))).toBe(true);
    expect(calls).toContain('git worktree prune');
  });

  it('fails shared install readiness when package symlinks point into a temp backlog worktree', async () => {
    const config = await makeFixture();
    await mkdir(path.join(config.projectRoot, 'packages/server/node_modules'), { recursive: true });
    const poisonedRoot = await mkdtemp(path.join(tmpdir(), 'backlog-poisoned-install-'));
    tempDirs.push(poisonedRoot);
    await mkdir(path.join(poisonedRoot, 'node_modules/.pnpm/fastify@1.0.0/node_modules'), { recursive: true });
    await symlink(
      path.join(poisonedRoot, 'node_modules/.pnpm/fastify@1.0.0/node_modules'),
      path.join(config.projectRoot, 'packages/server/node_modules/fastify'),
      'dir',
    );

    const result = await validateSharedInstallReadiness(config);

    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain('BACKLOG_STALE_SHARED_INSTALL_STATE');
  });

  it('validates mixed runner configurations and applies planner smoke only to the planner runner', async () => {
    const config = await makeFixture({
      backlogContent: '# UX Improvement Backlog\n\n<!-- This file is generated by packages/backlog-runner from backlog/tasks/**/*.yaml. -->\n',
      taskFiles: {
        'task-a.yaml': 'id: task-a\ntitle: Task A\npriority: normal\ntask_kind: implementation\nexecution_domain: code_logic\ndepends_on: []\ntouch_paths:\n  - feature.txt\ncapabilities: []\nvalidation_profile: repo\nstatus_notes:\n  - Seeded\nstate: ready\nacceptance_criteria:\n  - Task A\nsource: manual\ncreated_at: 2026-04-08T00:00:00.000Z\nupdated_at: 2026-04-08T00:00:00.000Z\n',
      },
    });
    config.runners = {
      taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
      taskCode: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'claude', model: 'claude-sonnet-4-6' },
      product: { tool: 'codex', model: 'gpt-5.4' },
      interface: { tool: 'claude', model: 'claude-sonnet-4-6' },
      ux: { tool: 'claude', model: 'claude-sonnet-4-6' },
      code: { tool: 'codex', model: 'gpt-5.4' },
    };
    await writeFile(path.join(config.projectRoot, 'scripts/backlog/validate.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');

    const calls: string[] = [];
    const result = await validateBacklogRunner(
      config,
      {},
      {
        commandRunner: createCommandRunner({
          run: async (command, args, options) => {
            calls.push(`${command} ${args.join(' ')}`);
            if (command === 'git' && args[0] === 'rev-parse') {
              return { code: 0, stdout: 'true', stderr: '' };
            }
            if (command === 'codex' && args.includes('--version')) {
              return { code: 0, stdout: 'codex-cli 1.0.0', stderr: '' };
            }
            if (command === 'codex' && args[0] === 'exec') {
              const outputFile = args[args.indexOf('--output-last-message') + 1]!;
              await writeFile(outputFile, JSON.stringify({ status: 'done', item: 'smoke', note: 'ok' }), 'utf8');
              return { code: 0, stdout: '', stderr: '' };
            }
            if (command === 'claude' && args.includes('--version')) {
              return { code: 0, stdout: 'claude 1.0.0', stderr: '' };
            }
            if (command === 'claude' && args[0] === 'auth') {
              return { code: 0, stdout: 'Logged in', stderr: '' };
            }
            if (command === 'claude') {
              return {
                code: 0,
                stdout: JSON.stringify({
                  structured_output: {
                    status: 'done',
                    item: options?.input === 'Return exactly this JSON object and nothing else: {"status":"done","item":"smoke","note":"ok"}'
                      ? 'smoke'
                      : 'planner-smoke',
                    note: 'ok',
                  },
                }),
                stderr: '',
              };
            }
            return { code: 0, stdout: '', stderr: '' };
          },
          runShell: async command => {
            if (command === 'bash scripts/backlog/validate.sh') {
              return { code: 0, stdout: 'ok', stderr: '' };
            }
            return { code: 0, stdout: '/usr/bin/mock\n', stderr: '' };
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    // Verify it ran both codex and claude provider smoke tests
    expect(calls.filter(call => call.startsWith('codex exec'))).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('claude --dangerously-skip-permissions')).length).toBeGreaterThanOrEqual(2);
  });
});
