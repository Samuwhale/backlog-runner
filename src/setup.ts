import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidPassId, loadBacklogRunnerConfig, normalizeBacklogRunnerConfig, normalizePassId, writeBacklogRunnerConfig } from './config.js';
import { runProvider, validateProvider } from './providers/index.js';
import { extractStructuredOutput } from './providers/common.js';
import { createCommandRunner } from './process.js';
import { syncBacklogRunner } from './scheduler/index.js';
import type {
  BacklogPassConfig,
  BacklogPassConfigInput,
  BacklogPassHeuristicsInput,
  BacklogPassRunnerConfig,
  BacklogRunnerConfig,
  BacklogRunnerConfigInput,
  BacklogTool,
  CommandRunner,
} from './types.js';
import { fileExists } from './utils.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = [
  path.resolve(MODULE_DIR, '..', '..'),
  path.resolve(MODULE_DIR, '..'),
].find(candidate => existsSync(path.join(candidate, 'templates', 'default', 'prompts')))
  ?? path.resolve(MODULE_DIR, '..');
const TEMPLATE_PROMPTS_DIR = path.join(PACKAGE_ROOT, 'templates', 'default', 'prompts');
const MANAGED_PASSES_DIR = path.join('scripts', 'backlog', 'passes');
const SCAFFOLD_GUIDE_PATH = path.join('scripts', 'backlog', 'README.md');
const REQUIRED_GITIGNORE_ENTRIES = ['.backlog-runner/state.sqlite', '.backlog-runner/logs/', 'backlog-stop'];
const AGENTIC_SETUP_RUNNERS: Array<{ tool: BacklogTool; model: string }> = [
  { tool: 'codex', model: 'gpt-5.4' },
  { tool: 'claude', model: 'claude-sonnet-4-6' },
];

export type RepoAnalysis = {
  projectRoot: string;
  packageManager: 'pnpm' | 'bun' | 'yarn' | 'npm';
  topLevelDirs: string[];
  packageScripts: string[];
  packageDependencies: string[];
};

export type DiscoveryPassDraft = {
  id: string;
  enabled: boolean;
  description?: string;
  runner?: BacklogPassRunnerConfig;
  heuristics?: BacklogPassHeuristicsInput;
  promptFile: string;
  promptContent: string;
  managedPrompt: boolean;
};

type AgenticSetupProposal = {
  passes: DiscoveryPassDraft[];
  fallbackReason?: string;
};

const DEFAULT_PASS_RUNNERS: Record<string, BacklogPassRunnerConfig> = {
  frontend: { tool: 'claude', model: 'claude-opus-4-6' },
  backend: { tool: 'codex', model: 'gpt-5.4' },
  api: { tool: 'codex', model: 'gpt-5.4' },
  deps: { tool: 'codex', model: 'gpt-5.4' },
  security: { tool: 'codex', model: 'gpt-5.4' },
  docs: { tool: 'claude', model: 'claude-opus-4-6' },
};

async function readPackageJson(projectRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path.join(projectRoot, 'package.json'), 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function detectPackageManager(projectRoot: string): RepoAnalysis['packageManager'] {
  if (existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectRoot, 'bun.lock')) || existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function normalizeDependencyList(packageJson: Record<string, unknown> | null): string[] {
  if (!packageJson) return [];
  const dependencies = packageJson.dependencies && typeof packageJson.dependencies === 'object'
    ? Object.keys(packageJson.dependencies as Record<string, unknown>)
    : [];
  const devDependencies = packageJson.devDependencies && typeof packageJson.devDependencies === 'object'
    ? Object.keys(packageJson.devDependencies as Record<string, unknown>)
    : [];
  return [...new Set([...dependencies, ...devDependencies].map(item => item.toLowerCase()))];
}

export async function analyzeRepository(projectRoot: string): Promise<RepoAnalysis> {
  const [packageJson, entries] = await Promise.all([
    readPackageJson(projectRoot),
    readdir(projectRoot, { withFileTypes: true }).catch(() => []),
  ]);
  const packageScripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? Object.keys(packageJson.scripts as Record<string, unknown>).sort()
    : [];
  const topLevelDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  return {
    projectRoot,
    packageManager: detectPackageManager(projectRoot),
    topLevelDirs,
    packageScripts,
    packageDependencies: normalizeDependencyList(packageJson),
  };
}

function existingDir(analysis: RepoAnalysis, candidates: string[]): string[] {
  return candidates.filter(candidate => analysis.topLevelDirs.includes(candidate.replace(/\/$/, '').split('/')[0] ?? candidate));
}

function includesAny(values: string[], candidates: string[]): boolean {
  return candidates.some(candidate => values.includes(candidate));
}

export function buildManagedPassPromptPath(projectRoot: string, passId: string): string {
  return path.join(projectRoot, MANAGED_PASSES_DIR, `${passId}.md`);
}

export function isManagedPassPromptPath(projectRoot: string, passId: string, promptFile: string): boolean {
  return path.resolve(promptFile) === path.resolve(buildManagedPassPromptPath(projectRoot, passId));
}

function buildPassPrompt(passId: string, description: string | undefined, heuristics?: BacklogPassHeuristicsInput): string {
  const includePaths = heuristics?.includePaths?.length ? heuristics.includePaths.map(item => `- ${item}`).join('\n') : '- None';
  const excludePaths = heuristics?.excludePaths?.length ? heuristics.excludePaths.map(item => `- ${item}`).join('\n') : '- None';
  const capabilities = heuristics?.capabilities?.length ? heuristics.capabilities.map(item => `- ${item}`).join('\n') : '- None';

  return [
    `You are the \`${passId}\` discovery pass for this repository.`,
    '',
    'Your job is NOT to implement anything. Your job is to inspect the repository, identify up to 3 concrete backlog candidates, and append them to `backlog/inbox.jsonl`.',
    '',
    '## Focus',
    description ?? `Inspect the repository for ${passId}-related gaps that should become standalone backlog work.`,
    '',
    '## Heuristic Hints',
    'Include path hints:',
    includePaths,
    '',
    'Exclude path hints:',
    excludePaths,
    '',
    'Capability hints:',
    capabilities,
    '',
    '## Candidate Output Rules',
    '- Emit standalone work items only.',
    '- Set `task_kind` to `implementation` or `research`.',
    '- Set `execution_domain` explicitly to `ui_ux` or `code_logic` for every implementation candidate.',
    '- Set `execution_domain` to `null` for research candidates.',
    '- Use `source` exactly as shown below, with this pass id.',
    '- Do not modify backlog.md directly.',
    '',
    'Schema:',
    `{"title":"Standalone backlog item title","task_kind":"implementation|research","priority":"high|normal|low","touch_paths":["repo/path"],"acceptance_criteria":["Concrete completion check"],"execution_domain":"ui_ux|code_logic|null","validation_profile":"optional","capabilities":["optional"],"context":"Optional concise context","source":{"type":"pass","pass_id":"${passId}"}}`,
    '',
    '## Return Format',
    `{"status":"done","item":"${passId}-pass","note":"<N items written to candidate queue>"}`,
  ].join('\n');
}

function backlogScaffoldGuide(): string {
  return [
    '# backlog-runner setup',
    '',
    'This folder is the repo-local surface for customizing how `backlog-runner` discovers and executes work.',
    '',
    '## Files',
    '',
    '- `agent.md`: implementation agent instructions shared by every task run.',
    '- `planner.md`: planner-pass instructions used when vague tasks need to be broken down.',
    '- `passes/*.md`: one prompt file per discovery pass.',
    '- `validate.sh`: starter validation command. Replace this with your real repo checks.',
    '- `models.json`: optional model aliases/crosswalks used by `backlog.config.mjs`.',
    '- `patterns.md`: reusable repo patterns learned during runs.',
    '- `progress.txt`: append-only per-task execution notes.',
    '',
    '## How to customize passes',
    '',
    '1. Run `backlog-runner setup --agentic` if you want an agent to draft the initial pass set from the current repo.',
    '2. Edit `backlog.config.mjs` to tune validation, workspace settings, provider selection, and discovery passes.',
    '3. Edit `scripts/backlog/passes/<pass-id>.md` to adjust focus and heuristics, but keep the structured candidate queue and return contract intact.',
    '4. Use `backlog-runner pass add <id>` / `remove` / `enable` / `disable` for lightweight pass management.',
    '',
    '## Recommended pattern',
    '',
    '- Keep the config focused on metadata: runner selection, path hints, and pass lifecycle.',
    '- Keep the prompt files focused on policy and output format.',
    '- Prefer a small number of durable passes that map to real repo surfaces, such as `frontend`, `backend`, `api`, `docs`, `security`, or `deps`.',
    '- Treat agentic setup as a bootstrap aid, not the long-term source of truth. Once generated, the repo-owned config and prompt files should be edited directly.',
    '',
  ].join('\n');
}

function makeDraft(
  projectRoot: string,
  id: string,
  description: string,
  heuristics?: BacklogPassHeuristicsInput,
  runner?: BacklogPassRunnerConfig,
): DiscoveryPassDraft {
  const normalizedId = normalizePassId(id);
  const promptFile = buildManagedPassPromptPath(projectRoot, normalizedId);
  return {
    id: normalizedId,
    enabled: true,
    description,
    heuristics,
    runner,
    promptFile,
    promptContent: buildPassPrompt(normalizedId, description, heuristics),
    managedPrompt: true,
  };
}

export function createManagedDiscoveryPassDraft(
  projectRoot: string,
  id: string,
  options: {
    description?: string;
    enabled?: boolean;
    runner?: BacklogPassRunnerConfig;
    heuristics?: BacklogPassHeuristicsInput;
    promptContent?: string;
  } = {},
): DiscoveryPassDraft {
  if (!isValidPassId(id)) {
    throw new Error(`Invalid pass id: ${id}. Pass ids must be lowercase kebab-case.`);
  }
  const normalizedId = id;
  const description = options.description ?? `Inspect ${normalizedId}-related gaps in this repository and file standalone backlog work.`;
  const promptFile = buildManagedPassPromptPath(projectRoot, normalizedId);
  return {
    id: normalizedId,
    enabled: options.enabled ?? true,
    description,
    heuristics: options.heuristics,
    runner: options.runner,
    promptFile,
    promptContent: options.promptContent ?? buildPassPrompt(normalizedId, description, options.heuristics),
    managedPrompt: true,
  };
}

export function recommendDiscoveryPasses(analysis: RepoAnalysis): DiscoveryPassDraft[] {
  const frontendPaths = [
    ...existingDir(analysis, ['app', 'frontend', 'web']),
    ...(analysis.topLevelDirs.includes('src') ? ['src'] : []),
    ...(analysis.topLevelDirs.includes('apps') ? ['apps/web'] : []),
  ];
  const backendPaths = existingDir(analysis, ['server', 'backend']) .concat(analysis.topLevelDirs.includes('src') ? ['src/server'] : []);
  const apiPaths = existingDir(analysis, ['api']).concat(analysis.topLevelDirs.includes('app') ? ['app/api'] : [], analysis.topLevelDirs.includes('src') ? ['src/api'] : [], analysis.topLevelDirs.includes('apps') ? ['apps/api'] : []);
  const docsPaths = existingDir(analysis, ['docs']).concat(['README.md']);

  const hasFrontend = frontendPaths.length > 0 || includesAny(analysis.packageDependencies, ['react', 'next', 'vue', 'svelte', 'solid-js']);
  const hasBackend = backendPaths.length > 0 || includesAny(analysis.packageDependencies, ['express', 'fastify', 'koa', 'hono', '@nestjs/core']);
  const hasApi = apiPaths.length > 0 || analysis.packageScripts.some(script => script.includes('api'));
  const hasDocs = docsPaths.length > 0;

  const drafts: DiscoveryPassDraft[] = [];
  if (hasFrontend) {
    drafts.push(makeDraft(
      analysis.projectRoot,
      'frontend',
      'Inspect frontend surfaces, components, interaction flows, and UX polish issues that should become standalone backlog work.',
      { includePaths: frontendPaths, capabilities: ['ui-ux'] },
      DEFAULT_PASS_RUNNERS.frontend,
    ));
  }
  if (hasBackend) {
    drafts.push(makeDraft(
      analysis.projectRoot,
      'backend',
      'Inspect backend services, background jobs, and domain logic for missing cleanup, resilience, or maintainability work.',
      { includePaths: backendPaths, capabilities: ['server', 'domain-logic'] },
      DEFAULT_PASS_RUNNERS.backend,
    ));
  }
  if (hasApi) {
    drafts.push(makeDraft(
      analysis.projectRoot,
      'api',
      'Inspect API routes, contracts, request validation, and integration boundaries for durable backlog-worthy issues.',
      { includePaths: apiPaths, capabilities: ['api'] },
      DEFAULT_PASS_RUNNERS.api,
    ));
  }

  drafts.push(makeDraft(
    analysis.projectRoot,
    'deps',
    'Inspect dependency, build, tooling, and developer workflow issues that should land as deterministic backlog tasks.',
    { includePaths: ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', '.github/'], capabilities: ['tooling', 'dependencies'] },
    DEFAULT_PASS_RUNNERS.deps,
  ));

  if (hasBackend || hasApi) {
    drafts.push(makeDraft(
      analysis.projectRoot,
      'security',
      'Inspect auth, secrets handling, request boundaries, and security-sensitive surfaces for concrete backlog items.',
      { includePaths: [...backendPaths, ...apiPaths], capabilities: ['security'] },
      DEFAULT_PASS_RUNNERS.security,
    ));
  }

  if (hasDocs) {
    drafts.push(makeDraft(
      analysis.projectRoot,
      'docs',
      'Inspect repository docs, onboarding, and operator guidance for gaps that should become standalone backlog work.',
      { includePaths: docsPaths, capabilities: ['documentation'] },
      DEFAULT_PASS_RUNNERS.docs,
    ));
  }

  return drafts;
}

function baseConfigInput(): BacklogRunnerConfigInput {
  return {
    preset: 'balanced',
    validation: 'bash scripts/backlog/validate.sh',
    workspaceBootstrap: {
      repairCommand: 'backlog-runner doctor --repair',
    },
    workspace: {
      workers: 2,
      useWorktrees: true,
    },
    discovery: {
      enabled: true,
      passes: {},
    },
  };
}

function mergeBaseConfig(projectRoot: string, existing: BacklogRunnerConfig | null, passes: DiscoveryPassDraft[]): BacklogRunnerConfig {
  if (existing) {
    return {
      ...existing,
      passes: Object.fromEntries(
        passes.map(pass => [pass.id, {
          id: pass.id,
          kind: 'discovery',
          enabled: pass.enabled,
          description: pass.description,
          promptFile: pass.promptFile,
          runner: pass.runner,
          heuristics: {
            includePaths: [...(pass.heuristics?.includePaths ?? [])],
            excludePaths: [...(pass.heuristics?.excludePaths ?? [])],
            capabilities: [...(pass.heuristics?.capabilities ?? [])],
          },
        }]),
      ),
    };
  }

  return normalizeBacklogRunnerConfig({
    ...baseConfigInput(),
    projectRoot,
    discovery: {
      enabled: true,
      passes: Object.fromEntries(
        passes.map(pass => [pass.id, {
          enabled: pass.enabled,
          description: pass.description,
          promptFile: pass.promptFile,
          runner: pass.runner,
          heuristics: pass.heuristics,
        }]),
      ),
    },
  }, path.join(projectRoot, 'backlog.config.mjs'));
}

function starterValidateScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'echo "backlog-runner starter validation command"',
    'echo "Replace the validation command in backlog.config.mjs with your repo-specific checks."',
    '',
  ].join('\n');
}

function starterModels(): string {
  return JSON.stringify({
    aliases: {
      default: { claude: 'claude-opus-4-6', codex: 'gpt-5.4' },
      sonnet: { claude: 'claude-sonnet-4-6', codex: 'gpt-5.4' },
      opus: { claude: 'claude-opus-4-6', codex: 'gpt-5.4' },
    },
  }, null, 2) + '\n';
}

async function writeFileIfAllowed(filePath: string, content: string, force: boolean): Promise<void> {
  if (!force && await fileExists(filePath)) {
    return;
  }
  await writeFile(filePath, content, 'utf8');
}

async function ensureGitignoreEntries(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = await readTextFileIfExists(gitignorePath);
  if (existing === null) {
    await writeFile(gitignorePath, `${REQUIRED_GITIGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return;
  }

  const lines = existing.split(/\r?\n/);
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter(entry => !lines.includes(entry));
  if (missing.length === 0) {
    return;
  }

  const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  await writeFile(gitignorePath, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

async function buildAgenticSetupContext(projectRoot: string, analysis: RepoAnalysis): Promise<string> {
  const [readme, agents] = await Promise.all([
    readTextFileIfExists(path.join(projectRoot, 'README.md')),
    readTextFileIfExists(path.join(projectRoot, 'AGENTS.md')),
  ]);

  const contextSections = [
    `Top-level directories: ${analysis.topLevelDirs.join(', ') || '(none)'}`,
    `Package scripts: ${analysis.packageScripts.join(', ') || '(none)'}`,
    `Dependencies: ${analysis.packageDependencies.slice(0, 40).join(', ') || '(none)'}`,
  ];

  if (agents?.trim()) {
    contextSections.push(`AGENTS.md:\n${truncateForPrompt(agents.trim(), 4_000)}`);
  }
  if (readme?.trim()) {
    contextSections.push(`README.md:\n${truncateForPrompt(readme.trim(), 6_000)}`);
  }

  return contextSections.join('\n\n');
}

async function selectAgenticSetupRunner(
  commandRunner: CommandRunner,
): Promise<{ tool: BacklogTool; model: string } | null> {
  for (const candidate of AGENTIC_SETUP_RUNNERS) {
    const validation = await validateProvider(candidate.tool, commandRunner, { model: candidate.model });
    if (validation.ok) {
      return candidate;
    }
  }
  return null;
}

async function copyPromptTemplate(sourceName: string, destinationPath: string, force: boolean): Promise<void> {
  if (!force && await fileExists(destinationPath)) {
    return;
  }
  await copyFile(path.join(TEMPLATE_PROMPTS_DIR, sourceName), destinationPath);
}

export async function ensureScaffoldSupportFiles(projectRoot: string, force: boolean): Promise<void> {
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, 'backlog', 'tasks', 'done'), { recursive: true });
  await mkdir(path.join(projectRoot, 'scripts', 'backlog'), { recursive: true });
  await mkdir(path.join(projectRoot, MANAGED_PASSES_DIR), { recursive: true });
  await mkdir(path.join(projectRoot, '.backlog-runner', 'logs'), { recursive: true });

  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'validate.sh'), starterValidateScript(), force);
  await chmod(path.join(projectRoot, 'scripts', 'backlog', 'validate.sh'), 0o755);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'models.json'), starterModels(), force);
  await writeFileIfAllowed(path.join(projectRoot, SCAFFOLD_GUIDE_PATH), backlogScaffoldGuide(), force);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'patterns.md'), '', force);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'progress.txt'), '', force);
  await writeFileIfAllowed(path.join(projectRoot, 'backlog', 'inbox.jsonl'), '', force);
  await ensureGitignoreEntries(projectRoot);
  await copyPromptTemplate('agent.md', path.join(projectRoot, 'scripts', 'backlog', 'agent.md'), force);
  await copyPromptTemplate('planner.md', path.join(projectRoot, 'scripts', 'backlog', 'planner.md'), force);
}

export async function writeManagedPassPrompts(passes: DiscoveryPassDraft[], force = false): Promise<void> {
  for (const pass of passes) {
    if (!pass.managedPrompt) continue;
    await mkdir(path.dirname(pass.promptFile), { recursive: true });
    if (!force && await fileExists(pass.promptFile)) {
      continue;
    }
    await writeFile(pass.promptFile, `${pass.promptContent.trim()}\n`, 'utf8');
  }
}

export function renderPassSummary(passes: DiscoveryPassDraft[]): string {
  if (passes.length === 0) {
    return 'No discovery passes configured.';
  }
  return passes.map(pass => {
    const runner = pass.runner
      ? `explicit ${pass.runner.tool}${pass.runner.model ? ` · ${pass.runner.model}` : ''}`
      : 'planner fallback';
    const includeCount = pass.heuristics?.includePaths?.length ?? 0;
    const excludeCount = pass.heuristics?.excludePaths?.length ?? 0;
    const capabilityCount = pass.heuristics?.capabilities?.length ?? 0;
    const promptOwnership = pass.managedPrompt ? 'managed' : 'custom';
    return [
      `- ${pass.id} (${pass.enabled ? 'enabled' : 'disabled'})`,
      `runner: ${runner}`,
      `prompt: ${promptOwnership}`,
      `heuristics: include ${includeCount} · exclude ${excludeCount} · capabilities ${capabilityCount}`,
      pass.promptFile,
    ].join(' · ');
  }).join('\n');
}

function normalizeDraftFromExisting(projectRoot: string, pass: BacklogPassConfig): DiscoveryPassDraft {
  const managedPrompt = isManagedPassPromptPath(projectRoot, pass.id, pass.promptFile);
  return {
    id: pass.id,
    enabled: pass.enabled,
    description: pass.description,
    runner: pass.runner,
    heuristics: {
      includePaths: [...pass.heuristics.includePaths],
      excludePaths: [...pass.heuristics.excludePaths],
      capabilities: [...pass.heuristics.capabilities],
    },
    promptFile: pass.promptFile,
    promptContent: buildPassPrompt(pass.id, pass.description, pass.heuristics),
    managedPrompt,
  };
}

export async function loadSetupDrafts(configPath: string | null, projectRoot: string, agentic = false, commandRunner: CommandRunner = createCommandRunner()): Promise<{
  existingConfig: BacklogRunnerConfig | null;
  analysis: RepoAnalysis;
  passes: DiscoveryPassDraft[];
  agenticNote?: string;
}> {
  const analysis = await analyzeRepository(projectRoot);
  const existingConfig = configPath && await fileExists(configPath)
    ? await loadBacklogRunnerConfig(configPath)
    : null;

  if (agentic) {
    const proposal = await generateAgenticSetupProposal(projectRoot, analysis, commandRunner);
    if (proposal) {
      return {
        existingConfig,
        analysis,
        passes: proposal.passes,
        agenticNote: proposal.fallbackReason,
      };
    }
  }

  const passes = existingConfig && Object.keys(existingConfig.passes).length > 0
    ? Object.values(existingConfig.passes).map(pass => normalizeDraftFromExisting(projectRoot, pass))
    : recommendDiscoveryPasses(analysis);

  return {
    existingConfig,
    analysis,
    passes,
    agenticNote: agentic ? 'Agentic setup fell back to deterministic recommendations.' : undefined,
  };
}

const AGENTIC_SETUP_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    item: { type: 'string' },
    note: { type: 'string' },
    passes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          include_paths: { type: 'array', items: { type: 'string' } },
          exclude_paths: { type: 'array', items: { type: 'string' } },
          capabilities: { type: 'array', items: { type: 'string' } },
          runner_tool: { type: ['string', 'null'], enum: ['claude', 'codex', null] },
          runner_model: { type: ['string', 'null'] },
        },
        required: ['id', 'description', 'include_paths', 'exclude_paths', 'capabilities', 'runner_tool', 'runner_model'],
        additionalProperties: false,
      },
    },
  },
  required: ['status', 'item', 'note', 'passes'],
  additionalProperties: false,
});

async function generateAgenticSetupProposal(
  projectRoot: string,
  analysis: RepoAnalysis,
  commandRunner: CommandRunner,
): Promise<AgenticSetupProposal | null> {
  const runner = await selectAgenticSetupRunner(commandRunner);
  if (!runner) {
    return {
      passes: recommendDiscoveryPasses(analysis),
      fallbackReason: 'Agentic setup fell back to deterministic recommendations because no supported provider was ready.',
    };
  }

  try {
    const setupContext = await buildAgenticSetupContext(projectRoot, analysis);
    const result = await runProvider(commandRunner, {
      tool: runner.tool,
      model: runner.model,
      cwd: projectRoot,
      maxTurns: 20,
      schema: AGENTIC_SETUP_SCHEMA,
      context: setupContext,
      prompt: [
        'Propose discovery passes for this repository.',
        'Return only supported fields.',
        'Use lowercase kebab-case ids.',
        'Prefer a small pass set that maps cleanly to real repo surfaces or operator concerns.',
        'Do not generate prompt bodies. The runner owns the structured pass prompt template and will derive prompts from the returned metadata.',
        'Focus on normal repo config and prompt files, not custom runtime architecture.',
        'Propose at most 6 passes.',
      ].join('\n'),
    });
    if (result.status !== 'done') {
      return {
        passes: recommendDiscoveryPasses(analysis),
        fallbackReason: `Agentic setup fell back to deterministic recommendations because ${runner.tool} generation failed: ${result.note}`,
      };
    }
    const payload = extractStructuredOutput(result.rawOutput);
    if (!payload || !Array.isArray(payload.passes)) {
      return {
        passes: recommendDiscoveryPasses(analysis),
        fallbackReason: `Agentic setup fell back to deterministic recommendations because the ${runner.tool} proposal payload was invalid.`,
      };
    }

    const passes: DiscoveryPassDraft[] = [];
    for (const rawPass of payload.passes) {
      if (!rawPass || typeof rawPass !== 'object') continue;
      const record = rawPass as Record<string, unknown>;
      const suggestedId = normalizePassId(String(record.id ?? ''));
      if (!suggestedId || !isValidPassId(suggestedId)) continue;
      const id = suggestedId;
      const description = String(record.description ?? '').trim() || `Inspect ${id}-related gaps in this repository.`;
      const runnerTool = record.runner_tool === 'claude' || record.runner_tool === 'codex'
        ? record.runner_tool
        : undefined;
      const runnerModel = typeof record.runner_model === 'string' && record.runner_model.trim()
        ? record.runner_model.trim()
        : undefined;
      passes.push({
        id,
        enabled: true,
        description,
        heuristics: {
          includePaths: Array.isArray(record.include_paths) ? record.include_paths.map(String) : [],
          excludePaths: Array.isArray(record.exclude_paths) ? record.exclude_paths.map(String) : [],
          capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String) : [],
        },
        runner: runnerTool ? { tool: runnerTool, model: runnerModel } : undefined,
        promptFile: buildManagedPassPromptPath(projectRoot, id),
        promptContent: buildPassPrompt(id, description, {
          includePaths: Array.isArray(record.include_paths) ? record.include_paths.map(String) : [],
          excludePaths: Array.isArray(record.exclude_paths) ? record.exclude_paths.map(String) : [],
          capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String) : [],
        }),
        managedPrompt: true,
      });
    }

    return {
      passes: passes.length > 0 ? passes : recommendDiscoveryPasses(analysis),
      fallbackReason: passes.length > 0 ? `Agentic setup drafted passes with ${runner.tool}.` : `Agentic setup returned no usable passes from ${runner.tool}; deterministic recommendations were used instead.`,
    };
  } catch {
    return {
      passes: recommendDiscoveryPasses(analysis),
      fallbackReason: 'Agentic setup fell back to deterministic recommendations because proposal generation errored.',
    };
  }
}

export async function applySetupResult(
  configPath: string,
  projectRoot: string,
  existingConfig: BacklogRunnerConfig | null,
  passes: DiscoveryPassDraft[],
  options: { forceScaffold?: boolean } = {},
): Promise<BacklogRunnerConfig> {
  await ensureScaffoldSupportFiles(projectRoot, options.forceScaffold ?? false);
  await writeManagedPassPrompts(passes, true);
  const config = mergeBaseConfig(projectRoot, existingConfig, passes);
  await writeBacklogRunnerConfig(configPath, config);
  await syncBacklogRunner(config);
  return config;
}

export async function addPassToConfig(configPath: string, config: BacklogRunnerConfig, draft: DiscoveryPassDraft): Promise<BacklogRunnerConfig> {
  if (config.passes[draft.id]) {
    throw new Error(`Pass '${draft.id}' already exists.`);
  }
  await writeManagedPassPrompts([draft], false);
  const nextConfig = mergeBaseConfig(config.projectRoot, config, [
    ...Object.values(config.passes).map(pass => normalizeDraftFromExisting(config.projectRoot, pass)),
    draft,
  ]);
  await writeBacklogRunnerConfig(configPath, nextConfig);
  return nextConfig;
}

export async function removePassFromConfig(configPath: string, config: BacklogRunnerConfig, passId: string): Promise<BacklogRunnerConfig> {
  const existing = config.passes[passId];
  if (!existing) {
    throw new Error(`Pass '${passId}' does not exist.`);
  }
  const remaining = Object.values(config.passes)
    .filter(pass => pass.id !== passId)
    .map(pass => normalizeDraftFromExisting(config.projectRoot, pass));
  const nextConfig = mergeBaseConfig(config.projectRoot, config, remaining);
  await writeBacklogRunnerConfig(configPath, nextConfig);

  const managedPromptPath = buildManagedPassPromptPath(config.projectRoot, passId);
  if (path.resolve(existing.promptFile) === path.resolve(managedPromptPath)) {
    await rm(existing.promptFile, { force: true });
  }
  return nextConfig;
}

export async function setPassEnabled(configPath: string, config: BacklogRunnerConfig, passId: string, enabled: boolean): Promise<BacklogRunnerConfig> {
  const drafts = Object.values(config.passes).map(pass => normalizeDraftFromExisting(config.projectRoot, pass));
  const target = drafts.find(pass => pass.id === passId);
  if (!target) {
    throw new Error(`Pass '${passId}' does not exist.`);
  }
  target.enabled = enabled;
  const nextConfig = mergeBaseConfig(config.projectRoot, config, drafts);
  await writeBacklogRunnerConfig(configPath, nextConfig);
  return nextConfig;
}
