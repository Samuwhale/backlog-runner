import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBacklogRunnerConfig } from './config.js';
import { syncBacklogRunner } from './scheduler/index.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_PROMPTS_DIR = path.join(PACKAGE_ROOT, 'templates', 'default', 'prompts');

export type InitBacklogRunnerOptions = {
  cwd?: string;
  force?: boolean;
};

const PROMPT_FILES = [
  'agent.md',
  'planner.md',
  'product.md',
  'interface.md',
  'ux.md',
  'code.md',
] as const;

function starterConfig(): string {
  return [
    "import { defineBacklogRunnerConfig } from 'backlog-runner';",
    '',
    'export default defineBacklogRunnerConfig({',
    "  projectRoot: '.',",
    '  files: {',
    "    backlog: './backlog.md',",
    "    candidateQueue: './backlog/inbox.jsonl',",
    "    candidateRejectLog: './.backlog-runner/candidate-rejections.jsonl',",
    "    taskSpecsDir: './backlog/tasks',",
    "    stop: './backlog-stop',",
    "    runtimeReport: './.backlog-runner/runtime-report.md',",
    "    patterns: './scripts/backlog/patterns.md',",
    "    progress: './scripts/backlog/progress.txt',",
    "    stateDb: './.backlog-runner/state.sqlite',",
    "    models: './scripts/backlog/models.json',",
    "    runnerLogDir: './.backlog-runner/logs',",
    "    runtimeDir: './.backlog-runner',",
    '  },',
    '  prompts: {',
    "    agent: './scripts/backlog/agent.md',",
    "    planner: './scripts/backlog/planner.md',",
    "    product: './scripts/backlog/product.md',",
    "    interface: './scripts/backlog/interface.md',",
    "    ux: './scripts/backlog/ux.md',",
    "    code: './scripts/backlog/code.md',",
    '  },',
    "  validationCommand: 'bash scripts/backlog/validate.sh',",
    '  validationProfiles: {',
    "    repo: 'bash scripts/backlog/validate.sh',",
    '  },',
    '  heuristics: {',
    "    backlogRuntimePaths: ['backlog/', '.backlog-runner/', 'scripts/backlog/'],",
    "    uiPathPrefixes: ['src/ui/', 'src/components/', 'src/routes/', 'src/pages/', 'app/', 'apps/web/', 'frontend/', 'web/'],",
    '    validationProfileRules: [',
    "      // Example: { profile: 'frontend', pathPrefixes: ['apps/web/', 'src/components/'] },",
    '    ],',
    '  },',
    '  workspaceBootstrap: {',
    "    repairCommand: 'backlog-runner doctor --repair',",
    '  },',
    '  runners: {',
    "    taskUi: { tool: 'claude', model: 'claude-opus-4-6' },",
    "    taskCode: { tool: 'codex', model: 'gpt-5.4' },",
    "    planner: { tool: 'codex', model: 'gpt-5.4' },",
    "    product: { tool: 'codex', model: 'gpt-5.4' },",
    "    interface: { tool: 'claude', model: 'claude-opus-4-6' },",
    "    ux: { tool: 'claude', model: 'claude-opus-4-6' },",
    "    code: { tool: 'codex', model: 'gpt-5.4' },",
    '  },',
    '  defaults: {',
    '    workers: 2,',
    '    passes: true,',
    '    worktrees: true,',
    '  },',
    '});',
    '',
  ].join('\n');
}

function starterValidateScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'echo "backlog-runner starter validation command"',
    'echo "Replace scripts/backlog/validate.sh and validationProfiles in backlog.config.mjs with your repo-specific checks."',
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
  try {
    if (!force) {
      await readFile(filePath, 'utf8');
      return;
    }
  } catch {
    // File does not exist yet.
  }
  await writeFile(filePath, content, 'utf8');
}

async function copyPromptTemplates(targetDir: string, force: boolean): Promise<void> {
  for (const promptFile of PROMPT_FILES) {
    const source = path.join(TEMPLATE_PROMPTS_DIR, promptFile);
    const destination = path.join(targetDir, promptFile);
    try {
      if (!force) {
        await readFile(destination, 'utf8');
        continue;
      }
    } catch {
      // Destination does not exist yet.
    }
    await copyFile(source, destination);
  }
}

export async function initBacklogRunner(targetDir: string, options: InitBacklogRunnerOptions = {}): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = path.resolve(cwd, targetDir);
  const force = options.force ?? false;

  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, 'backlog', 'tasks', 'done'), { recursive: true });
  await mkdir(path.join(projectRoot, 'scripts', 'backlog'), { recursive: true });
  await mkdir(path.join(projectRoot, '.backlog-runner', 'logs'), { recursive: true });

  await writeFileIfAllowed(path.join(projectRoot, 'backlog.config.mjs'), starterConfig(), force);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'validate.sh'), starterValidateScript(), force);
  await chmod(path.join(projectRoot, 'scripts', 'backlog', 'validate.sh'), 0o755);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'models.json'), starterModels(), force);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'patterns.md'), '', force);
  await writeFileIfAllowed(path.join(projectRoot, 'scripts', 'backlog', 'progress.txt'), '', force);
  await writeFileIfAllowed(path.join(projectRoot, 'backlog', 'inbox.jsonl'), '', force);
  await writeFileIfAllowed(path.join(projectRoot, '.gitignore'), ['.backlog-runner/state.sqlite', '.backlog-runner/logs/', 'backlog-stop', ''].join('\n'), false);
  await copyPromptTemplates(path.join(projectRoot, 'scripts', 'backlog'), force);

  const config = await loadBacklogRunnerConfig(path.join(projectRoot, 'backlog.config.mjs'));
  await syncBacklogRunner(config);

  return [
    `Initialized backlog-runner scaffold in ${projectRoot}`,
    'Edit backlog.config.mjs to point validation profiles at your real repo checks.',
    'Review scripts/backlog/*.md and adjust the prompts to match your team workflow if needed.',
  ];
}
