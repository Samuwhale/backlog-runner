import { describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../../src/config.js';
import {
  promptForStartOverrides,
  resolveToolChoice,
  resolveWorkerChoice,
  shouldPromptInteractively,
  summarizeStartOverrides,
  type InteractivePrompter,
} from '../interactive.js';

function makeConfig() {
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
        taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
        taskCode: { tool: 'codex', model: 'gpt-5.4' },
        planner: { tool: 'codex', model: 'gpt-5.4' },
        product: { tool: 'codex', model: 'gpt-5.4' },
        interface: { tool: 'claude', model: 'claude-opus-4-6' },
        ux: { tool: 'claude', model: 'claude-opus-4-6' },
        code: { tool: 'codex', model: 'gpt-5.4' },
      },
      defaults: {
        workers: 2,
        passes: true,
        worktrees: true,
      },
    },
    '/tmp/backlog.config.mjs',
  );
}

class FakePrompter implements InteractivePrompter {
  readonly writes: string[] = [];
  readonly prompts: string[] = [];

  constructor(private readonly answers: string[]) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answers.shift() ?? '';
  }

  write(message: string): void {
    this.writes.push(message);
  }

  close(): void {}
}

describe('interactive helpers', () => {
  it('resolves tool overrides from number or name', () => {
    expect(resolveToolChoice('3', 'claude')).toBe('codex');
    expect(resolveToolChoice('claude', 'codex')).toBe('claude');
    expect(resolveToolChoice('', 'codex')).toBeUndefined();
    expect(resolveToolChoice('repo', 'codex')).toBeUndefined();
  });

  it('resolves worker counts within the allowed range', () => {
    expect(resolveWorkerChoice('3', 1)).toBe(3);
    expect(resolveWorkerChoice('', 2)).toBe(2);
    expect(resolveWorkerChoice('0', 2)).toBe(2);
    expect(resolveWorkerChoice('99', 2, 8)).toBe(2);
  });

  it('renders a launch summary with workspace and runner info', () => {
    const summary = summarizeStartOverrides({
      tool: undefined,
      runners: undefined,
      repoRunners: makeConfig().runners,
      workers: 3,
      model: undefined,
      passes: true,
      worktrees: false,
    });

    expect(summary).toContain('shared workspace');
    expect(summary).toContain('3 requested');
    expect(summary).toContain('1 effective');
    expect(summary).toContain('enabled');
    expect(summary).toContain('codex');
    expect(summary).toContain('claude');
    expect(summary).toContain('gpt-5.4');
  });

  it('only prompts interactively for start when a TTY is present, no explicit overrides were supplied, and --yes is absent', () => {
    expect(shouldPromptInteractively('start', {})).toBeTypeOf('boolean');
    expect(shouldPromptInteractively('doctor', {})).toBe(false);
    expect(shouldPromptInteractively('start', { workers: 3 })).toBe(false);
    expect(shouldPromptInteractively('start', {}, { yes: true })).toBe(false);
  });

  it('returns repo defaults immediately when the user accepts them', async () => {
    const config = makeConfig();
    const prompter = new FakePrompter(['']);

    const overrides = await promptForStartOverrides(config, {}, prompter);

    expect(overrides).toMatchObject({
      tool: undefined,
      workers: 2,
      model: undefined,
      passes: true,
      worktrees: true,
      interactive: true,
    });
    expect(prompter.prompts).toHaveLength(1);
  });

  it('guides the user through customizing launch settings', async () => {
    const config = makeConfig();
    const prompter = new FakePrompter([
      'customize',
      '2',       // shared workspace
      '4',       // workers
      'n',       // no discovery passes
      '1',       // global runner setup
      '2',       // tool: claude
      'gpt-5.4-mini', // model
      '',        // confirm launch
    ]);

    const overrides = await promptForStartOverrides(config, {}, prompter);

    expect(overrides).toMatchObject({
      tool: 'claude',
      workers: 4,
      model: 'gpt-5.4-mini',
      passes: false,
      worktrees: false,
      interactive: true,
    });
    // 8 prompts: start-or-customize, workspace, workers, passes, runner-setup, tool, model, confirm
    expect(prompter.prompts).toHaveLength(8);
  });

  it('guides the user through a mixed per-role runner setup', async () => {
    const config = makeConfig();
    const prompter = new FakePrompter([
      'customize',
      '1',       // isolated worktrees
      '2',       // workers
      'y',       // discovery passes
      '2',       // mixed runner setup
      '2',       // taskUi: claude
      'claude-opus-4-6', // taskUi model
      '3',       // taskCode: codex
      'gpt-5.4', // taskCode model
      '2',       // planner: claude
      'claude-opus-4-6', // planner model
      '',        // product: repo default tool
      '',        // product: repo default model
      '',        // interface: repo default tool
      '',        // interface: repo default model
      '1',       // ux: repo default tool
      '',        // ux: repo default model
      '3',       // code: codex
      'gpt-5.4-mini', // code model
      '',        // confirm launch
    ]);

    const overrides = await promptForStartOverrides(config, {}, prompter);

    expect(overrides).toMatchObject({
      tool: undefined,
      model: undefined,
      workers: 2,
      passes: true,
      worktrees: true,
      interactive: true,
      runners: {
        taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
        taskCode: { tool: 'codex', model: 'gpt-5.4' },
        planner: { tool: 'claude', model: 'claude-opus-4-6' },
        product: { tool: undefined, model: undefined },
        interface: { tool: undefined, model: undefined },
        ux: { tool: undefined, model: undefined },
        code: { tool: 'codex', model: 'gpt-5.4-mini' },
      },
    });
  });
});
