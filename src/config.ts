import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BacklogRunnerRole,
  BacklogRunnerConfig,
  BacklogRunnerConfigInput,
  BacklogTool,
  ResolvedRunOptions,
  RunOverrides,
} from './types.js';
import { BACKLOG_RUNNER_ROLES } from './types.js';

const DEFAULT_MODEL_MAP = {
  default: { claude: 'claude-opus-4-6', codex: 'gpt-5.4' },
  sonnet: { claude: 'claude-sonnet-4-6', codex: 'gpt-5.4' },
  opus: { claude: 'claude-opus-4-6', codex: 'gpt-5.4' },
} as const;
const DEFAULT_BACKLOG_RUNTIME_PATHS = [
  'backlog/',
  '.backlog-runner/',
  'scripts/backlog/',
];
const DEFAULT_UI_PATH_PREFIXES = [
  'src/ui/',
  'src/components/',
  'src/routes/',
  'src/pages/',
  'app/',
  'apps/web/',
  'frontend/',
  'web/',
];
const DEFAULT_INSTALL_COMMAND = 'npm install';
const DEFAULT_REPAIR_COMMAND = 'backlog-runner doctor --repair';

function detectInstallCommand(projectRoot: string): string {
  if (existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm install --frozen-lockfile';
  }
  if (existsSync(path.join(projectRoot, 'bun.lock')) || existsSync(path.join(projectRoot, 'bun.lockb'))) {
    return 'bun install';
  }
  if (existsSync(path.join(projectRoot, 'yarn.lock'))) {
    return 'yarn install';
  }
  if (existsSync(path.join(projectRoot, 'package-lock.json')) || existsSync(path.join(projectRoot, 'npm-shrinkwrap.json'))) {
    return 'npm install';
  }
  return DEFAULT_INSTALL_COMMAND;
}

function resolvePath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function defineBacklogRunnerConfig(config: BacklogRunnerConfigInput): BacklogRunnerConfigInput {
  return config;
}

function normalizeRunnerConfig(
  config: BacklogRunnerConfigInput,
  role: BacklogRunnerRole,
): { tool: BacklogTool; model?: string } {
  const runner = config.runners[role];
  return {
    tool: runner.tool,
    model: runner.model,
  };
}

export function normalizeBacklogRunnerConfig(config: BacklogRunnerConfigInput, configFilePath?: string): BacklogRunnerConfig {
  const baseDir = configFilePath ? path.dirname(configFilePath) : (config.projectRoot ?? process.cwd());
  const projectRoot = resolvePath(baseDir, config.projectRoot ?? '.');
  const runnerLogDir = resolvePath(baseDir, config.files.runnerLogDir ?? path.dirname(config.files.progress));
  const runtimeDir = resolvePath(baseDir, config.files.runtimeDir ?? '.backlog-runner');
  const locksDir = resolvePath(baseDir, config.files.locksDir ?? path.join(runtimeDir, 'locks'));
  const candidateQueue = resolvePath(baseDir, config.files.candidateQueue ?? path.join('backlog', 'inbox.jsonl'));
  const candidateRejectLog = resolvePath(
    baseDir,
    config.files.candidateRejectLog ?? path.join(runtimeDir, 'candidate-rejections.jsonl'),
  );
  const taskSpecsDir = resolvePath(baseDir, config.files.taskSpecsDir ?? path.join('backlog', 'tasks'));
  const stateDb = resolvePath(baseDir, config.files.stateDb ?? path.join(runtimeDir, 'state.sqlite'));
  const runtimeReport = resolvePath(baseDir, config.files.runtimeReport ?? path.join(runtimeDir, 'runtime-report.md'));

  return {
    projectRoot,
    files: {
      backlog: resolvePath(baseDir, config.files.backlog),
      candidateQueue,
      candidateRejectLog,
      taskSpecsDir,
      stop: resolvePath(baseDir, config.files.stop),
      runtimeReport,
      patterns: resolvePath(baseDir, config.files.patterns),
      progress: resolvePath(baseDir, config.files.progress),
      stateDb,
      models: config.files.models ? resolvePath(baseDir, config.files.models) : undefined,
      runnerLogDir,
      runtimeDir,
      locksDir,
    },
    prompts: {
      agent: resolvePath(baseDir, config.prompts.agent),
      planner: resolvePath(baseDir, config.prompts.planner ?? path.join('scripts', 'backlog', 'planner-pass.md')),
      product: resolvePath(baseDir, config.prompts.product),
      interface: resolvePath(baseDir, config.prompts.interface),
      ux: resolvePath(baseDir, config.prompts.ux),
      code: resolvePath(baseDir, config.prompts.code),
    },
    validationCommand: config.validationCommand,
    validationProfiles: {
      repo: config.validationCommand,
      ...(config.validationProfiles ?? {}),
    },
    heuristics: {
      backlogRuntimePaths: [...new Set([
        ...DEFAULT_BACKLOG_RUNTIME_PATHS,
        ...(config.heuristics?.backlogRuntimePaths ?? []),
      ])],
      uiPathPrefixes: [...new Set([
        ...DEFAULT_UI_PATH_PREFIXES,
        ...(config.heuristics?.uiPathPrefixes ?? []),
      ])],
      validationProfileRules: config.heuristics?.validationProfileRules ?? [],
    },
    workspaceBootstrap: {
      installCommand: config.workspaceBootstrap?.installCommand ?? detectInstallCommand(projectRoot),
      repairCommand: config.workspaceBootstrap?.repairCommand ?? DEFAULT_REPAIR_COMMAND,
    },
    runners: Object.fromEntries(
      BACKLOG_RUNNER_ROLES.map(role => [role, normalizeRunnerConfig(config, role)]),
    ) as BacklogRunnerConfig['runners'],
    defaults: {
      workers: config.defaults?.workers ?? 1,
      passes: config.defaults?.passes ?? true,
      worktrees: config.defaults?.worktrees ?? true,
    },
    passes: {
      product: {
        promptFile: resolvePath(baseDir, config.passes?.product?.promptFile ?? config.prompts.product),
      },
      interface: {
        promptFile: resolvePath(baseDir, config.passes?.interface?.promptFile ?? config.prompts.interface),
      },
      ux: {
        promptFile: resolvePath(baseDir, config.passes?.ux?.promptFile ?? config.prompts.ux),
      },
      code: {
        promptFile: resolvePath(baseDir, config.passes?.code?.promptFile ?? config.prompts.code),
      },
    },
  };
}

export async function loadBacklogRunnerConfig(configPath: string): Promise<BacklogRunnerConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const module = await import(pathToFileURL(absoluteConfigPath).href);
  const raw = (module.default ?? module.config ?? module) as BacklogRunnerConfigInput;
  return normalizeBacklogRunnerConfig(raw, absoluteConfigPath);
}

export async function ensureConfigReady(config: BacklogRunnerConfig): Promise<void> {
  await mkdir(config.files.runtimeDir, { recursive: true });
  await mkdir(config.files.runnerLogDir, { recursive: true });
  await mkdir(config.files.locksDir, { recursive: true });
  await mkdir(config.files.taskSpecsDir, { recursive: true });
  await mkdir(path.dirname(config.files.candidateQueue), { recursive: true });
  await mkdir(path.dirname(config.files.candidateRejectLog), { recursive: true });
  await mkdir(path.dirname(config.files.runtimeReport), { recursive: true });
}

type ModelsFileShape = {
  aliases?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
  model_crosswalk?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
};

export async function resolveModelAlias(
  config: BacklogRunnerConfig,
  alias: string | undefined,
  tool: BacklogTool,
): Promise<string | undefined> {
  if (!alias?.trim()) {
    return undefined;
  }

  const fallback = DEFAULT_MODEL_MAP[alias as keyof typeof DEFAULT_MODEL_MAP]?.[tool];
  const modelsFile = config.files.models;

  if (modelsFile) {
    try {
      const content = await readFile(modelsFile, 'utf8');
      const parsed = JSON.parse(content) as ModelsFileShape;
      const fromAlias = parsed.aliases?.[alias]?.[tool];
      if (fromAlias) return fromAlias;
      const crosswalk = parsed.model_crosswalk?.[alias]?.[tool];
      if (crosswalk) return crosswalk;
    } catch {
      // fall through to built-in defaults
    }
  }

  return fallback ?? alias;
}

export async function resolveRunOptions(
  config: BacklogRunnerConfig,
  overrides: RunOverrides = {},
): Promise<ResolvedRunOptions> {
  const runners = Object.fromEntries(
    await Promise.all(
      BACKLOG_RUNNER_ROLES.map(async role => {
        const roleOverride = overrides.runners?.[role];
        const tool = roleOverride?.tool ?? overrides.tool ?? config.runners[role].tool;
        const rawModel = roleOverride?.model ?? overrides.model ?? config.runners[role].model;
        const model = await resolveModelAlias(config, rawModel, tool);
        return [role, { tool, model }];
      }),
    ),
  ) as ResolvedRunOptions['runners'];

  return {
    runners,
    workers: overrides.workers ?? config.defaults.workers,
    passes: overrides.passes ?? config.defaults.passes,
    worktrees: overrides.worktrees ?? config.defaults.worktrees,
  };
}
