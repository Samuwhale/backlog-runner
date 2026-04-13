import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { BacklogRunnerConfig, BacklogRunnerRole, BacklogTool, RunOverrides } from '../src/types.js';

const TOOLS: BacklogTool[] = ['claude', 'codex'];
const RUNNER_ROLES: BacklogRunnerRole[] = ['taskUi', 'taskCode', 'planner', 'product', 'interface', 'ux', 'code'];
const MAX_INTERACTIVE_WORKERS = 8;
const SUMMARY_DIVIDER = '----------------------------------------';
const RUNNER_ROLE_WIDTH = 9;

export interface InteractivePrompter {
  question(prompt: string): Promise<string>;
  write(message: string): void;
  close(): void | Promise<void>;
}

function createReadlinePrompter(): InteractivePrompter {
  const rl = createInterface({ input, output });
  return {
    question(prompt: string): Promise<string> {
      return rl.question(prompt);
    },
    write(message: string): void {
      output.write(message);
    },
    close(): void {
      rl.close();
    },
  };
}

function parseYesNoAnswer(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  return fallback;
}

function resolveWorkspaceChoice(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'isolated', 'worktrees', 'git worktrees', 'git-worktrees'].includes(normalized)) return true;
  if (['2', 'shared', 'shared workspace', 'workspace'].includes(normalized)) return false;
  return fallback;
}

export function resolveToolChoice(value: string, fallback?: BacklogTool): BacklogTool | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'repo' || normalized === 'defaults' || normalized === 'none' || normalized === '1') {
    return undefined;
  }
  if (normalized === '2') return 'claude';
  if (normalized === '3') return 'codex';
  return TOOLS.includes(normalized as BacklogTool) ? (normalized as BacklogTool) : fallback;
}

export function resolveWorkerChoice(value: string, fallback: number, maxWorkers = MAX_INTERACTIVE_WORKERS): number {
  const normalized = value.trim();
  if (!normalized) return fallback;

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  if (parsed < 1 || parsed > maxWorkers) {
    return fallback;
  }
  return parsed;
}

type StartSummaryInput = {
  tool?: BacklogTool;
  runners?: RunOverrides['runners'];
  repoRunners?: BacklogRunnerConfig['runners'];
  workers: number;
  model?: string;
  passes: boolean;
  worktrees: boolean;
};

function workspaceModeLabel(worktrees: boolean): string {
  return worktrees ? 'isolated git worktrees' : 'shared workspace';
}

function roleLabel(role: BacklogRunnerRole): string {
  switch (role) {
    case 'taskUi':
      return 'UI/UX implementation runner';
    case 'taskCode':
      return 'Code/logic implementation runner';
    case 'planner':
      return 'Planner runner';
    case 'product':
      return 'Product pass runner';
    case 'interface':
      return 'Interface pass runner';
    case 'ux':
      return 'UX pass runner';
    case 'code':
      return 'Code pass runner';
  }
}

function modelLabel(model?: string): string {
  return model?.trim() || 'unspecified';
}

function effectiveRunnerSummary(
  input: StartSummaryInput,
  role: BacklogRunnerRole,
): { tool: string; model?: string } {
  const repoRunner = input.repoRunners?.[role];
  const roleOverride = input.runners?.[role];
  return {
    tool: roleOverride?.tool ?? input.tool ?? repoRunner?.tool ?? 'repo default',
    model: roleOverride?.model ?? input.model ?? repoRunner?.model,
  };
}

function renderRunnerSummaryLines(input: StartSummaryInput): string[] {
  return [
    'Runners:',
    ...RUNNER_ROLES.map(role => {
      const runner = effectiveRunnerSummary(input, role);
      return `  ${role.padEnd(RUNNER_ROLE_WIDTH, ' ')} ${runner.tool}${runner.model ? ` · ${runner.model}` : ''}`;
    }),
  ];
}

export function summarizeStartOverrides(overrides: StartSummaryInput): string {
  const requestedWorkers = overrides.workers;
  const effectiveWorkers = overrides.worktrees ? requestedWorkers : 1;
  const workerSummary = overrides.worktrees
    ? `${requestedWorkers}`
    : `${requestedWorkers} requested, ${effectiveWorkers} effective in shared workspace`;

  return [
    'Launch settings',
    SUMMARY_DIVIDER,
    `Workspace mode:            ${workspaceModeLabel(overrides.worktrees)}`,
    `Requested task workers:    ${workerSummary}`,
    `Discovery when no runnable work remains: ${overrides.passes ? 'enabled' : 'disabled'}`,
    ...renderRunnerSummaryLines(overrides),
    SUMMARY_DIVIDER,
  ].join('\n');
}

function hasExplicitOverrides(overrides: RunOverrides): boolean {
  return Boolean(
    overrides.tool !== undefined ||
    overrides.runners !== undefined ||
    overrides.workers !== undefined ||
    overrides.model !== undefined ||
    overrides.passes !== undefined ||
    overrides.worktrees !== undefined
  );
}

function resolveRunnerSetupChoice(value: string): 'global' | 'mixed' {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === 'global' || normalized === 'all') return 'global';
  if (normalized === '2' || normalized === 'mixed' || normalized === 'per-role' || normalized === 'per role') return 'mixed';
  return 'global';
}

function cloneRunnerOverrides(runners?: RunOverrides['runners']): RunOverrides['runners'] | undefined {
  if (!runners) return undefined;
  return Object.fromEntries(
    Object.entries(runners).map(([role, runner]) => [role, runner ? { ...runner } : runner]),
  ) as RunOverrides['runners'];
}

export function shouldPromptInteractively(
  command: 'start' | 'doctor' | 'sync' | 'status',
  overrides: RunOverrides,
  options: { yes?: boolean } = {},
): boolean {
  if (!input.isTTY || !output.isTTY) return false;
  if (options.yes) return false;
  if (overrides.interactive === false) return false;
  if (overrides.interactive === true) return true;
  if (command !== 'start') return false;
  return !hasExplicitOverrides(overrides);
}

export async function promptForStartOverrides(
  config: BacklogRunnerConfig,
  currentOverrides: RunOverrides,
  prompter: InteractivePrompter = createReadlinePrompter(),
): Promise<RunOverrides> {
  try {
    let previous: RunOverrides = {
      tool: currentOverrides.tool,
      runners: cloneRunnerOverrides(currentOverrides.runners),
      workers: currentOverrides.workers ?? config.defaults.workers,
      model: currentOverrides.model,
      passes: currentOverrides.passes ?? config.defaults.passes,
      worktrees: currentOverrides.worktrees ?? config.defaults.worktrees,
      interactive: true,
    };

    while (true) {
      prompter.write('\nBacklog Runner Start\n\n');
      prompter.write(`Repo defaults\n${summarizeStartOverrides({
        tool: undefined,
        runners: undefined,
        repoRunners: config.runners,
        workers: config.defaults.workers,
        model: undefined,
        passes: config.defaults.passes,
        worktrees: config.defaults.worktrees,
      })}\n`);

      const startChoice = (await prompter.question(
        'Press Enter to start with repo defaults, type "customize" to change launch settings, or "cancel" to abort: ',
      ))
        .trim()
        .toLowerCase();

      if (startChoice === 'cancel' || startChoice === 'c') {
        throw new Error('Cancelled.');
      }

      if (!startChoice) {
        prompter.write(`\n${summarizeStartOverrides({
          tool: undefined,
          runners: undefined,
          repoRunners: config.runners,
          workers: config.defaults.workers,
          model: undefined,
          passes: config.defaults.passes,
          worktrees: config.defaults.worktrees,
        })}\n`);
        return {
          tool: undefined,
          workers: config.defaults.workers,
          model: undefined,
          passes: config.defaults.passes,
          worktrees: config.defaults.worktrees,
          interactive: true,
        };
      }

      const defaultWorktrees = previous.worktrees ?? config.defaults.worktrees;
      prompter.write('\nWorkspace mode options:\n');
      prompter.write(`  1. isolated git worktrees${defaultWorktrees ? ' (selected)' : ''}\n`);
      prompter.write(`  2. shared workspace${defaultWorktrees ? '' : ' (selected)'}\n`);
      const workspaceAnswer = await prompter.question(`Workspace mode [1-2] (${defaultWorktrees ? '1' : '2'}): `);
      const nextWorktrees = resolveWorkspaceChoice(workspaceAnswer, defaultWorktrees);

      const defaultWorkers = previous.workers ?? config.defaults.workers;
      const workersPrompt = nextWorktrees
        ? `Requested task workers [1-${MAX_INTERACTIVE_WORKERS}] (${defaultWorkers}): `
        : `Requested task workers [1-${MAX_INTERACTIVE_WORKERS}] (${defaultWorkers}, shared workspace still runs 1 at a time): `;
      const workersAnswer = await prompter.question(workersPrompt);
      const nextWorkers = resolveWorkerChoice(workersAnswer, defaultWorkers);

      const defaultPasses = previous.passes ?? config.defaults.passes;
      const passesAnswer = await prompter.question(
        `Enable discovery when no runnable work remains? [Y/n] (${defaultPasses ? 'yes' : 'no'}): `,
      );
      const nextPasses = parseYesNoAnswer(passesAnswer, defaultPasses);
      const currentSetup = previous.runners && Object.keys(previous.runners).length > 0 ? 'mixed' : 'global';
      prompter.write('\nRunner setup options:\n');
      prompter.write(`  1. one setting for all runners${currentSetup === 'global' ? ' (selected)' : ''}\n`);
      prompter.write(`  2. mixed per role${currentSetup === 'mixed' ? ' (selected)' : ''}\n`);
      const runnerSetupAnswer = await prompter.question(`Runner setup [1-2] (${currentSetup === 'global' ? '1' : '2'}): `);
      const runnerSetup = resolveRunnerSetupChoice(runnerSetupAnswer);

      let nextTool: BacklogTool | undefined;
      let nextModel: string | undefined;
      let nextRunners: RunOverrides['runners'];

      if (runnerSetup === 'mixed') {
        nextRunners = cloneRunnerOverrides(previous.runners) ?? {};
        nextTool = undefined;
        nextModel = undefined;
        prompter.write('\nPer-role runner setup\n');

        for (const role of RUNNER_ROLES) {
          const repoRunner = config.runners[role];
          const existingRunner = nextRunners[role];
          const currentTool = existingRunner?.tool ?? repoRunner.tool;
          const currentModel = existingRunner?.model ?? repoRunner.model;

          prompter.write(`\n${roleLabel(role)}\n`);
          prompter.write(`  Repo default: ${repoRunner.tool} · ${modelLabel(repoRunner.model)}\n`);
          prompter.write('  Tool options:\n');
          prompter.write(`    1. repo default${existingRunner?.tool === undefined ? ' (selected)' : ''}\n`);
          prompter.write(`    2. claude${existingRunner?.tool === 'claude' ? ' (selected)' : ''}\n`);
          prompter.write(`    3. codex${existingRunner?.tool === 'codex' ? ' (selected)' : ''}\n`);
          const roleToolAnswer = await prompter.question(`  Tool [1-3 or name] (${currentTool}): `);
          const roleTool = resolveToolChoice(roleToolAnswer, existingRunner?.tool);
          const roleModelAnswer = await prompter.question(`  Model (blank keeps repo default) (${currentModel ?? 'repo default'}): `);
          const roleModel = roleModelAnswer.trim() || undefined;

          nextRunners[role] = {
            tool: roleTool,
            model: roleModel,
          };
        }
      } else {
        nextRunners = undefined;
        const defaultTool = previous.tool;
        prompter.write('\nAll-runner tool override options:\n');
        prompter.write(`  1. repo defaults${defaultTool === undefined ? ' (selected)' : ''}\n`);
        prompter.write(`  2. claude${defaultTool === 'claude' ? ' (selected)' : ''}\n`);
        prompter.write(`  3. codex${defaultTool === 'codex' ? ' (selected)' : ''}\n`);
        const toolAnswer = await prompter.question(`Tool override [1-3 or name] (${defaultTool ?? 'repo defaults'}): `);
        nextTool = resolveToolChoice(toolAnswer, defaultTool);

        const defaultModel = previous.model;
        const modelAnswer = await prompter.question(
          `Model override (blank keeps repo defaults) (${defaultModel ?? 'repo defaults'}): `,
        );
        nextModel = modelAnswer.trim() || undefined;
      }

      const nextOverrides: RunOverrides = {
        tool: nextTool,
        runners: nextRunners,
        workers: nextWorkers,
        model: nextModel,
        passes: nextPasses,
        worktrees: nextWorktrees,
        interactive: true,
      };

      prompter.write(`\n${summarizeStartOverrides({
        tool: nextTool,
        runners: nextRunners,
        repoRunners: config.runners,
        workers: nextWorkers,
        model: nextModel,
        passes: nextPasses,
        worktrees: nextWorktrees,
      })}\n`);

      const confirm = (await prompter.question('Press Enter to launch, type "edit" to revise, or "cancel" to abort: '))
        .trim()
        .toLowerCase();

      if (!confirm) {
        prompter.write('\n');
        return nextOverrides;
      }

      if (confirm === 'cancel' || confirm === 'c') {
        throw new Error('Cancelled.');
      }

      previous = nextOverrides;
      prompter.write('\n');
    }
  } finally {
    await prompter.close();
  }
}
