import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BacklogConfigPreset,
  BacklogDiscoveryPassInput,
  BacklogPassConfig,
  BacklogPassConfigInput,
  BacklogPassHeuristics,
  BacklogPassHeuristicsInput,
  BacklogPublicAgentRole,
  BacklogRunnerConfig,
  BacklogRunnerConfigInput,
  BacklogRunnerRole,
  BacklogTool,
  ResolvedRunOptions,
  RunOverrides,
  ValidationProfileRule,
} from './types.js';
import { BACKLOG_PUBLIC_AGENT_ROLES, BACKLOG_RUNNER_ROLES } from './types.js';

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
const DEFAULT_VALIDATION_COMMAND = 'bash scripts/backlog/validate.sh';
const DEFAULT_BACKLOG_DIR = 'backlog';
const DEFAULT_RUNTIME_DIR = '.backlog-runner';
const DEFAULT_SCRIPTS_DIR = path.join('scripts', 'backlog');
const DEFAULT_STOP_FILE = 'backlog-stop';

type ModelsFileShape = {
  aliases?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
  model_crosswalk?: Record<string, Partial<Record<'claude' | 'codex', string>>>;
};

type NormalizedPaths = {
  backlogDir: string;
  runtimeDir: string;
  scriptsDir: string;
  files: BacklogRunnerConfig['files'];
  prompts: BacklogRunnerConfig['prompts'];
  discoveryPromptDir: string;
};

const PRESET_DEFAULTS: Record<BacklogConfigPreset, {
  workers: number;
  worktrees: boolean;
  runners: Record<BacklogRunnerRole, { tool: BacklogTool; model?: string }>;
}> = {
  safe: {
    workers: 1,
    worktrees: true,
    runners: {
      taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
      taskCode: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'codex', model: 'gpt-5.4' },
    },
  },
  balanced: {
    workers: 2,
    worktrees: true,
    runners: {
      taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
      taskCode: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'codex', model: 'gpt-5.4' },
    },
  },
  aggressive: {
    workers: 4,
    worktrees: true,
    runners: {
      taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
      taskCode: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'codex', model: 'gpt-5.4' },
    },
  },
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

function publicRoleToRunnerRole(role: BacklogPublicAgentRole): BacklogRunnerRole {
  if (role === 'planner') return 'planner';
  if (role === 'ui') return 'taskUi';
  return 'taskCode';
}

function runnerRoleToPublicRole(role: BacklogRunnerRole): BacklogPublicAgentRole {
  if (role === 'planner') return 'planner';
  if (role === 'taskUi') return 'ui';
  return 'code';
}

function cloneRunnerConfig(
  runner: { tool: BacklogTool; model?: string },
): { tool: BacklogTool; model?: string } {
  return { tool: runner.tool, model: runner.model };
}

function defaultRunnerForTool(tool: BacklogTool): { tool: BacklogTool; model?: string } {
  return {
    tool,
    model: DEFAULT_MODEL_MAP.default[tool],
  };
}

function normalizeProviderSelection(
  selection: BacklogRunnerConfigInput['providers'],
  preset: BacklogConfigPreset,
): BacklogRunnerConfig['runners'] {
  const base = Object.fromEntries(
    BACKLOG_RUNNER_ROLES.map(role => [role, cloneRunnerConfig(PRESET_DEFAULTS[preset].runners[role])]),
  ) as BacklogRunnerConfig['runners'];

  if (!selection || selection === 'auto') {
    return base;
  }

  if (selection === 'claude' || selection === 'codex') {
    return Object.fromEntries(
      BACKLOG_RUNNER_ROLES.map(role => [role, defaultRunnerForTool(selection)]),
    ) as BacklogRunnerConfig['runners'];
  }

  const defaultSelection = selection.default;
  let runners = base;
  if (defaultSelection && defaultSelection !== 'auto') {
    runners = Object.fromEntries(
      BACKLOG_RUNNER_ROLES.map(role => [role, defaultRunnerForTool(defaultSelection)]),
    ) as BacklogRunnerConfig['runners'];
  }

  for (const role of BACKLOG_PUBLIC_AGENT_ROLES) {
    const override = selection.agents?.[role];
    if (!override) continue;
    const runnerRole = publicRoleToRunnerRole(role);
    const fallback = runners[runnerRole];

    if (override === 'auto') {
      runners[runnerRole] = cloneRunnerConfig(PRESET_DEFAULTS[preset].runners[runnerRole]);
      continue;
    }

    if (override === 'claude' || override === 'codex') {
      runners[runnerRole] = defaultRunnerForTool(override);
      continue;
    }

    const tool = override.tool && override.tool !== 'auto' ? override.tool : fallback.tool;
    runners[runnerRole] = {
      tool,
      model: override.model ?? (override.tool && override.tool !== 'auto' ? DEFAULT_MODEL_MAP.default[tool] : fallback.model),
    };
  }

  return runners;
}

function normalizePassHeuristics(
  base?: BacklogPassHeuristicsInput,
  override?: BacklogPassHeuristicsInput,
): BacklogPassHeuristics {
  return {
    includePaths: [...new Set([...(base?.includePaths ?? []), ...(override?.includePaths ?? [])])],
    excludePaths: [...new Set([...(base?.excludePaths ?? []), ...(override?.excludePaths ?? [])])],
    capabilities: [...new Set([...(base?.capabilities ?? []), ...(override?.capabilities ?? [])])],
  };
}

function normalizeValidationConfig(
  validation: BacklogRunnerConfigInput['validation'],
): {
  validationCommand: string;
  validationProfiles: Record<string, string>;
  routing: ValidationProfileRule[];
} {
  if (!validation || typeof validation === 'string') {
    const command = validation ?? DEFAULT_VALIDATION_COMMAND;
    return {
      validationCommand: command,
      validationProfiles: { repo: command },
      routing: [],
    };
  }

  return {
    validationCommand: validation.default,
    validationProfiles: {
      repo: validation.default,
      ...(validation.profiles ?? {}),
    },
    routing: validation.routing ?? [],
  };
}

function resolveNormalizedPaths(baseDir: string, input: BacklogRunnerConfigInput): NormalizedPaths {
  const paths = input.paths ?? {};
  const backlogDir = resolvePath(baseDir, paths.backlogDir ?? DEFAULT_BACKLOG_DIR);
  const runtimeDir = resolvePath(baseDir, paths.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  const scriptsDir = resolvePath(baseDir, paths.scriptsDir ?? DEFAULT_SCRIPTS_DIR);
  const discoveryPromptDir = resolvePath(
    baseDir,
    input.discovery?.promptDir ?? path.join(paths.scriptsDir ?? DEFAULT_SCRIPTS_DIR, 'passes'),
  );

  return {
    backlogDir,
    runtimeDir,
    scriptsDir,
    discoveryPromptDir,
    files: {
      backlog: resolvePath(baseDir, paths.backlog ?? 'backlog.md'),
      candidateQueue: paths.candidateQueue ? resolvePath(baseDir, paths.candidateQueue) : path.join(backlogDir, 'inbox.jsonl'),
      candidateRejectLog: paths.candidateRejectLog ? resolvePath(baseDir, paths.candidateRejectLog) : path.join(runtimeDir, 'candidate-rejections.jsonl'),
      taskSpecsDir: paths.taskSpecsDir ? resolvePath(baseDir, paths.taskSpecsDir) : path.join(backlogDir, 'tasks'),
      stop: resolvePath(baseDir, paths.stopFile ?? DEFAULT_STOP_FILE),
      runtimeReport: paths.runtimeReport ? resolvePath(baseDir, paths.runtimeReport) : path.join(runtimeDir, 'runtime-report.md'),
      patterns: paths.patterns ? resolvePath(baseDir, paths.patterns) : path.join(scriptsDir, 'patterns.md'),
      progress: paths.progress ? resolvePath(baseDir, paths.progress) : path.join(scriptsDir, 'progress.txt'),
      stateDb: paths.stateDb ? resolvePath(baseDir, paths.stateDb) : path.join(runtimeDir, 'state.sqlite'),
      models: paths.models ? resolvePath(baseDir, paths.models) : path.join(scriptsDir, 'models.json'),
      runnerLogDir: paths.runnerLogDir ? resolvePath(baseDir, paths.runnerLogDir) : path.join(runtimeDir, 'logs'),
      runtimeDir,
      locksDir: paths.locksDir ? resolvePath(baseDir, paths.locksDir) : path.join(runtimeDir, 'locks'),
    },
    prompts: {
      agent: resolvePath(baseDir, input.prompts?.agent ?? path.join(scriptsDir, 'agent.md')),
      planner: resolvePath(baseDir, input.prompts?.planner ?? path.join(scriptsDir, 'planner.md')),
    },
  };
}

function normalizePassConfig(
  baseDir: string,
  defaultPromptDir: string,
  defaultRunner: BacklogPassConfigInput['runner'] | undefined,
  defaultHeuristics: BacklogPassHeuristicsInput | undefined,
  id: string,
  pass: BacklogDiscoveryPassInput,
): BacklogPassConfig {
  return {
    id,
    kind: 'discovery',
    enabled: pass.enabled ?? true,
    description: pass.description?.trim() || undefined,
    promptFile: resolvePath(baseDir, pass.promptFile ?? path.join(defaultPromptDir, `${id}.md`)),
    runner: pass.runner ? { tool: pass.runner.tool, model: pass.runner.model } : (defaultRunner ? { ...defaultRunner } : undefined),
    heuristics: normalizePassHeuristics(defaultHeuristics, pass.heuristics),
  };
}

function collectPassInputs(
  input: BacklogRunnerConfigInput,
): Array<[string, BacklogDiscoveryPassInput]> {
  const passes = new Map<string, BacklogDiscoveryPassInput>();
  for (const [rawId, pass] of Object.entries(input.discovery?.passes ?? {})) {
    if (!pass) continue;
    if (!isValidPassId(rawId)) {
      throw new Error(`Invalid pass id: ${rawId}`);
    }
    passes.set(rawId, { ...pass });
  }
  return [...passes.entries()];
}

function deepEqualRunner(
  left: { tool: BacklogTool; model?: string },
  right: { tool: BacklogTool; model?: string },
): boolean {
  return left.tool === right.tool && (left.model ?? '') === (right.model ?? '');
}

function sameHeuristics(
  left: BacklogPassHeuristics,
  right: BacklogPassHeuristics,
): boolean {
  return (
    left.includePaths.length === right.includePaths.length
    && left.excludePaths.length === right.excludePaths.length
    && left.capabilities.length === right.capabilities.length
    && left.includePaths.every((value, index) => value === right.includePaths[index])
    && left.excludePaths.every((value, index) => value === right.excludePaths[index])
    && left.capabilities.every((value, index) => value === right.capabilities[index])
  );
}

function detectPreset(config: BacklogRunnerConfig): BacklogConfigPreset {
  for (const preset of ['safe', 'balanced', 'aggressive'] as const) {
    const candidate = PRESET_DEFAULTS[preset];
    if (
      candidate.worktrees === config.defaults.worktrees
      && candidate.workers === config.defaults.workers
      && BACKLOG_RUNNER_ROLES.every(role => deepEqualRunner(candidate.runners[role], config.runners[role]))
    ) {
      return preset;
    }
  }
  return 'balanced';
}

function defaultResolvedPathsForConfigDir(configDir: string): NormalizedPaths {
  return resolveNormalizedPaths(configDir, {});
}

function serializeValidationConfig(config: BacklogRunnerConfig): BacklogRunnerConfigInput['validation'] {
  const routing = config.heuristics.validationProfileRules;
  const extraProfiles = Object.fromEntries(
    Object.entries(config.validationProfiles).filter(([profile, command]) => profile !== 'repo' || command !== config.validationCommand),
  );

  if (Object.keys(extraProfiles).length === 0 && routing.length === 0) {
    return config.validationCommand;
  }

  return {
    default: config.validationCommand,
    profiles: Object.keys(extraProfiles).length > 0 ? extraProfiles : undefined,
    routing: routing.length > 0
      ? routing.map(rule => ({ profile: rule.profile, pathPrefixes: [...rule.pathPrefixes] }))
      : undefined,
  };
}

function serializeProvidersConfig(
  config: BacklogRunnerConfig,
  preset: BacklogConfigPreset,
): BacklogRunnerConfigInput['providers'] | undefined {
  const presetDefaults = PRESET_DEFAULTS[preset].runners;
  const overrides: Partial<Record<BacklogPublicAgentRole, { tool?: BacklogTool | 'auto'; model?: string }>> = {};

  for (const role of BACKLOG_RUNNER_ROLES) {
    if (deepEqualRunner(config.runners[role], presetDefaults[role])) {
      continue;
    }
    overrides[runnerRoleToPublicRole(role)] = {
      tool: config.runners[role].tool,
      model: config.runners[role].model,
    };
  }

  return Object.keys(overrides).length > 0
    ? { default: 'auto', agents: overrides }
    : undefined;
}

function serializePathsConfig(
  config: BacklogRunnerConfig,
  configFilePath: string,
): BacklogRunnerConfigInput['paths'] | undefined {
  const configDir = path.dirname(path.resolve(configFilePath));
  const defaults = defaultResolvedPathsForConfigDir(configDir);
  const paths: NonNullable<BacklogRunnerConfigInput['paths']> = {};

  if (config.files.backlog !== defaults.files.backlog) {
    paths.backlog = toConfigRelativePath(configDir, config.files.backlog);
  }
  if (config.files.candidateQueue !== defaults.files.candidateQueue) {
    paths.candidateQueue = toConfigRelativePath(configDir, config.files.candidateQueue);
  }
  if (config.files.candidateRejectLog !== defaults.files.candidateRejectLog) {
    paths.candidateRejectLog = toConfigRelativePath(configDir, config.files.candidateRejectLog);
  }
  if (config.files.taskSpecsDir !== defaults.files.taskSpecsDir) {
    paths.taskSpecsDir = toConfigRelativePath(configDir, config.files.taskSpecsDir);
  }
  if (config.files.stop !== defaults.files.stop) {
    paths.stopFile = toConfigRelativePath(configDir, config.files.stop);
  }
  if (config.files.runtimeReport !== defaults.files.runtimeReport) {
    paths.runtimeReport = toConfigRelativePath(configDir, config.files.runtimeReport);
  }
  if (config.files.patterns !== defaults.files.patterns) {
    paths.patterns = toConfigRelativePath(configDir, config.files.patterns);
  }
  if (config.files.progress !== defaults.files.progress) {
    paths.progress = toConfigRelativePath(configDir, config.files.progress);
  }
  if (config.files.stateDb !== defaults.files.stateDb) {
    paths.stateDb = toConfigRelativePath(configDir, config.files.stateDb);
  }
  if (config.files.models && config.files.models !== defaults.files.models) {
    paths.models = toConfigRelativePath(configDir, config.files.models);
  }
  if (config.files.runnerLogDir !== defaults.files.runnerLogDir) {
    paths.runnerLogDir = toConfigRelativePath(configDir, config.files.runnerLogDir);
  }
  if (config.files.runtimeDir !== defaults.files.runtimeDir) {
    paths.runtimeDir = toConfigRelativePath(configDir, config.files.runtimeDir);
  }
  if (config.files.locksDir !== defaults.files.locksDir) {
    paths.locksDir = toConfigRelativePath(configDir, config.files.locksDir);
  }

  return Object.keys(paths).length > 0 ? paths : undefined;
}

function serializePromptsConfig(
  config: BacklogRunnerConfig,
  configFilePath: string,
): BacklogRunnerConfigInput['prompts'] | undefined {
  const configDir = path.dirname(path.resolve(configFilePath));
  const defaults = defaultResolvedPathsForConfigDir(configDir);
  const prompts: NonNullable<BacklogRunnerConfigInput['prompts']> = {};

  if (config.prompts.agent !== defaults.prompts.agent) {
    prompts.agent = toConfigRelativePath(configDir, config.prompts.agent);
  }
  if (config.prompts.planner !== defaults.prompts.planner) {
    prompts.planner = toConfigRelativePath(configDir, config.prompts.planner);
  }

  return Object.keys(prompts).length > 0 ? prompts : undefined;
}

function serializeClassificationConfig(config: BacklogRunnerConfig): BacklogRunnerConfigInput['classification'] | undefined {
  const classification: NonNullable<BacklogRunnerConfigInput['classification']> = {};
  const backlogRuntimePaths = config.heuristics.backlogRuntimePaths.filter(
    value => !DEFAULT_BACKLOG_RUNTIME_PATHS.includes(value),
  );
  const uiPathPrefixes = config.heuristics.uiPathPrefixes.filter(
    value => !DEFAULT_UI_PATH_PREFIXES.includes(value),
  );

  if (backlogRuntimePaths.length > 0) {
    classification.backlogRuntimePaths = backlogRuntimePaths;
  }
  if (uiPathPrefixes.length > 0) {
    classification.uiPathPrefixes = uiPathPrefixes;
  }

  return Object.keys(classification).length > 0 ? classification : undefined;
}

function serializeDiscoveryConfig(
  config: BacklogRunnerConfig,
  configFilePath: string,
): BacklogRunnerConfigInput['discovery'] | undefined {
  const configDir = path.dirname(path.resolve(configFilePath));
  const promptDir = config.discovery.promptDir;
  const serializedDefaults: NonNullable<NonNullable<BacklogRunnerConfigInput['discovery']>['defaults']> = {};
  if (config.discovery.defaults.runner) {
    serializedDefaults.runner = { ...config.discovery.defaults.runner };
  }
  if (
    config.discovery.defaults.heuristics.includePaths.length > 0
    || config.discovery.defaults.heuristics.excludePaths.length > 0
    || config.discovery.defaults.heuristics.capabilities.length > 0
  ) {
    serializedDefaults.heuristics = {
      includePaths: [...config.discovery.defaults.heuristics.includePaths],
      excludePaths: [...config.discovery.defaults.heuristics.excludePaths],
      capabilities: [...config.discovery.defaults.heuristics.capabilities],
    };
  }
  const passes = Object.fromEntries(
    Object.entries(config.passes).map(([id, pass]) => {
      const serialized: BacklogDiscoveryPassInput = {};
      if (!pass.enabled) {
        serialized.enabled = false;
      }
      if (pass.description) {
        serialized.description = pass.description;
      }
      const defaultPromptFile = path.join(promptDir, `${id}.md`);
      if (pass.promptFile !== defaultPromptFile) {
        serialized.promptFile = toConfigRelativePath(configDir, pass.promptFile);
      }
      if (
        pass.runner
        && !(
          config.discovery.defaults.runner
          && deepEqualRunner(pass.runner, config.discovery.defaults.runner)
        )
      ) {
        serialized.runner = { ...pass.runner };
      }
      if (!sameHeuristics(pass.heuristics, config.discovery.defaults.heuristics)) {
        serialized.heuristics = {
          includePaths: [...pass.heuristics.includePaths],
          excludePaths: [...pass.heuristics.excludePaths],
          capabilities: [...pass.heuristics.capabilities],
        };
      }
      return [id, serialized];
    }),
  );

  if (Object.keys(passes).length === 0 && config.defaults.passes) {
    return undefined;
  }

  return {
    enabled: config.defaults.passes,
    promptDir: toConfigRelativePath(configDir, promptDir),
    defaults: Object.keys(serializedDefaults).length > 0 ? serializedDefaults : undefined,
    passes,
  };
}

export function normalizeBacklogRunnerConfig(config: BacklogRunnerConfigInput, configFilePath?: string): BacklogRunnerConfig {
  const baseDir = configFilePath ? path.dirname(configFilePath) : (config.projectRoot ?? process.cwd());
  const preset = config.preset ?? 'balanced';
  const projectRoot = resolvePath(baseDir, config.projectRoot ?? '.');
  const pathConfig = resolveNormalizedPaths(baseDir, config);
  const validation = normalizeValidationConfig(config.validation);
  const runners = normalizeProviderSelection(config.providers, preset);
  const discoveryDefaults = config.discovery?.defaults;
  const normalizedPasses = Object.fromEntries(
    collectPassInputs(config).map(([id, pass]) => [
      id,
      normalizePassConfig(baseDir, pathConfig.discoveryPromptDir, discoveryDefaults?.runner, discoveryDefaults?.heuristics, id, pass),
    ]),
  ) as Record<string, BacklogPassConfig>;

  return {
    projectRoot,
    files: pathConfig.files,
    prompts: pathConfig.prompts,
    validationCommand: validation.validationCommand,
    validationProfiles: validation.validationProfiles,
    heuristics: {
      backlogRuntimePaths: [...new Set([
        ...DEFAULT_BACKLOG_RUNTIME_PATHS,
        ...(config.classification?.backlogRuntimePaths ?? []),
      ])],
      uiPathPrefixes: [...new Set([
        ...DEFAULT_UI_PATH_PREFIXES,
        ...(config.classification?.uiPathPrefixes ?? []),
      ])],
      validationProfileRules: validation.routing,
    },
    workspaceBootstrap: {
      installCommand: config.workspaceBootstrap?.installCommand ?? detectInstallCommand(projectRoot),
      repairCommand: config.workspaceBootstrap?.repairCommand ?? DEFAULT_REPAIR_COMMAND,
    },
    runners,
    defaults: {
      workers: config.workspace?.workers ?? PRESET_DEFAULTS[preset].workers,
      passes: config.discovery?.enabled ?? true,
      worktrees: config.workspace?.useWorktrees ?? PRESET_DEFAULTS[preset].worktrees,
    },
    discovery: {
      promptDir: pathConfig.discoveryPromptDir,
      defaults: {
        runner: discoveryDefaults?.runner ? { ...discoveryDefaults.runner } : undefined,
        heuristics: normalizePassHeuristics(undefined, discoveryDefaults?.heuristics),
      },
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

export function toSerializableBacklogRunnerConfig(
  config: BacklogRunnerConfig,
  configFilePath: string,
): BacklogRunnerConfigInput {
  const configDir = path.dirname(path.resolve(configFilePath));
  const projectRoot = toConfigRelativePath(configDir, config.projectRoot);
  const preset = detectPreset(config);

  return {
    preset,
    projectRoot: projectRoot === '.' ? undefined : projectRoot,
    paths: serializePathsConfig(config, configFilePath),
    prompts: serializePromptsConfig(config, configFilePath),
    validation: serializeValidationConfig(config),
    classification: serializeClassificationConfig(config),
    providers: serializeProvidersConfig(config, preset),
    workspaceBootstrap: {
      installCommand: config.workspaceBootstrap.installCommand,
      repairCommand: config.workspaceBootstrap.repairCommand,
    },
    workspace: {
      workers: config.defaults.workers,
      useWorktrees: config.defaults.worktrees,
    },
    discovery: serializeDiscoveryConfig(config, configFilePath),
  };
}

export function serializeBacklogRunnerConfig(config: BacklogRunnerConfig, configFilePath: string): string {
  return `export default ${JSON.stringify(toSerializableBacklogRunnerConfig(config, configFilePath), null, 2)};\n`;
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
