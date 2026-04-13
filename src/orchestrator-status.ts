import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isPidAlive } from './utils.js';
import type { OrchestratorRuntimeStatus } from './types.js';

export const ORCHESTRATOR_STATUS_FILE = 'orchestrator-status.json';
export const ORCHESTRATOR_STATUS_STALE_MULTIPLIER = 5;
export const ORCHESTRATOR_STATUS_MIN_FRESHNESS_MS = 30_000;

export function orchestratorStatusIsFresh(status: OrchestratorRuntimeStatus): boolean {
  const updatedAtMs = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  const freshnessWindow = Math.max(
    ORCHESTRATOR_STATUS_MIN_FRESHNESS_MS,
    status.pollIntervalMs * ORCHESTRATOR_STATUS_STALE_MULTIPLIER,
  );
  return Date.now() - updatedAtMs <= freshnessWindow;
}

export function isOrchestratorStatusLive(status: OrchestratorRuntimeStatus): boolean {
  return isPidAlive(status.pid) && orchestratorStatusIsFresh(status);
}

export async function readOrchestratorStatus(runtimeDir: string): Promise<OrchestratorRuntimeStatus | null> {
  try {
    const content = await readFile(path.join(runtimeDir, ORCHESTRATOR_STATUS_FILE), 'utf8');
    return JSON.parse(content) as OrchestratorRuntimeStatus;
  } catch {
    return null;
  }
}

export async function readLiveOrchestratorStatus(runtimeDir: string): Promise<OrchestratorRuntimeStatus | null> {
  const status = await readOrchestratorStatus(runtimeDir);
  return status && isOrchestratorStatusLive(status) ? status : null;
}
