import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import {
  addPassToConfig,
  applySetupResult,
  createManagedDiscoveryPassDraft,
  buildManagedPassPromptPath,
  loadSetupDrafts,
  renderPassSummary,
  removePassFromConfig,
  setPassEnabled,
  type DiscoveryPassDraft,
} from '../src/setup.js';
import { isValidPassId } from '../src/config.js';
import { loadBacklogRunnerConfig } from '../src/config.js';
import type { BacklogRunnerConfig, BacklogTool } from '../src/types.js';
import { fileExists } from '../src/utils.js';

export interface SetupPrompter {
  question(prompt: string): Promise<string>;
  write(message: string): void;
  close(): void;
}

function parseYesNoAnswer(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  return fallback;
}

function parseTool(value: string, fallback?: BacklogTool): BacklogTool | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'claude' || normalized === 'codex') {
    return normalized;
  }
  return fallback;
}

function parseRunnerTool(value: string, fallback?: BacklogTool): BacklogTool | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'planner' || normalized === 'fallback' || normalized === 'none') {
    return undefined;
  }
  return parseTool(value, fallback);
}

function parseOwnedTextAnswer(value: string, current?: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return current;
  if (trimmed === '-') return undefined;
  return trimmed;
}

function parseListAnswer(value: string, current: string[] = []): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [...current];
  if (trimmed === '-') return [];
  return [...new Set(trimmed.split(',').map(item => item.trim()).filter(Boolean))];
}

function parsePromptOwnership(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'managed' || normalized === 'm') return true;
  if (normalized === 'custom' || normalized === 'c') return false;
  return fallback;
}

function toDisplayPath(projectRoot: string, targetPath: string): string {
  const relative = path.relative(projectRoot, targetPath);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative ? `./${relative.split(path.sep).join('/')}` : '.';
  }
  return targetPath;
}

function defaultCustomPromptPath(projectRoot: string, passId: string): string {
  return buildManagedPassPromptPath(projectRoot, `${passId}.custom`);
}

function cloneDraft(pass: DiscoveryPassDraft): DiscoveryPassDraft {
  return {
    ...pass,
    runner: pass.runner ? { ...pass.runner } : undefined,
    heuristics: {
      includePaths: [...(pass.heuristics?.includePaths ?? [])],
      excludePaths: [...(pass.heuristics?.excludePaths ?? [])],
      capabilities: [...(pass.heuristics?.capabilities ?? [])],
    },
  };
}

function restoreManagedPrompt(pass: DiscoveryPassDraft, projectRoot: string): void {
  const regenerated = createManagedDiscoveryPassDraft(projectRoot, pass.id, {
    description: pass.description,
    enabled: pass.enabled,
    runner: pass.runner,
    heuristics: pass.heuristics,
  });
  pass.promptFile = regenerated.promptFile;
  pass.promptContent = regenerated.promptContent;
  pass.managedPrompt = true;
}

function arraysEqual(left: string[] = [], right: string[] = []): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function createSetupPrompter(): SetupPrompter {
  const rl = createInterface({ input, output });
  return {
    question: prompt => rl.question(prompt),
    write: message => output.write(message),
    close: () => rl.close(),
  };
}

function renderSetupIntro(existingConfig: BacklogRunnerConfig | null, passes: DiscoveryPassDraft[], agenticNote?: string): string {
  return [
    'Discovery pass setup',
    '',
    existingConfig ? 'Existing config detected.' : 'No config found. A new config will be created.',
    agenticNote ?? '',
    '',
    renderPassSummary(passes),
    '',
  ].filter(Boolean).join('\n');
}

function assertValidPassId(value: string): string {
  const trimmed = value.trim();
  if (!isValidPassId(trimmed)) {
    throw new Error(`Invalid pass id: ${value}. Pass ids must be lowercase kebab-case.`);
  }
  return trimmed;
}

async function promptForPassConfiguration(
  projectRoot: string,
  pass: DiscoveryPassDraft,
  prompter: SetupPrompter,
): Promise<void> {
  const original = cloneDraft(pass);
  prompter.write(`${pass.id}\n`);

  const enableAnswer = await prompter.question(`  Enable this pass? [Y/n] (${pass.enabled ? 'yes' : 'no'}): `);
  pass.enabled = parseYesNoAnswer(enableAnswer, pass.enabled);

  const descriptionAnswer = await prompter.question(`  Description (${pass.description ?? 'none'}; '-' clears): `);
  pass.description = parseOwnedTextAnswer(descriptionAnswer, pass.description);

  const toolAnswer = await prompter.question(
    `  Runner tool (${pass.runner?.tool ?? 'planner fallback'}; claude/codex/planner): `,
  );
  const tool = parseRunnerTool(toolAnswer, pass.runner?.tool);
  if (tool) {
    const previousModel = pass.runner?.tool === tool ? pass.runner?.model : undefined;
    const modelAnswer = await prompter.question(
      `  Runner model (${previousModel ?? 'provider default'}; '-' clears): `,
    );
    pass.runner = {
      tool,
      model: parseOwnedTextAnswer(modelAnswer, previousModel),
    };
  } else {
    pass.runner = undefined;
  }

  const heuristics = {
    includePaths: [...(pass.heuristics?.includePaths ?? [])],
    excludePaths: [...(pass.heuristics?.excludePaths ?? [])],
    capabilities: [...(pass.heuristics?.capabilities ?? [])],
  };
  const includeAnswer = await prompter.question(
    `  Include path hints (${heuristics.includePaths.join(', ') || 'none'}; comma-separated, '-' clears): `,
  );
  heuristics.includePaths = parseListAnswer(includeAnswer, heuristics.includePaths);
  const excludeAnswer = await prompter.question(
    `  Exclude path hints (${heuristics.excludePaths.join(', ') || 'none'}; comma-separated, '-' clears): `,
  );
  heuristics.excludePaths = parseListAnswer(excludeAnswer, heuristics.excludePaths);
  const capabilitiesAnswer = await prompter.question(
    `  Capability hints (${heuristics.capabilities.join(', ') || 'none'}; comma-separated, '-' clears): `,
  );
  heuristics.capabilities = parseListAnswer(capabilitiesAnswer, heuristics.capabilities);
  pass.heuristics = heuristics;

  const ownershipAnswer = await prompter.question(
    `  Prompt ownership (${pass.managedPrompt ? 'managed' : 'custom'}; managed/custom): `,
  );
  const managedPrompt = parsePromptOwnership(ownershipAnswer, pass.managedPrompt);
  if (managedPrompt) {
    pass.managedPrompt = true;
    pass.promptFile = buildManagedPassPromptPath(projectRoot, pass.id);
  } else {
    const suggestedPath = pass.managedPrompt ? defaultCustomPromptPath(projectRoot, pass.id) : pass.promptFile;
    const customPathAnswer = await prompter.question(
      `  Custom prompt path (${toDisplayPath(projectRoot, suggestedPath)}): `,
    );
    const nextPromptPath = parseOwnedTextAnswer(customPathAnswer, toDisplayPath(projectRoot, suggestedPath))
      ?? toDisplayPath(projectRoot, suggestedPath);
    pass.managedPrompt = false;
    pass.promptFile = path.resolve(projectRoot, nextPromptPath);
  }

  const descriptionChanged = original.description !== pass.description;
  const includeChanged = !arraysEqual(original.heuristics?.includePaths, pass.heuristics.includePaths);
  const excludeChanged = !arraysEqual(original.heuristics?.excludePaths, pass.heuristics.excludePaths);
  const capabilitiesChanged = !arraysEqual(original.heuristics?.capabilities, pass.heuristics.capabilities);
  const becameManaged = !original.managedPrompt && pass.managedPrompt;
  if (pass.managedPrompt && (descriptionChanged || includeChanged || excludeChanged || capabilitiesChanged || becameManaged)) {
    restoreManagedPrompt(pass, projectRoot);
  }

  prompter.write('\n');
}

async function promptForCustomPass(
  projectRoot: string,
  passId: string,
  prompter: SetupPrompter,
): Promise<DiscoveryPassDraft> {
  const pass = createManagedDiscoveryPassDraft(projectRoot, passId);
  await promptForPassConfiguration(projectRoot, pass, prompter);
  return pass;
}

export async function promptForSetupPasses(
  projectRoot: string,
  initialPasses: DiscoveryPassDraft[],
  prompter: SetupPrompter = createSetupPrompter(),
): Promise<DiscoveryPassDraft[]> {
  try {
    const passes: DiscoveryPassDraft[] = initialPasses.map(cloneDraft);
    prompter.write(renderPassSummary(passes) + '\n\n');

    for (const pass of passes) {
      await promptForPassConfiguration(projectRoot, pass, prompter);
    }

    const customPassIds = (await prompter.question('Additional custom pass ids (comma-separated, blank for none): '))
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    const invalidPassIds = customPassIds.filter(id => !isValidPassId(id));
    if (invalidPassIds.length > 0) {
      throw new Error(`Invalid pass ids: ${invalidPassIds.join(', ')}. Pass ids must be lowercase kebab-case.`);
    }
    const uniqueCustomPassIds = customPassIds
      .filter(Boolean)
      .filter(id => !passes.some(pass => pass.id === id));

    for (const passId of uniqueCustomPassIds) {
      passes.push(await promptForCustomPass(projectRoot, passId, prompter));
    }

    prompter.write('\nFinal pass summary\n');
    prompter.write(renderPassSummary(passes) + '\n');
    const confirm = await prompter.question('Apply this setup? [Y/n]: ');
    if (!parseYesNoAnswer(confirm, true)) {
      throw new Error('Cancelled.');
    }
    return passes;
  } finally {
    prompter.close();
  }
}

export async function runSetupCommand(
  configPath: string,
  cwd: string,
  options: { yes: boolean; agentic: boolean },
): Promise<string[]> {
  const absoluteConfigPath = path.resolve(configPath || path.join(cwd, 'backlog.config.mjs'));
  const preloadedConfig = await fileExists(absoluteConfigPath)
    ? await loadBacklogRunnerConfig(absoluteConfigPath)
    : null;
  const projectRoot = preloadedConfig?.projectRoot ?? path.resolve(cwd);
  const { existingConfig, passes, agenticNote } = await loadSetupDrafts(
    absoluteConfigPath,
    projectRoot,
    options.agentic,
  );

  if (!options.yes) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('Setup requires a TTY unless you pass --yes.');
    }
    output.write(renderSetupIntro(existingConfig, passes, agenticNote));
  }

  const selectedPasses = options.yes ? passes : await promptForSetupPasses(projectRoot, passes);
  const config = await applySetupResult(absoluteConfigPath, projectRoot, existingConfig, selectedPasses, {
    forceScaffold: false,
  });

  return [
    `Wrote ${absoluteConfigPath}`,
    `Configured ${Object.keys(config.passes).length} discovery pass${Object.keys(config.passes).length === 1 ? '' : 'es'}.`,
  ];
}

export function renderPassList(config: BacklogRunnerConfig): string[] {
  const passes = Object.values(config.passes);
  if (passes.length === 0) {
    return ['No discovery passes configured.'];
  }
  return passes.map(pass => {
    const runner = pass.runner ? `${pass.runner.tool}${pass.runner.model ? ` · ${pass.runner.model}` : ''}` : 'planner fallback';
    return `${pass.id} · ${pass.enabled ? 'enabled' : 'disabled'} · ${runner} · ${pass.promptFile}`;
  });
}

export async function runPassCommand(
  configPath: string,
  config: BacklogRunnerConfig,
  action: 'list' | 'add' | 'remove' | 'enable' | 'disable',
  passId?: string,
): Promise<string[]> {
  if (action === 'list') {
    return renderPassList(config);
  }

  const normalizedId = assertValidPassId(passId ?? '');

  if (action === 'add') {
    const nextConfig = await addPassToConfig(configPath, config, createManagedDiscoveryPassDraft(config.projectRoot, normalizedId));
    return [`Added pass '${normalizedId}'.`, ...renderPassList(nextConfig)];
  }
  if (action === 'remove') {
    const nextConfig = await removePassFromConfig(configPath, config, normalizedId);
    return [`Removed pass '${normalizedId}'.`, ...renderPassList(nextConfig)];
  }
  if (action === 'enable') {
    const nextConfig = await setPassEnabled(configPath, config, normalizedId, true);
    return [`Enabled pass '${normalizedId}'.`, ...renderPassList(nextConfig)];
  }

  const nextConfig = await setPassEnabled(configPath, config, normalizedId, false);
  return [`Disabled pass '${normalizedId}'.`, ...renderPassList(nextConfig)];
}
