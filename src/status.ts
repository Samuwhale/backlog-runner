import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureConfigReady } from './config.js';
import { createFileBackedTaskStore } from './store/task-store.js';
import type { BacklogQueueCounts, BacklogRunnerConfig, OrchestratorRuntimeStatus } from './types.js';
import { isPidAlive } from './utils.js';

export interface BacklogRunnerStatus {
  counts: BacklogQueueCounts;
  orchestrator: OrchestratorRuntimeStatus | null;
  files: {
    backlog: string;
    runtimeReport: string;
    candidateQueue: string;
    candidateRejectLog: string;
  };
  sections: {
    activeLeases: string[];
    activeReservations: string[];
    activeTaskProgress: string[];
    plannerCandidates: string[];
    otherBlockages: string[];
  };
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function readMarkdownSection(markdown: string, heading: string): string[] {
  const lines = splitLines(markdown);
  const headingLine = `## ${heading}`;
  const start = lines.findIndex(line => line.trim() === headingLine);
  if (start === -1) return [];

  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim()) continue;
    section.push(line);
  }
  return section;
}

async function readOrchestratorStatus(config: BacklogRunnerConfig): Promise<OrchestratorRuntimeStatus | null> {
  try {
    const content = await readFile(path.join(config.files.runtimeDir, 'orchestrator-status.json'), 'utf8');
    const status = JSON.parse(content) as OrchestratorRuntimeStatus;
    return isPidAlive(status.pid) ? status : null;
  } catch {
    return null;
  }
}

export async function readBacklogRunnerStatus(config: BacklogRunnerConfig): Promise<BacklogRunnerStatus> {
  await ensureConfigReady(config);
  const store = createFileBackedTaskStore(config);

  try {
    const counts = await store.getQueueCounts();
    const [orchestrator, runtimeReport] = await Promise.all([
      readOrchestratorStatus(config),
      readFile(config.files.runtimeReport, 'utf8').catch(() => ''),
    ]);

    return {
      counts,
      orchestrator,
      files: {
        backlog: config.files.backlog,
        runtimeReport: config.files.runtimeReport,
        candidateQueue: config.files.candidateQueue,
        candidateRejectLog: config.files.candidateRejectLog,
      },
      sections: {
        activeLeases: readMarkdownSection(runtimeReport, 'Active Leases'),
        activeReservations: readMarkdownSection(runtimeReport, 'Active Reservations'),
        activeTaskProgress: readMarkdownSection(runtimeReport, 'Active Task Progress'),
        plannerCandidates: readMarkdownSection(runtimeReport, 'Planner Candidates Awaiting Refinement'),
        otherBlockages: readMarkdownSection(runtimeReport, 'Other Blockages'),
      },
    };
  } finally {
    await store.close();
  }
}
