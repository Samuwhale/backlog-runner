import { isPidAlive } from './utils.js';
import type { OrchestratorRuntimeStatus } from './types.js';

export const ORCHESTRATOR_STATUS_STALE_MULTIPLIER = 3;
export const ORCHESTRATOR_STATUS_MIN_FRESHNESS_MS = 5_000;

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
