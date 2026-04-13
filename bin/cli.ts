#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import { promptForStartOverrides, shouldPromptInteractively } from './interactive.js';
import {
  parseCliCommand,
  renderCommandHelp,
  renderTopLevelHelp,
  resolveCommand,
  suggestCommand,
  type CliCommandName,
} from './command-helpers.js';
import { loadBacklogRunnerConfig } from '../src/config.js';
import { initBacklogRunner } from '../src/init.js';
import { LiveOrchestratorError, runBacklogRunner, syncBacklogRunner } from '../src/scheduler/index.js';
import { readBacklogRunnerStatus } from '../src/status.js';
import { validateBacklogRunner } from '../src/validate.js';
import type { BacklogRunnerConfig, BacklogSyncResult, RunOverrides, ToolValidationResult } from '../src/types.js';
import type { BacklogRunnerStatus } from '../src/status.js';
import type { ValidateOptions } from '../src/validate.js';

type CliWriter = {
  write(chunk: string): void;
};

type CliDependencies = {
  cwd: () => string;
  isInteractive: () => boolean;
  confirmLiveOrchestratorTakeover: (error: LiveOrchestratorError) => Promise<boolean>;
  initBacklogRunner: (targetDir: string, options?: { cwd?: string; force?: boolean }) => Promise<string[]>;
  loadConfig: (configPath: string) => Promise<BacklogRunnerConfig>;
  runBacklogRunner: (config: BacklogRunnerConfig, overrides: RunOverrides) => Promise<void>;
  syncBacklogRunner: (config: BacklogRunnerConfig) => Promise<BacklogSyncResult>;
  validateBacklogRunner: (config: BacklogRunnerConfig, overrides: RunOverrides, options?: ValidateOptions) => Promise<ToolValidationResult>;
  readBacklogRunnerStatus: (config: BacklogRunnerConfig) => Promise<BacklogRunnerStatus>;
};

async function confirmLiveOrchestratorTakeover(error: LiveOrchestratorError): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    output.write(`${error.message}\n`);
    const answer = (await rl.question('Type "takeover" to stop the existing orchestrator and continue, or press Enter to cancel: ')).trim().toLowerCase();
    return answer === 'takeover' || answer === 't';
  } finally {
    rl.close();
  }
}

const defaultDependencies: CliDependencies = {
  cwd: () => process.cwd(),
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirmLiveOrchestratorTakeover,
  initBacklogRunner,
  loadConfig: loadBacklogRunnerConfig,
  runBacklogRunner,
  syncBacklogRunner,
  validateBacklogRunner: (config, overrides, options) => validateBacklogRunner(config, overrides, {}, options),
  readBacklogRunnerStatus,
};

function writeLine(writer: CliWriter, value = ''): void {
  writer.write(`${value}\n`);
}

function renderQueueCounts(counts: BacklogRunnerStatus['counts']): string {
  return `Queue: ${counts.ready} ready · ${counts.blocked} blocked · ${counts.planned} planned · ${counts.inProgress} in-progress · ${counts.failed} failed · ${counts.done} done`;
}

function renderVerboseSection(writer: CliWriter, title: string, lines: string[]): void {
  writeLine(writer, title);
  if (lines.length === 0) {
    writeLine(writer, '- None');
  } else {
    for (const line of lines) {
      writeLine(writer, line);
    }
  }
  writeLine(writer);
}

function renderStatus(writer: CliWriter, status: BacklogRunnerStatus, verbose: boolean): void {
  writeLine(writer, 'Backlog Runner Status');
  writeLine(writer);
  writeLine(writer, renderQueueCounts(status.counts));
  writeLine(writer);

  if (status.orchestrator) {
    const orchestrator = status.orchestrator;
    writeLine(writer, `Orchestrator: running (${orchestrator.orchestratorId})`);
    writeLine(writer, `Workers: ${orchestrator.requestedWorkers} requested · ${orchestrator.effectiveWorkers} effective`);
    writeLine(
      writer,
      `Active task workers: ${orchestrator.activeTaskWorkers.length === 0 ? 'none' : orchestrator.activeTaskWorkers.map(worker => `${worker.title} (${worker.taskId})`).join(' · ')}`,
    );
    writeLine(
      writer,
      `Active control worker: ${orchestrator.activeControlWorker ? orchestrator.activeControlWorker.kind === 'discovery' ? `discovery${orchestrator.activeControlWorker.passType ? `:${orchestrator.activeControlWorker.passType}` : ''}` : 'planner' : 'none'}`,
    );
  } else {
    writeLine(writer, 'Orchestrator: idle');
    writeLine(writer, 'Workers: no active orchestrator');
    writeLine(writer, 'Active task workers: none');
    writeLine(writer, 'Active control worker: none');
  }

  writeLine(writer);
  writeLine(writer, 'Files');
  writeLine(writer, `  Backlog report: ${status.files.backlog}`);
  writeLine(writer, `  Runtime report: ${status.files.runtimeReport}`);
  writeLine(writer, `  Candidate queue: ${status.files.candidateQueue}`);
  writeLine(writer, `  Candidate rejects: ${status.files.candidateRejectLog}`);

  if (!verbose) {
    return;
  }

  writeLine(writer);
  renderVerboseSection(writer, 'Active leases', status.sections.activeLeases);
  renderVerboseSection(writer, 'Active reservations', status.sections.activeReservations);
  renderVerboseSection(writer, 'Active task progress', status.sections.activeTaskProgress);
  renderVerboseSection(writer, 'Planner candidates awaiting refinement', status.sections.plannerCandidates);
  renderVerboseSection(writer, 'Other blockages', status.sections.otherBlockages);
}

function renderCommandSuggestion(raw: string): string {
  const suggestion = suggestCommand(raw);
  if (!suggestion) {
    return `Unknown command '${raw}'.`;
  }
  return `Unknown command '${raw}'. Did you mean '${suggestion}'?`;
}

export async function runCli(
  argv: string[],
  io: { stdout?: CliWriter; stderr?: CliWriter } = {},
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const deps: CliDependencies = { ...defaultDependencies, ...dependencies };

  try {
    const [firstArg, ...restArgs] = argv;

    if (!firstArg) {
      stderr.write(renderTopLevelHelp());
      return 1;
    }

    if (firstArg === '--help' || firstArg === '-h') {
      stdout.write(renderTopLevelHelp());
      return 0;
    }

    const command = resolveCommand(firstArg);
    if (!command) {
      writeLine(stderr, renderCommandSuggestion(firstArg));
      writeLine(stderr);
      stderr.write(renderTopLevelHelp());
      return 1;
    }

    if (restArgs.includes('--help') || restArgs.includes('-h')) {
      stdout.write(renderCommandHelp(command));
      return 0;
    }

    const parsed = await parseCliCommand(command, restArgs, deps.cwd());

    if (parsed.command === 'init') {
      const messages = await deps.initBacklogRunner(parsed.targetDir, {
        cwd: deps.cwd(),
        force: parsed.force,
      });
      for (const message of messages) {
        writeLine(stdout, message);
      }
      return 0;
    }

    const config = await deps.loadConfig(parsed.configPath);

    if (parsed.command === 'sync') {
      const result = await deps.syncBacklogRunner(config);
      writeLine(stdout, 'Backlog sync complete');
      writeLine(stdout);
      if (result.candidates.drained) {
        writeLine(stdout, `Candidate planner: ${result.candidates.createdTasks} created · ${result.candidates.skippedDuplicates} duplicates · ${result.candidates.ignoredInvalidLines} invalid`);
      }
      writeLine(stdout, renderQueueCounts(result.counts));
      return 0;
    }

    if (parsed.command === 'doctor') {
      const result = await deps.validateBacklogRunner(config, parsed.overrides, {
        repairSharedInstall: parsed.repair,
      });
      writeLine(stdout, 'Backlog runner doctor');
      writeLine(stdout);
      for (const message of result.messages) {
        writeLine(stdout, message);
      }
      return result.ok ? 0 : 1;
    }

    if (parsed.command === 'status') {
      const status = await deps.readBacklogRunnerStatus(config);
      renderStatus(stdout, status, parsed.verbose);
      return 0;
    }

    let overrides = parsed.overrides;
    if (shouldPromptInteractively('start', overrides, { yes: parsed.yes }) && deps.isInteractive()) {
      overrides = await promptForStartOverrides(config, overrides);
    }
    try {
      await deps.runBacklogRunner(config, overrides);
    } catch (error) {
      const canPromptForTakeover = (
        error instanceof LiveOrchestratorError
        && deps.isInteractive()
        && !parsed.yes
        && !overrides.takeover
      );
      if (!canPromptForTakeover) {
        throw error;
      }
      const confirmedTakeover = await deps.confirmLiveOrchestratorTakeover(error);
      if (!confirmedTakeover) {
        throw error;
      }
      await deps.runBacklogRunner(config, { ...overrides, takeover: true });
    }
    return 0;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
