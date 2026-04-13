import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../config.js';
import { runBacklogRunner } from '../scheduler/index.js';
import { ORCHESTRATOR_POLL_INTERVAL_MS } from '../scheduler/constants.js';
import { createFileBackedTaskStore } from '../store/task-store.js';
import { writeTaskSpec } from '../task-specs.js';
import type { BacklogTaskSpec, CommandResult, CommandRunOptions, CommandRunner, LogSink } from '../types.js';

const tempDirs: string[] = [];

class MemoryLogSink implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  async close(): Promise<void> {
    // no-op
  }
}

function createFakeCommandRunner(
  root: string,
  options: {
    validationResponses?: boolean[];
    validationResults?: CommandResult[];
    changedFiles?: string[];
    statusResponses?: string[][];
    initialStagedFiles?: string[];
    clearStagedFilesOnRepair?: boolean;
    remoteName?: string;
    failPushCount?: number;
    calls?: string[];
    plannerOutput?: Record<string, unknown>;
    onGitCommit?: (message: string) => Promise<void> | void;
    onAgentInput?: (input: string | undefined) => Promise<void> | void;
  } = {},
): CommandRunner {
  const stagedFiles = new Set(options.initialStagedFiles ?? []);
  let dirtyFiles = [...(options.changedFiles ?? ['feature.txt'])];
  let remainingPushFailures = options.failPushCount ?? 0;
  const validationResponses = [...(options.validationResponses ?? [true])];
  const validationResults = [...(options.validationResults ?? [])];

  async function writeCodexOutput(args: string[], payload: Record<string, unknown>): Promise<void> {
    const outputFlagIndex = args.indexOf('--output-last-message');
    const outputFile = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : null;
    if (outputFile) {
      await writeFile(outputFile, JSON.stringify(payload), 'utf8');
    }
  }

  function buildAgentPayload(input: string | undefined): Record<string, unknown> {
    if (input?.includes('planner prompt')) {
      return {
        status: 'done',
        item: 'planner-pass',
        note: 'superseded one parent',
        action: 'supersede',
        parent_task_ids: ['task-a'],
        children: [{
          title: 'Research test item implementation plan',
          task_kind: 'research',
          priority: 'normal',
          touch_paths: ['backlog/inbox.jsonl', 'scripts/backlog/progress.txt'],
          acceptance_criteria: ['Concrete follow-up implementation tasks are written to backlog/inbox.jsonl'],
          execution_domain: null,
          validation_profile: null,
          capabilities: null,
          context: 'Inspect the test item surface and emit concrete implementation follow-ups.',
        }],
        ...(options.plannerOutput ?? {}),
      };
    }

    if (input?.includes('Return exactly this JSON object and nothing else: {"status":"done","item":"smoke","note":"ok"}')) {
      return { status: 'done', item: 'smoke', note: 'ok' };
    }

    return { status: 'done', item: 'test item', note: 'implemented' };
  }

  return {
    async run(command: string, args: string[], runOptions?: CommandRunOptions): Promise<CommandResult> {
      options.calls?.push(`run:${command} ${args.join(' ')}`.trim());
      if (command === 'claude' || command === 'codex') {
        if (runOptions?.input) {
          options.calls?.push(`input:${runOptions.input}`);
        }
        await options.onAgentInput?.(runOptions?.input);
        const isRepairPrompt = runOptions?.input?.includes('## Workspace Repair Mode') || runOptions?.input?.includes('## Reconciliation Mode');
        const isPlannerPrompt = runOptions?.input?.includes('planner prompt');
        if (isRepairPrompt && options.clearStagedFilesOnRepair) {
          stagedFiles.clear();
        }
        dirtyFiles = isPlannerPrompt ? [] : [...(options.changedFiles ?? ['feature.txt'])];

        if (!isPlannerPrompt) {
          await writeFile(
            path.join(root, 'scripts/backlog/progress.txt'),
            '# Backlog Progress Log\nStarted: today\n---\n## run\nbody\n---\n',
            'utf8',
          );
        }

        const payload = buildAgentPayload(runOptions?.input);
        if (command === 'codex') {
          if (runOptions?.onStdoutLine) {
            await runOptions?.onStdoutLine?.(JSON.stringify({
              type: 'item.completed',
              item: {
                id: 'item_1',
                type: 'agent_message',
                text: 'Inspecting repo state.',
              },
            }));
            await runOptions?.onStdoutLine?.(JSON.stringify({
              type: 'item.completed',
              item: {
                id: 'item_2',
                type: 'agent_message',
                text: 'Applying clean scoped change.',
              },
            }));
          }
          await writeCodexOutput(args, payload);
          return {
            code: 0,
            stdout: '',
            stderr: '',
          };
        }

        return {
          code: 0,
          stdout: JSON.stringify({
            structured_output: payload,
          }),
          stderr: '',
        };
      }

      if (command === 'git') {
        if (args[0] === 'status') {
          const files = options.statusResponses?.shift() ?? dirtyFiles;
          return {
            code: 0,
            stdout: files.map(file => ` M ${file}`).join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return { code: 0, stdout: [...stagedFiles].join('\n'), stderr: '' };
        }
        if (args[0] === 'add') {
          for (const file of args.slice(1).filter(value => value !== '-A' && value !== '--')) {
            stagedFiles.add(file);
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'commit' && args[1] === '-m') {
          const message = args[2] ?? '';
          await options.onGitCommit?.(message);
          stagedFiles.clear();
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'remote') {
          return { code: 0, stdout: options.remoteName ?? '', stderr: '' };
        }
        if (args[0] === 'push') {
          if (remainingPushFailures > 0) {
            remainingPushFailures -= 1;
            return { code: 1, stdout: '', stderr: 'push failed' };
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'pull' || args[0] === 'worktree' || args[0] === 'merge-tree' || args[0] === 'cherry-pick') {
          return { code: 0, stdout: '', stderr: '' };
        }
      }

      return { code: 0, stdout: '', stderr: '' };
    },
    async runShell(): Promise<CommandResult> {
      if (validationResults.length > 0) {
        const next = validationResults.shift()!;
        options.calls?.push(`shell:${next.code === 0 ? 'pass' : 'fail'}`);
        return next;
      }
      const nextValidation = validationResponses.length > 0 ? validationResponses.shift() : true;
      options.calls?.push(`shell:${nextValidation === false ? 'fail' : 'pass'}`);
      return nextValidation === false
        ? { code: 1, stdout: '', stderr: 'validation failed' }
        : { code: 0, stdout: 'validation passed', stderr: '' };
    },
    async which(): Promise<string | null> {
      return '/usr/bin/mock';
    },
  };
}

async function makeFixture(tasks: BacklogTaskSpec[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'backlog-e2e-test-'));
  tempDirs.push(root);
  await mkdir(path.join(root, 'scripts/backlog'), { recursive: true });
  await mkdir(path.join(root, 'backlog/tasks'), { recursive: true });
  await mkdir(path.join(root, 'backlog'), { recursive: true });
  await mkdir(path.join(root, '.backlog-runner'), { recursive: true });
  await writeFile(path.join(root, 'backlog.md'), '', 'utf8');
  await writeFile(path.join(root, 'backlog/inbox.jsonl'), '', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/patterns.md'), '# Patterns\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/progress.txt'), '# Backlog Progress Log\nStarted: today\n---\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/archive.md'), '# Backlog Archive\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/agent.md'), 'agent prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/planner.md'), 'planner prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/product.md'), 'product prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/interface.md'), 'interface prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/ux.md'), 'ux prompt', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/code.md'), 'code prompt', 'utf8');

  const config = normalizeBacklogRunnerConfig(
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
      validationProfiles: {
        repo: 'bash scripts/backlog/validate.sh',
        backlog: 'bash scripts/backlog/validate.sh',
      },
      runners: {
        taskUi: { tool: 'claude', model: 'default' },
        taskCode: { tool: 'codex', model: 'default' },
        planner: { tool: 'claude', model: 'sonnet' },
        product: { tool: 'claude', model: 'sonnet' },
        interface: { tool: 'claude', model: 'sonnet' },
        ux: { tool: 'claude', model: 'sonnet' },
        code: { tool: 'claude', model: 'sonnet' },
      },
      defaults: {
        workers: 1,
        passes: false,
        worktrees: false,
      },
    },
    path.join(root, 'backlog.config.mjs'),
  );

  for (const task of tasks) {
    await writeTaskSpec(config.files.taskSpecsDir, task);
  }
  return { root, config };
}

function baseTask(overrides: Partial<BacklogTaskSpec> = {}): BacklogTaskSpec {
  return {
    id: overrides.id ?? 'task-a',
    title: overrides.title ?? 'test item',
    priority: overrides.priority ?? 'normal',
    taskKind: overrides.taskKind ?? 'implementation',
    executionDomain: overrides.taskKind === 'research' ? undefined : overrides.executionDomain ?? 'code_logic',
    dependsOn: overrides.dependsOn ?? [],
    touchPaths: overrides.touchPaths ?? ['feature.txt'],
    capabilities: overrides.capabilities ?? [],
    validationProfile: overrides.validationProfile ?? 'repo',
    statusNotes: overrides.statusNotes ?? ['Seeded by test.'],
    state: overrides.state ?? 'ready',
    acceptanceCriteria: overrides.acceptanceCriteria ?? ['test item'],
    source: overrides.source ?? 'manual',
    createdAt: overrides.createdAt ?? '2026-04-08T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-08T00:00:00.000Z',
  };
}

async function stopAfterFirstSleep(filePath: string): Promise<void> {
  await writeFile(filePath, 'stop\n', 'utf8');
}

async function fileExistsForTest(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listTaskFilesRecursive(taskDir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(taskDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    if (entry.isDirectory()) {
      return listTaskFilesRecursive(path.join(taskDir, entry.name), path.join(prefix, entry.name));
    }
    return entry.name.endsWith('.yaml') ? [path.join(prefix, entry.name)] : [];
  }));
  return nested.flat().sort();
}

async function readFollowupTask(root: string, taskFiles: string[]): Promise<string> {
  const followupFile = taskFiles.find(name => !name.endsWith('task-a.yaml'));
  if (!followupFile) {
    throw new Error('Expected follow-up task file');
  }
  return readFile(path.join(root, 'backlog/tasks', followupFile), 'utf8');
}

async function readCurrentTaskYaml(root: string, taskId: string): Promise<string> {
  const topLevelPath = path.join(root, 'backlog/tasks', `${taskId}.yaml`);
  try {
    return await readFile(topLevelPath, 'utf8');
  } catch {
    return readFile(path.join(root, 'backlog/tasks', 'done', `${taskId}.yaml`), 'utf8');
  }
}

async function cleanupTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 4) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => cleanupTempDir(dir)));
});

describe('runner e2e', () => {
  it('marks task done only after git finalization succeeds', async () => {
    const { root, config } = await makeFixture([baseTask()]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];
    const events: string[] = [];
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          onGitCommit: async message => {
            if (message !== 'chore(backlog): done – test item') return;
            const taskState = await readFile(path.join(root, 'backlog/tasks', 'task-a.yaml'), 'utf8');
            events.push(taskState.includes('state: done') ? 'done-at-commit' : 'not-done-at-commit');
          },
        }),
        createLogSink: async () => logSink,
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(await readCurrentTaskYaml(root, 'task-a')).toContain('state: done');
    expect(await readFile(path.join(root, 'backlog.md'), 'utf8')).toContain('- [x] test item');
    // Task must NOT be marked done until after commit succeeds — prevents orphaned "done" state on crash
    expect(events).toEqual(['not-done-at-commit']);
    expect(calls.indexOf('run:git commit -m chore(backlog): done – test item')).toBeGreaterThan(calls.indexOf('shell:pass'));
    expect(logSink.lines.join('')).toContain('Marked done after finalize');
  });

  it('writes Codex transcripts and surfaces live task progress before final completion', async () => {
    const { root, config } = await makeFixture([baseTask()]);
    config.runners.taskCode = { tool: 'codex', model: 'default' };
    let runtimeReportAtCommit = '';

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          onGitCommit: async message => {
            if (message !== 'chore(backlog): done – test item') return;
            runtimeReportAtCommit = await readFile(config.files.runtimeReport, 'utf8');
          },
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const transcriptDir = path.join(config.files.runnerLogDir, 'agent-transcripts');
    const transcriptFiles = (await readdir(transcriptDir)).filter(name => name.endsWith('.jsonl'));
    expect(transcriptFiles).toHaveLength(1);
    const transcriptContent = await readFile(path.join(transcriptDir, transcriptFiles[0]!), 'utf8');
    expect(transcriptContent).toContain('"type":"jsonl-event"');
    expect(transcriptContent).toContain('Inspecting repo state.');
    expect(transcriptContent).toContain('Applying clean scoped change.');

    expect(runtimeReportAtCommit).toContain('## Active Task Progress');
    expect(runtimeReportAtCommit).toContain('Inspecting repo state.');
    expect(runtimeReportAtCommit).toContain('Applying clean scoped change.');

    const finalRuntimeReport = await readFile(config.files.runtimeReport, 'utf8');
    expect(finalRuntimeReport).toContain('## Active Task Progress');
    expect(finalRuntimeReport).toContain('- None');
  });

  it('continues when remediation repairs validation failure', async () => {
    const { root, config } = await makeFixture([baseTask()]);

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          validationResponses: [false, true, true],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: done');
    expect(taskYaml).toContain('Recovered by remediation');
  });

  it('completes the task and queues a follow-up when validation only reports a worktree dependency issue', async () => {
    const { root, config } = await makeFixture([baseTask()]);
    const logSink = new MemoryLogSink();

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            ['feature.txt'],
            ['feature.txt'],
            ['feature.txt'],
            ['feature.txt'],
          ],
          onGitCommit: async () => {
            await stopAfterFirstSleep(config.files.stop);
          },
          validationResults: [
            {
              code: 1,
              stdout: '',
              stderr: 'FAIL  src/__tests__/api.test.ts | Error: Failed to load url fastify (resolved id: fastify) in /tmp/worktree/packages/server/src/index.ts. Does the file exist?',
            },
            {
              code: 1,
              stdout: '',
              stderr: 'FAIL  src/__tests__/api.test.ts | Error: Failed to load url fastify (resolved id: fastify) in /tmp/worktree/packages/server/src/index.ts. Does the file exist?',
            },
          ],
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: done');
    expect(taskYaml).toContain('Non-blocking validation issue deferred to follow-up');

    const taskFiles = await listTaskFilesRecursive(path.join(root, 'backlog/tasks'));
    expect(taskFiles.length).toBe(2);
    const followupYaml = await readFollowupTask(root, taskFiles);
    expect(followupYaml).toContain('title: Repair worktree validation environment');
    expect(logSink.lines.join('')).toContain('Non-blocking validation issue queued as follow-up');
  });

  it('keeps in-scope validation failures blocking when remediation does not fix them', async () => {
    const { root, config } = await makeFixture([baseTask({
      touchPaths: ['packages/server/src/routes/sets.ts'],
    })]);

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
          ],
          validationResults: [
            {
              code: 1,
              stdout: 'src/routes/sets.ts(605,13): error TS2322: Type \'Record<string, { token: unknown; setName: string; }>\' is not assignable to type \'Record<string, SnapshotEntry>\'.\nFAIL server build',
              stderr: '',
            },
            {
              code: 1,
              stdout: 'src/routes/sets.ts(605,13): error TS2322: Type \'Record<string, { token: unknown; setName: string; }>\' is not assignable to type \'Record<string, SnapshotEntry>\'.\nFAIL server build',
              stderr: '',
            },
          ],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: ready');
    expect(taskYaml).toContain('Deferred after remediation: validation failed: src/routes/sets.ts(605,13): error TS2322');
  });

  it('keeps ambiguous task-local missing-module failures blocking without workspace evidence', async () => {
    const { root, config } = await makeFixture([baseTask({
      touchPaths: ['packages/figma-plugin/src/ui/hooks/useTokenEditorLoad.ts'],
    })]);

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            ['packages/figma-plugin/src/ui/hooks/useTokenEditorLoad.ts'],
            ['packages/figma-plugin/src/ui/hooks/useTokenEditorLoad.ts'],
            ['packages/figma-plugin/src/ui/hooks/useTokenEditorLoad.ts'],
            ['packages/figma-plugin/src/ui/hooks/useTokenEditorLoad.ts'],
          ],
          validationResults: [
            {
              code: 1,
              stdout: "src/ui/hooks/useTokenEditorLoad.ts(120,3): error TS2307: Cannot find module '../shared/utils' or its corresponding type declarations.",
              stderr: '',
            },
            {
              code: 1,
              stdout: "src/ui/hooks/useTokenEditorLoad.ts(120,3): error TS2307: Cannot find module '../shared/utils' or its corresponding type declarations.",
              stderr: '',
            },
          ],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: ready');
    expect(taskYaml).toContain("Deferred after remediation: validation failed: src/ui/hooks/useTokenEditorLoad.ts(120,3): error TS2307: Cannot find module '../shared/utils'");
  });

  it('completes the task and queues a follow-up for explicit out-of-scope repo validation failures', async () => {
    const { root, config } = await makeFixture([baseTask({
      touchPaths: ['packages/server/src/routes/sets.ts'],
    })]);
    const logSink = new MemoryLogSink();

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
            ['packages/server/src/routes/sets.ts'],
          ],
          validationResults: [
            {
              code: 1,
              stdout: "packages/core/src/index.ts(10,2): error TS2307: Cannot find module 'fastify' or its corresponding type declarations.",
              stderr: '',
            },
            {
              code: 1,
              stdout: "packages/core/src/index.ts(10,2): error TS2307: Cannot find module 'fastify' or its corresponding type declarations.",
              stderr: '',
            },
          ],
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: done');
    expect(taskYaml).toContain('Non-blocking validation issue deferred to follow-up');

    const taskFiles = await listTaskFilesRecursive(path.join(root, 'backlog/tasks'));
    expect(taskFiles.length).toBe(2);
    const followupYaml = await readFollowupTask(root, taskFiles);
    expect(followupYaml).toContain('title: Resolve unrelated validation failure after test item');
    expect(followupYaml).toContain('packages/core/src/index.ts');
    expect(logSink.lines.join('')).toContain('Non-blocking validation issue queued as follow-up');
  });

  it('defers the task when preflight remediation cannot clear unrelated staged files', async () => {
    const { root, config } = await makeFixture([baseTask({ touchPaths: ['feature.txt'] })]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          initialStagedFiles: ['user-staged.txt'],
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: ready');
    expect(taskYaml).toContain('Deferred after remediation: dirty workspace preflight: staged user-staged.txt');
    expect(calls).not.toContain('input:agent prompt');
    expect(calls.some(call => call.includes('## Workspace Repair Mode'))).toBe(true);
    expect(logSink.lines.join('')).toContain('dirty workspace preflight');
  });

  it('defers dependency-manifest tasks before agent execution in worktree mode', async () => {
    const { root, config } = await makeFixture([baseTask({ touchPaths: ['package.json'] })]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      { worktrees: true },
      {
        commandRunner: createFakeCommandRunner(root, { calls }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: ready');
    expect(taskYaml).toContain('BACKLOG_MAIN_REPO_INSTALL_REQUIRED');
    expect(calls).not.toContain('input:agent prompt');
    expect(calls.every(call => !call.startsWith('run:git worktree add'))).toBe(true);
    expect(logSink.lines.join('')).toContain('BACKLOG_MAIN_REPO_INSTALL_REQUIRED');
  });

  it('defers shared install policy validation failures without entering remediation', async () => {
    const { root, config } = await makeFixture([baseTask()]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          validationResults: [{
            code: 1,
            stdout: 'dependency refresh required from main repo [BACKLOG_MAIN_REPO_INSTALL_REQUIRED]: poisoned shared install targets: packages/server/node_modules/fastify -> /tmp/backlog-123/node_modules/.pnpm/fastify/node_modules/fastify Recovery: remove poisoned package-local node_modules links and rerun pnpm install from the main repo root.',
            stderr: '',
          }],
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: ready');
    expect(taskYaml).toContain('BACKLOG_MAIN_REPO_INSTALL_REQUIRED');
    expect(calls.every(call => !call.includes('## Workspace Repair Mode'))).toBe(true);
    expect(logSink.lines.join('')).toContain('BACKLOG_MAIN_REPO_INSTALL_REQUIRED');
  });

  it('completes the task when validation introduces additional files outside the declared touch paths', async () => {
    const { root, config } = await makeFixture([baseTask({ touchPaths: ['feature.txt'] })]);

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            ['feature.txt'],
            ['feature.txt', 'packages/server/generated.ts'],
            ['feature.txt', 'packages/server/generated.ts'],
            ['feature.txt', 'packages/server/generated.ts'],
          ],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain('state: done');
    expect(taskYaml).not.toContain('post-validation scope violation');
  });

  it.each([
    {
      label: 'reconciles and finalizes autonomously after a transient finalize failure',
      failPushCount: 3,
      statusResponses: Array(9).fill(['feature.txt']) as string[][],
      expectedState: 'done',
      expectedPushCount: 4,
      expectedLog: 'Reconciliation finalized successfully',
    },
    {
      label: 'defers the task when reconciliation still cannot finalize',
      failPushCount: 6,
      statusResponses: [['feature.txt'], ['feature.txt'], ['feature.txt'], [], [], []] as string[][],
      expectedState: 'ready',
      expectedPushCount: 6,
      expectedLog: 'reconciliation finalize failed',
    },
  ])('$label', async ({ failPushCount, statusResponses, expectedState, expectedPushCount, expectedLog }) => {
    const { root, config } = await makeFixture([baseTask()]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          remoteName: 'origin',
          failPushCount,
          statusResponses,
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    const taskYaml = await readCurrentTaskYaml(root, 'task-a');
    expect(taskYaml).toContain(`state: ${expectedState}`);
    expect(calls.filter(call => call === 'run:git push')).toHaveLength(expectedPushCount);
    expect(calls.some(call => call.includes('## Reconciliation Mode'))).toBe(true);
    expect(logSink.lines.join('')).toContain(expectedLog);
  });

  it('normalizes duplicate task ids during runner startup before task-store reads become authoritative', async () => {
    const { root, config } = await makeFixture([baseTask()]);
    await mkdir(path.join(root, 'backlog/tasks', 'done'), { recursive: true });
    await writeFile(path.join(root, 'backlog/tasks', 'done', 'task-a.yaml'), [
      'id: task-a',
      'title: archived test item',
      'priority: normal',
      'task_kind: implementation',
      'execution_domain: code_logic',
      'depends_on:',
      'touch_paths:',
      '  - feature.txt',
      'capabilities:',
      'validation_profile: repo',
      'status_notes:',
      '  - archived duplicate',
      'state: done',
      'acceptance_criteria:',
      '  - test item',
      'source: manual',
      'created_at: 2026-04-08T00:00:00.000Z',
      'updated_at: 2026-04-08T00:01:00.000Z',
      '',
    ].join('\n'), 'utf8');
    await writeFile(config.files.stop, 'stop\n', 'utf8');

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    expect((await readdir(path.join(root, 'backlog/tasks'))).filter(name => name.endsWith('.yaml'))).toEqual([]);
    expect((await readdir(path.join(root, 'backlog/tasks', 'done'))).filter(name => name.endsWith('.yaml'))).toEqual(['task-a.yaml']);
    expect(await readFile(path.join(root, 'backlog/tasks', 'done', 'task-a.yaml'), 'utf8')).toContain('title: archived test item');
  });

  it('refines a planned task into planner child work and removes the parent from the live queue', async () => {
    const { root, config } = await makeFixture([baseTask({
      state: 'planned',
      touchPaths: [],
      statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
    })]);
    const logSink = new MemoryLogSink();

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          statusResponses: [
            [],
            [],
          ],
          onAgentInput: async (input) => {
            if (input?.includes('planner prompt')) {
              await stopAfterFirstSleep(config.files.stop);
            }
          },
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    expect(await readFile(path.join(root, 'backlog/tasks', 'task-a.yaml'), 'utf8')).toContain('state: superseded');
    expect(await readFile(path.join(root, 'backlog.md'), 'utf8')).toContain('Research test item implementation plan');
    expect(logSink.lines.join('')).toContain('superseded 1 planner candidate');
  });

  it('logs planner no-progress and stops when refinement fails', async () => {
    const { root, config } = await makeFixture([baseTask({
      state: 'failed',
      statusNotes: ['Failed: validation failed: missing dependency'],
    })]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          plannerOutput: {
            status: 'failed',
            item: 'planner-pass',
            note: 'could not safely recover this failed item',
            action: 'supersede',
            parent_task_ids: ['task-a'],
            children: [{
              title: 'Recover failed test item',
              task_kind: 'implementation',
              priority: 'normal',
              touch_paths: ['feature.txt'],
              acceptance_criteria: ['Recover failed task'],
              execution_domain: 'code_logic',
              validation_profile: 'repo',
              capabilities: null,
              context: 'Retry the failed item.',
            }],
          },
        }),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    expect(calls).toContain('input:planner prompt');
    expect(logSink.lines.join('')).toContain('planner refinement skipped');
    expect(logSink.lines.join('')).toContain('No runnable tasks remain and planner refinement made no progress — stopping.');
  });

  it('orchestrator proactively refines planned work when the ready buffer is low', async () => {
    const { root, config } = await makeFixture([
      baseTask({ id: 'task-ready', title: 'Ready task', touchPaths: ['feature.txt'] }),
      baseTask({
        id: 'task-planned',
        title: 'Planned task',
        state: 'planned',
        touchPaths: [],
        statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
      }),
    ]);
    const logSink = new MemoryLogSink();
    const calls: string[] = [];
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [[]],
          plannerOutput: {
            status: 'done',
            item: 'planner-pass',
            note: 'superseded one parent',
            action: 'supersede',
            parent_task_ids: ['task-planned'],
            children: [{
              title: 'Research planned task implementation plan',
              task_kind: 'research',
              priority: 'normal',
              touch_paths: ['backlog/inbox.jsonl', 'scripts/backlog/progress.txt'],
              acceptance_criteria: ['Concrete follow-up implementation tasks are written to backlog/inbox.jsonl'],
              execution_domain: null,
              validation_profile: null,
              capabilities: null,
              context: 'Inspect the planned task surface and emit concrete implementation follow-ups.',
            }],
          },
        }),
        createLogSink: async () => logSink,
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(calls).toContain('input:planner prompt');
    expect(await readFile(path.join(root, 'backlog/tasks', 'task-planned.yaml'), 'utf8')).toContain('state: superseded');
    expect(logSink.lines.join('')).toContain('superseded 1 planner candidate');
  });

  it('executor refines failed work even when other ready tasks are available', async () => {
    const { root, config } = await makeFixture([
      baseTask({ id: 'task-ready', title: 'Ready task', touchPaths: ['feature.txt'] }),
      baseTask({
        id: 'task-failed',
        title: 'Failed task',
        state: 'failed',
        priority: 'high',
        touchPaths: ['feature-failed.txt'],
        statusNotes: ['Failed: validation failed: missing dependency'],
      }),
    ]);
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [[]],
          plannerOutput: {
            status: 'done',
            item: 'planner-pass',
            note: 'recovered failed work',
            action: 'supersede',
            parent_task_ids: ['task-failed'],
            children: [{
              title: 'Recover failed task',
              task_kind: 'implementation',
              priority: 'normal',
              touch_paths: ['feature-failed.txt'],
              acceptance_criteria: ['Recover the failed task'],
              execution_domain: 'code_logic',
              validation_profile: 'repo',
              capabilities: null,
              context: 'Retry the failed task without losing urgency.',
            }],
          },
          onGitCommit: async () => {
            await stopAfterFirstSleep(config.files.stop);
          },
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    expect(calls).toContain('input:planner prompt');
    expect(await readFile(path.join(root, 'backlog/tasks', 'task-failed.yaml'), 'utf8')).toContain('state: superseded');
  });

  it('uses the taskCode runner for code execution and the planner runner for refinement', async () => {
    const { config, root } = await makeFixture([
      baseTask({ id: 'task-ready', title: 'Ready task', touchPaths: ['feature.txt'] }),
      baseTask({
        id: 'task-planned',
        title: 'Planned task',
        state: 'planned',
        touchPaths: [],
        statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
      }),
    ]);
    config.runners.taskCode = { tool: 'claude', model: 'default' };
    config.runners.planner = { tool: 'codex', model: 'default' };
    const calls: string[] = [];
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [['feature.txt']],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(calls.some(call => call.includes('planner prompt'))).toBe(true);
    expect(calls.some(call => call.startsWith('run:codex exec'))).toBe(true);
    expect(calls.some(call => call.startsWith('run:claude --dangerously-skip-permissions'))).toBe(true);
  });

  it('uses the taskUi runner for ui execution', async () => {
    const { config, root } = await makeFixture([
      baseTask({
        id: 'task-ui',
        title: 'UI task',
        executionDomain: 'ui_ux',
        touchPaths: ['packages/figma-plugin/src/ui/components/TokenList.tsx'],
      }),
    ]);
    config.runners.taskUi = { tool: 'claude', model: 'default' };
    config.runners.taskCode = { tool: 'codex', model: 'default' };
    const calls: string[] = [];
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [['packages/figma-plugin/src/ui/components/TokenList.tsx']],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(calls.some(call => call.startsWith('run:claude --dangerously-skip-permissions'))).toBe(true);
    expect(calls.some(call => call.startsWith('run:codex exec'))).toBe(false);
  });

  it('uses each discovery pass runner configuration independently', async () => {
    const { config, root } = await makeFixture([]);
    config.runners.product = { tool: 'codex', model: 'default' };
    config.runners.interface = { tool: 'claude', model: 'sonnet' };
    config.runners.ux = { tool: 'claude', model: 'default' };
    config.runners.code = { tool: 'codex', model: 'default' };
    const calls: string[] = [];
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      { passes: true },
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [[], [], []],
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    const discoveryInputs = calls
      .filter(call => call.startsWith('input:'))
      .map(call => call.slice('input:'.length))
      .flatMap(input => {
        const matches: string[] = [];
        if (input.includes('interface prompt')) matches.push('interface prompt');
        if (input.includes('ux prompt')) matches.push('ux prompt');
        if (input.includes('product prompt')) matches.push('product prompt');
        if (input.includes('code prompt')) matches.push('code prompt');
        return matches;
      });

    expect(discoveryInputs).toEqual(['interface prompt', 'ux prompt', 'product prompt', 'code prompt']);
    expect(calls.some(call => call.includes('interface prompt'))).toBe(true);
    expect(calls.some(call => call.includes('product prompt'))).toBe(true);
    expect(calls.some(call => call.includes('ux prompt'))).toBe(true);
    expect(calls.some(call => call.includes('code prompt'))).toBe(true);
    expect(calls.filter(call => call.startsWith('run:codex exec')).length).toBeGreaterThanOrEqual(2);
    expect(calls.some(call => call.startsWith('run:claude --dangerously-skip-permissions'))).toBe(true);
  });

  it('reports orchestrator worker state in the runtime report', async () => {
    const { root, config } = await makeFixture([baseTask()]);

    await runBacklogRunner(
      config,
      { workers: 2 },
      {
        commandRunner: createFakeCommandRunner(root, {
          onGitCommit: async () => {
            await stopAfterFirstSleep(config.files.stop);
          },
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    const runtimeReport = await readFile(config.files.runtimeReport, 'utf8');
    expect(runtimeReport).toContain('Orchestrator:');
    expect(runtimeReport).toContain('Workers: 1/2');
  });

  it.each([
    { worktrees: true, expected: 1 },
    { worktrees: false, expected: 0 },
  ])('prunes git worktrees on startup only when worktrees are enabled ($worktrees)', async ({ worktrees, expected }) => {
    const { root, config } = await makeFixture([]);
    const calls: string[] = [];

    await runBacklogRunner(
      config,
      { worktrees },
      {
        commandRunner: createFakeCommandRunner(root, { calls }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    expect(calls.filter(call => call === 'run:git worktree prune --expire now')).toHaveLength(expected);
  });

  it('refuses to start when another fresh orchestrator status is still live', async () => {
    const { config, root } = await makeFixture([]);
    await writeFile(
      path.join(config.files.runtimeDir, 'orchestrator-status.json'),
      `${JSON.stringify({
        orchestratorId: 'orch-live',
        pid: process.pid,
        requestedWorkers: 2,
        effectiveWorkers: 2,
        activeTaskWorkers: [],
        shutdownRequested: false,
        pollIntervalMs: ORCHESTRATOR_POLL_INTERVAL_MS,
        updatedAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );

    await expect(runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    )).rejects.toThrow(
      new RegExp(`Another backlog orchestrator is already running \\(orch-live, pid ${process.pid}\\).[\\s\\S]*${config.files.runtimeReport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('takes over a live orchestrator when takeover is requested', async () => {
    const { config, root } = await makeFixture([]);
    const logSink = new MemoryLogSink();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const priorOrchestratorId = 'orch-live';
    try {
      if (!child.pid) {
        throw new Error('Expected child pid');
      }
      await writeFile(
        path.join(config.files.runtimeDir, 'orchestrator-status.json'),
        `${JSON.stringify({
          orchestratorId: priorOrchestratorId,
          pid: child.pid,
          requestedWorkers: 2,
          effectiveWorkers: 2,
          activeTaskWorkers: [{ taskId: 'task-a', title: 'Task A' }],
          shutdownRequested: false,
          pollIntervalMs: ORCHESTRATOR_POLL_INTERVAL_MS,
          updatedAt: new Date().toISOString(),
        })}\n`,
        'utf8',
      );

      let shutdownApplied = false;
      await runBacklogRunner(
        config,
        { passes: false, takeover: true },
        {
          commandRunner: createFakeCommandRunner(root),
          createLogSink: async () => logSink,
          sleep: async () => {
            if (shutdownApplied || !(await fileExistsForTest(config.files.stop))) {
              return;
            }
            shutdownApplied = true;
            child.kill('SIGTERM');
            await rm(path.join(config.files.runtimeDir, 'orchestrator-status.json'), { force: true });
          },
        },
      );

      expect(shutdownApplied).toBe(true);
      expect(await fileExistsForTest(config.files.stop)).toBe(false);
      expect(logSink.lines.join('\n')).toContain(`Requested shutdown for existing orchestrator via ${config.files.stop}`);
      expect(logSink.lines.join('\n')).toContain('Existing orchestrator stopped — taking over with a new run.');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reclaims stale orchestrator status before starting', async () => {
    const { config, root } = await makeFixture([]);
    const logSink = new MemoryLogSink();
    await writeFile(
      path.join(config.files.runtimeDir, 'orchestrator-status.json'),
      `${JSON.stringify({
        orchestratorId: 'orch-stale',
        pid: process.pid,
        requestedWorkers: 2,
        effectiveWorkers: 2,
        activeTaskWorkers: [],
        shutdownRequested: false,
        pollIntervalMs: ORCHESTRATOR_POLL_INTERVAL_MS,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      'utf8',
    );

    await runBacklogRunner(
      config,
      { passes: false },
      {
        commandRunner: createFakeCommandRunner(root),
        createLogSink: async () => logSink,
        sleep: async () => undefined,
      },
    );

    expect(logSink.lines.join('')).toContain('Reclaimed stale orchestrator status: orch-stale');
  });

  it('reclaims dead-runner leases on startup so inherited in-progress work does not wedge the next run', async () => {
    const { config, root } = await makeFixture([baseTask()]);
    const seedStore = createFileBackedTaskStore(config);
    await seedStore.ensureProgressFile();
    await seedStore.ensureTaskSpecsReady();
    await seedStore.close();
    const db = new Database(config.files.stateDb);
    db.prepare(`
      INSERT INTO leases (task_id, runner_id, claim_token, claimed_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('task-a', '999999-1', 'dead-claim', new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    db.prepare(`
      INSERT INTO reservations (task_id, kind, value)
      VALUES (?, ?, ?)
    `).run('task-a', 'touch_path', 'feature.txt');
    db.close();

    await runBacklogRunner(
      config,
      {},
      {
        commandRunner: createFakeCommandRunner(root, {
          onGitCommit: async message => {
            if (message === 'chore(backlog): done – test item') {
              await stopAfterFirstSleep(config.files.stop);
            }
          },
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => undefined,
      },
    );

    expect(await readCurrentTaskYaml(root, 'task-a')).toContain('state: done');
  });

  it('runs discovery passes for blocked-only queues instead of stopping', async () => {
    const { config, root } = await makeFixture([baseTask()]);
    const seedStore = createFileBackedTaskStore(config);
    await seedStore.ensureProgressFile();
    await seedStore.ensureTaskSpecsReady();
    await seedStore.deferTaskById('task-a', 'waiting on external precondition', 60_000);
    await seedStore.close();

    const calls: string[] = [];
    const logSink = new MemoryLogSink();
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      { passes: true },
      {
        commandRunner: createFakeCommandRunner(root, { calls }),
        createLogSink: async () => logSink,
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(logSink.lines.join('')).toContain('No runnable tasks remain — running discovery passes to unblock backlog…');
    expect(logSink.lines.join('')).not.toContain('Remaining tasks are blocked; stopping instead of spending tokens on new discovery.');
    expect(calls.some(call => call.includes('interface prompt'))).toBe(true);
    expect(calls.some(call => call.includes('product prompt'))).toBe(true);
    expect(calls.some(call => call.includes('ux prompt'))).toBe(true);
    expect(calls.some(call => call.includes('code prompt'))).toBe(true);
  });

  it('backs off instead of exiting when blocked-state discovery makes no progress', async () => {
    const { config, root } = await makeFixture([baseTask()]);
    const seedStore = createFileBackedTaskStore(config);
    await seedStore.ensureProgressFile();
    await seedStore.ensureTaskSpecsReady();
    await seedStore.deferTaskById('task-a', 'waiting on external precondition', 60_000);
    await seedStore.close();

    const logSink = new MemoryLogSink();
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      { passes: true },
      {
        commandRunner: createFakeCommandRunner(root),
        createLogSink: async () => logSink,
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 3) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(logSink.lines.join('')).toContain('Blocked-state discovery made no progress — retrying in 30s.');
    expect(logSink.lines.join('')).not.toContain('Remaining tasks are blocked; stopping instead of spending tokens on new discovery.');
  });

  it('resets blocked-state discovery backoff after discovery creates runnable work', async () => {
    const { config, root } = await makeFixture([baseTask()]);
    const seedStore = createFileBackedTaskStore(config);
    await seedStore.ensureProgressFile();
    await seedStore.ensureTaskSpecsReady();
    await seedStore.deferTaskById('task-a', 'waiting on external precondition', 60_000);
    await seedStore.close();

    const calls: string[] = [];
    let createdFollowup = false;
    let sleepCalls = 0;

    await runBacklogRunner(
      config,
      { passes: true },
      {
        commandRunner: createFakeCommandRunner(root, {
          calls,
          statusResponses: [[], [], []],
          onAgentInput: async input => {
            if (!createdFollowup && input?.includes('product prompt')) {
              createdFollowup = true;
              await writeFile(
                path.join(root, 'backlog/inbox.jsonl'),
                `${JSON.stringify({
                  title: 'Discovery follow-up',
                  priority: 'normal',
                  touch_paths: ['discovered.txt'],
                  acceptance_criteria: ['Discovery follow-up is implemented'],
                  validation_profile: 'repo',
                  source: 'product-pass',
                })}\n`,
                'utf8',
              );
            }
          },
        }),
        createLogSink: async () => new MemoryLogSink(),
        sleep: async () => {
          sleepCalls += 1;
          if (sleepCalls === 4) {
            await stopAfterFirstSleep(config.files.stop);
          }
        },
      },
    );

    expect(calls.some(call => call.includes('product prompt'))).toBe(true);
    expect(calls).toContain('input:agent prompt');
  });
});
