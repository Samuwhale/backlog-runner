import { access } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { RunOverrides, BacklogTool } from '../src/types.js';

export type CliCommandName = 'start' | 'doctor' | 'sync' | 'status' | 'init' | 'setup' | 'pass';
export type CliPassAction = 'list' | 'add' | 'remove' | 'enable' | 'disable';

export type ParsedCliCommand =
  | { command: 'start'; configPath: string; overrides: RunOverrides; yes: boolean }
  | { command: 'doctor'; configPath: string; overrides: RunOverrides; repair: boolean }
  | { command: 'sync'; configPath: string }
  | { command: 'status'; configPath: string; verbose: boolean }
  | { command: 'init'; targetDir: string; force: boolean }
  | { command: 'setup'; configPath: string; agentic: boolean; yes: boolean }
  | { command: 'pass'; configPath: string; action: CliPassAction; passId?: string };

type CliOptionSchema = Record<string, { type: 'string' | 'boolean'; short?: string }>;
type ParsedOptionValue = string | boolean | Array<string | boolean> | undefined;

const START_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
  workers: { type: 'string' },
  tool: { type: 'string' },
  model: { type: 'string' },
  passes: { type: 'boolean' },
  'no-passes': { type: 'boolean' },
  worktrees: { type: 'boolean' },
  'no-worktrees': { type: 'boolean' },
  takeover: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
} satisfies CliOptionSchema;

const DOCTOR_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
  tool: { type: 'string' },
  model: { type: 'string' },
  worktrees: { type: 'boolean' },
  'no-worktrees': { type: 'boolean' },
  repair: { type: 'boolean' },
} satisfies CliOptionSchema;

const SYNC_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
} satisfies CliOptionSchema;

const STATUS_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
  verbose: { type: 'boolean' },
} satisfies CliOptionSchema;

const INIT_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  dir: { type: 'string' },
  force: { type: 'boolean', short: 'f' },
} satisfies CliOptionSchema;

const SETUP_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
  agentic: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
} satisfies CliOptionSchema;

const PASS_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string' },
} satisfies CliOptionSchema;

const COMMANDS: Record<CliCommandName, {
  summary: string;
  usage: string;
  options: string[];
  examples: string[];
}> = {
  start: {
    summary: 'Start the backlog orchestrator.',
    usage: 'backlog-runner start [--workers N] [--tool TOOL] [--model MODEL] [--passes|--no-passes] [--worktrees|--no-worktrees] [--takeover] [--yes] [--config PATH]',
    options: [
      '  --workers N         Requested task workers. Shared workspace mode still runs one task at a time.',
      '  --tool TOOL         Global override for all runner roles (`claude` or `codex`).',
      '  --model MODEL       Global override for all runner roles.',
      '  --passes            Enable discovery when no runnable work remains.',
      '  --no-passes         Disable discovery when no runnable work remains.',
      '  --worktrees         Use isolated git worktrees for task execution.',
      '  --no-worktrees      Use the shared workspace. Effective task concurrency becomes 1.',
      '  --takeover          Stop a detected live orchestrator and take over the repo run.',
      '  --yes, -y           Skip the guided prompt and launch immediately.',
      '  --config PATH       Use a specific backlog runner config file.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner start',
      '  backlog-runner start --yes --workers 3',
      '  backlog-runner start --tool claude --model claude-opus-4-6',
      '  backlog-runner start --no-worktrees --workers 4',
    ],
  },
  doctor: {
    summary: 'Check backlog runner setup and runtime prerequisites.',
    usage: 'backlog-runner doctor [--tool TOOL] [--model MODEL] [--worktrees|--no-worktrees] [--repair] [--config PATH]',
    options: [
      '  --tool TOOL         Global override for all runner roles (`claude` or `codex`).',
      '  --model MODEL       Global override for all runner roles.',
      '  --worktrees         Validate git worktree readiness.',
      '  --no-worktrees      Skip git worktree add/remove validation.',
      '  --repair            Remove poisoned shared-install symlinks and rerun the configured repo install command before validation.',
      '  --config PATH       Use a specific backlog runner config file.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner doctor',
      '  backlog-runner doctor --tool codex --model gpt-5.4',
      '  backlog-runner doctor --no-worktrees',
      '  backlog-runner doctor --repair',
    ],
  },
  sync: {
    summary: 'Drain the candidate queue into task specs and rebuild backlog.md.',
    usage: 'backlog-runner sync [--config PATH]',
    options: [
      '  --config PATH       Use a specific backlog runner config file.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner sync',
    ],
  },
  status: {
    summary: 'Show queue state and live orchestrator activity.',
    usage: 'backlog-runner status [--verbose] [--config PATH]',
    options: [
      '  --verbose           Include lease, reservation, planner, and blockage sections from the live runtime report.',
      '  --config PATH       Use a specific backlog runner config file.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner status',
      '  backlog-runner status --verbose',
    ],
  },
  init: {
    summary: 'Scaffold backlog-runner files into a repository.',
    usage: 'backlog-runner init [--dir PATH] [--force]',
    options: [
      '  --dir PATH          Target repository directory. Defaults to the current working directory.',
      '  --force, -f         Overwrite existing scaffold files.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner init',
      '  backlog-runner init --dir ../my-repo',
      '  backlog-runner init --force',
    ],
  },
  setup: {
    summary: 'Guide discovery-pass setup and rewrite config canonically.',
    usage: 'backlog-runner setup [--agentic] [--yes] [--config PATH]',
    options: [
      '  --agentic           Ask a provider to draft pass recommendations and prompt text before review.',
      '  --yes, -y           Accept defaults and apply without the interactive review prompt.',
      '  --config PATH       Write to a specific config file. Defaults to ./backlog.config.mjs.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner setup',
      '  backlog-runner setup --agentic',
      '  backlog-runner setup --yes',
    ],
  },
  pass: {
    summary: 'List or mutate configured discovery passes.',
    usage: 'backlog-runner pass <list|add|remove|enable|disable> [id] [--config PATH]',
    options: [
      '  --config PATH       Use a specific backlog runner config file.',
      '  --help, -h          Show this help.',
    ],
    examples: [
      '  backlog-runner pass list',
      '  backlog-runner pass add docs',
      '  backlog-runner pass disable frontend',
    ],
  },
};

export const CLI_COMMANDS = Object.keys(COMMANDS) as CliCommandName[];

function renderHelpBlock(title: string, lines: string[]): string {
  return `${title}\n${lines.join('\n')}`;
}

export function renderTopLevelHelp(): string {
  return [
    'Usage: backlog-runner <command> [options]',
    '',
    'Commands:',
    ...CLI_COMMANDS.map(command => `  ${command.padEnd(7)} ${COMMANDS[command].summary}`),
    '',
    'Config discovery:',
    '  1. --config <path>',
    '  2. ./backlog.config.mjs in the current working directory',
    '',
    'Examples:',
    '  backlog-runner start',
    '  backlog-runner doctor',
    '  backlog-runner sync',
    '  backlog-runner status --verbose',
    '  backlog-runner init',
    '  backlog-runner setup',
    '  backlog-runner pass list',
    '',
    'Run `backlog-runner <command> --help` for command-specific options.',
    '',
  ].join('\n');
}

export function renderCommandHelp(command: CliCommandName): string {
  const meta = COMMANDS[command];
  return [
    meta.usage,
    '',
    meta.summary,
    '',
    renderHelpBlock('Options:', meta.options),
    '',
    renderHelpBlock('Examples:', meta.examples),
    '',
  ].join('\n');
}

export function resolveCommand(raw: string | undefined): CliCommandName | null {
  if (!raw) return null;
  return CLI_COMMANDS.includes(raw as CliCommandName) ? (raw as CliCommandName) : null;
}

export function suggestCommand(raw: string): string | null {
  if (raw === 'run') return 'start';
  if (raw === 'validate') return 'doctor';
  if (raw === 'check') return 'doctor';

  const prefixMatch = CLI_COMMANDS.find(command => command.startsWith(raw));
  return prefixMatch ?? null;
}

function formatConfigError(cwd: string): Error {
  return new Error(
    `No backlog config found. Auto-discovery looks for ${path.join(cwd, 'backlog.config.mjs')}. Pass --config <path> to use a different file.`,
  );
}

export async function discoverConfigPath(cwd: string, override?: string): Promise<string> {
  if (override?.trim()) {
    return override;
  }

  const discovered = path.join(cwd, 'backlog.config.mjs');
  try {
    await access(discovered);
    return discovered;
  } catch {
    throw formatConfigError(cwd);
  }
}

export function resolveSetupConfigPath(cwd: string, override?: string): string {
  return override?.trim() || path.join(cwd, 'backlog.config.mjs');
}

export function parseWorkers(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`Invalid worker count: ${value}. Expected a positive integer.`);
}

export function parseTool(value: string | undefined): BacklogTool | undefined {
  if (value === undefined) return undefined;
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  throw new Error(`Invalid tool: ${value}. Expected one of: claude, codex.`);
}

export function parseBooleanPair(
  values: Record<string, ParsedOptionValue>,
  enabledKey: string,
  disabledKey: string,
): boolean | undefined {
  const enabled = values[enabledKey];
  const disabled = values[disabledKey];
  if (enabled && disabled) {
    throw new Error(`Conflicting options: --${enabledKey} and --${disabledKey}.`);
  }
  if (enabled === true) return true;
  if (disabled === true) return false;
  return undefined;
}

function parseCommandArgs(command: CliCommandName, args: string[]): ReturnType<typeof parseArgs> {
  const optionsByCommand: Record<CliCommandName, CliOptionSchema> = {
    start: START_OPTIONS,
    doctor: DOCTOR_OPTIONS,
    sync: SYNC_OPTIONS,
    status: STATUS_OPTIONS,
    init: INIT_OPTIONS,
    setup: SETUP_OPTIONS,
    pass: PASS_OPTIONS,
  };
  const normalizedArgs = args.filter(arg => arg !== '--');

  return parseArgs({
    args: normalizedArgs,
    options: optionsByCommand[command],
    allowPositionals: command === 'pass',
    strict: true,
  });
}

export function formatCommandParseError(command: CliCommandName, error: unknown): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const unknownOptionMatch = rawMessage.match(/Unknown option '([^']+)'/);
  if (unknownOptionMatch) {
    return new Error(`Unknown option ${unknownOptionMatch[1]} for '${command}'. See 'backlog-runner ${command} --help'.`);
  }

  if (rawMessage.includes('Unexpected argument')) {
    return new Error(`Unexpected argument for '${command}'. See 'backlog-runner ${command} --help'.`);
  }

  return new Error(rawMessage);
}

export async function parseCliCommand(command: CliCommandName, args: string[], cwd: string): Promise<ParsedCliCommand> {
  let parsedArgs: ReturnType<typeof parseCommandArgs>;
  let values: Record<string, ParsedOptionValue>;
  try {
    parsedArgs = parseCommandArgs(command, args);
    ({ values } = parsedArgs);
  } catch (error) {
    throw formatCommandParseError(command, error);
  }

  if (command === 'init') {
    return {
      command,
      targetDir: (values.dir as string | undefined) || cwd,
      force: values.force === true,
    };
  }

  if (command === 'setup') {
    return {
      command,
      configPath: resolveSetupConfigPath(cwd, values.config as string | undefined),
      agentic: values.agentic === true,
      yes: values.yes === true,
    };
  }

  if (command === 'pass') {
    const [rawAction, rawPassId] = parsedArgs.positionals;
    if (!rawAction) {
      throw new Error(`Missing pass action. Expected one of: list, add, remove, enable, disable.`);
    }
    if (!['list', 'add', 'remove', 'enable', 'disable'].includes(rawAction)) {
      throw new Error(`Invalid pass action: ${rawAction}. Expected one of: list, add, remove, enable, disable.`);
    }
    if (rawAction !== 'list' && !rawPassId) {
      throw new Error(`Pass action '${rawAction}' requires a pass id.`);
    }
    return {
      command,
      configPath: await discoverConfigPath(cwd, values.config as string | undefined),
      action: rawAction as CliPassAction,
      passId: rawPassId,
    };
  }

  const configPath = await discoverConfigPath(cwd, values.config as string | undefined);

  if (command === 'start') {
    return {
      command,
      configPath,
      yes: Boolean(values.yes),
      overrides: {
        tool: parseTool(values.tool as string | undefined),
        workers: parseWorkers(values.workers as string | undefined),
        model: (values.model as string | undefined) || undefined,
        passes: parseBooleanPair(values, 'passes', 'no-passes'),
        worktrees: parseBooleanPair(values, 'worktrees', 'no-worktrees'),
        takeover: values.takeover === true ? true : undefined,
      },
    };
  }

  if (command === 'doctor') {
    return {
      command,
      configPath,
      repair: values.repair === true,
      overrides: {
        tool: parseTool(values.tool as string | undefined),
        model: (values.model as string | undefined) || undefined,
        worktrees: parseBooleanPair(values, 'worktrees', 'no-worktrees'),
      },
    };
  }

  if (command === 'status') {
    return {
      command,
      configPath,
      verbose: Boolean(values.verbose),
    };
  }

  return {
    command,
    configPath,
  };
}
