import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BacklogPassConfig,
  BacklogPassConfigInput,
  BacklogPassHeuristics,
  BacklogRunnerConfig,
  BacklogRunnerConfigInput,
  BacklogRunnerRole,
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
const DEFAULT_PLANNER_PROMPT = path.join('scripts', 'backlog', 'planner.md');

type ModelsFileShape = {
  aliases?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
  model_crosswalk?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
};

type SerializableConfig = {
  projectRoot: string;
  files: BacklogRunnerConfigInput['files'];
  prompts: BacklogRunnerConfigInput['prompts'];
  validationCommand: string;
  validationProfiles: Record<string, string>;
  heuristics: BacklogRunnerConfigInput['heuristics'];
  workspaceBootstrap: BacklogRunnerConfigInput['workspaceBootstrap'];
  runners: BacklogRunnerConfigInput['runners'];
  defaults: BacklogRunnerConfigInput['defaults'];
  passes: Record<string, BacklogPassConfigInput>;
};

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

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function toConfigRelativePath(configDir: string, absolutePath: string): string {
  const relative = path.relative(configDir, absolutePath);
  const normalized = toPosixPath(relative || '.');
  if (normalized === '.') {
    return '.';
  }
  return normalized.startsWith('..') ? normalized : `./${normalized}`;
}

function normalizePassIdInternal(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizePassId(value: string): string {
  return normalizePassIdInternal(value);
}

export function isValidPassId(value: string): boolean {
  return normalizePassIdInternal(value) === value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
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

function normalizePassHeuristics(input?: BacklogPassConfigInput['heuristics']): BacklogPassHeuristics {
  return {
    includePaths: [...new Set(input?.includePaths ?? [])],
    excludePaths: [...new Set(input?.excludePaths ?? [])],
    capabilities: [...new Set(input?.capabilities ?? [])],
  };
}

function normalizePassConfig(baseDir: string, id: string, pass: BacklogPassConfigInput): BacklogPassConfig {
  return {
    id,
    kind: pass.kind,
    enabled: pass.enabled ?? true,
    description: pass.description?.trim() || undefined,
    promptFile: resolvePath(baseDir, pass.promptFile),
    runner: pass.runner ? { tool: pass.runner.tool, model: pass.runner.model } : undefined,
    heuristics: normalizePassHeuristics(pass.heuristics),
  };
}

function collectPassInputs(config: BacklogRunnerConfigInput): Array<[string, BacklogPassConfigInput]> {
  const passes = new Map<string, BacklogPassConfigInput>();

  for (const [rawId, pass] of Object.entries(config.passes ?? {})) {
    if (!pass) continue;
    if (!isValidPassId(rawId)) {
      throw new Error(`Invalid pass id: ${rawId}`);
    }
    passes.set(rawId, { ...pass });
  }

  return [...passes.entries()];
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

  const normalizedPasses = Object.fromEntries(
    collectPassInputs(config).map(([id, pass]) => [id, normalizePassConfig(baseDir, id, pass)]),
  ) as Record<string, BacklogPassConfig>;

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
      planner: resolvePath(baseDir, config.prompts.planner ?? DEFAULT_PLANNER_PROMPT),
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
    passes: normalizedPasses,
  };
}

export async function loadBacklogRunnerConfig(configPath: string): Promise<BacklogRunnerConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  try {
    const module = await import(pathToFileURL(absoluteConfigPath).href);
    const raw = (module.default ?? module.config ?? module) as BacklogRunnerConfigInput;
    return normalizeBacklogRunnerConfig(raw, absoluteConfigPath);
  } catch (error) {
    const source = await readFile(absoluteConfigPath, 'utf8').catch(() => '');
    const importsBacklogRunner = /\bfrom\s+['"]backlog-runner['"]/.test(source);
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

    if (importsBacklogRunner && code === 'ERR_MODULE_NOT_FOUND' && message.includes("Cannot find package 'backlog-runner'")) {
      throw new Error(
        [
          `Failed to load backlog config at ${absoluteConfigPath}.`,
          'This config imports `backlog-runner`, but that package is resolved from the config file location and is not available there.',
          'External config paths are supported only for self-contained config files.',
          'Rewrite this file to `export default { ... }`, or regenerate it with a backlog-runner version that emits portable configs.',
        ].join(' '),
        { cause: error },
      );
    }

    throw error;
  }
}

function toSerializablePassConfig(configDir: string, pass: BacklogPassConfig): BacklogPassConfigInput {
  return {
    kind: pass.kind,
    enabled: pass.enabled,
    description: pass.description,
    promptFile: toConfigRelativePath(configDir, pass.promptFile),
    runner: pass.runner ? { ...pass.runner } : undefined,
    heuristics: (
      pass.heuristics.includePaths.length > 0
      || pass.heuristics.excludePaths.length > 0
      || pass.heuristics.capabilities.length > 0
    )
      ? {
          includePaths: [...pass.heuristics.includePaths],
          excludePaths: [...pass.heuristics.excludePaths],
          capabilities: [...pass.heuristics.capabilities],
        }
      : undefined,
  };
}

export function toSerializableBacklogRunnerConfig(config: BacklogRunnerConfig, configFilePath: string): SerializableConfig {
  const configDir = path.dirname(path.resolve(configFilePath));
  return {
    projectRoot: toConfigRelativePath(configDir, config.projectRoot),
    files: {
      backlog: toConfigRelativePath(configDir, config.files.backlog),
      candidateQueue: toConfigRelativePath(configDir, config.files.candidateQueue),
      candidateRejectLog: toConfigRelativePath(configDir, config.files.candidateRejectLog),
      taskSpecsDir: toConfigRelativePath(configDir, config.files.taskSpecsDir),
      stop: toConfigRelativePath(configDir, config.files.stop),
      runtimeReport: toConfigRelativePath(configDir, config.files.runtimeReport),
      patterns: toConfigRelativePath(configDir, config.files.patterns),
      progress: toConfigRelativePath(configDir, config.files.progress),
      stateDb: toConfigRelativePath(configDir, config.files.stateDb),
      models: config.files.models ? toConfigRelativePath(configDir, config.files.models) : undefined,
      runnerLogDir: toConfigRelativePath(configDir, config.files.runnerLogDir),
      runtimeDir: toConfigRelativePath(configDir, config.files.runtimeDir),
      locksDir: toConfigRelativePath(configDir, config.files.locksDir),
    },
    prompts: {
      agent: toConfigRelativePath(configDir, config.prompts.agent),
      planner: toConfigRelativePath(configDir, config.prompts.planner),
    },
    validationCommand: config.validationCommand,
    validationProfiles: { ...config.validationProfiles },
    heuristics: {
      backlogRuntimePaths: [...config.heuristics.backlogRuntimePaths],
      uiPathPrefixes: [...config.heuristics.uiPathPrefixes],
      validationProfileRules: config.heuristics.validationProfileRules.map(rule => ({
        profile: rule.profile,
        pathPrefixes: [...rule.pathPrefixes],
      })),
    },
    workspaceBootstrap: {
      installCommand: config.workspaceBootstrap.installCommand,
      repairCommand: config.workspaceBootstrap.repairCommand,
    },
    runners: {
      taskUi: { ...config.runners.taskUi },
      taskCode: { ...config.runners.taskCode },
      planner: { ...config.runners.planner },
    },
    defaults: {
      workers: config.defaults.workers,
      passes: config.defaults.passes,
      worktrees: config.defaults.worktrees,
    },
    passes: Object.fromEntries(
      Object.entries(config.passes).map(([id, pass]) => [id, toSerializablePassConfig(configDir, pass)]),
    ),
  };
}

export function serializeBacklogRunnerConfig(config: BacklogRunnerConfig, configFilePath: string): string {
  return [
    `const config = ${JSON.stringify(toSerializableBacklogRunnerConfig(config, configFilePath), null, 2)};`,
    '',
    'export default config;',
    '',
  ].join('\n');
}

export async function writeBacklogRunnerConfig(configPath: string, config: BacklogRunnerConfig): Promise<void> {
  await writeFile(configPath, serializeBacklogRunnerConfig(config, configPath), 'utf8');
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
      // Fall through to built-in defaults.
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
