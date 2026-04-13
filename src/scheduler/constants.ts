export const PLANNER_LANE_READY_TARGET = 2;
export const ORCHESTRATOR_POLL_INTERVAL_MS = 3_000;
export const EMPTY_QUEUE_POLL_INTERVAL_MS = 30_000;
export const RECONCILIATION_MAX_TURNS = 60;
export const PREFLIGHT_DEFERRAL_MS = 15 * 60 * 1000;
export const PLANNER_NO_PROGRESS_COOLDOWN_MS = 15_000;
export const RATE_LIMIT_BACKOFF_MS = 60_000;

export const REPO_PATH_PATTERN =
  /\b((?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)?)\b/g;
export const PACKAGE_RELATIVE_SRC_PATH_PATTERN = /\bsrc\/[^:\s|)]+/g;
export const MODULE_RESOLUTION_ERROR_PATTERNS = [
  /Failed to load url\b/i,
  /\bCannot find module\b/i,
  /\bERR_MODULE_NOT_FOUND\b/i,
  /\bMODULE_NOT_FOUND\b/i,
  /\bDoes the file exist\?\b/i,
];
export const WORKTREE_LOCATION_PATTERNS = [
  /(?:^|[^\w])\/tmp\//i,
  /\/private\/var\//i,
  /\/var\/folders\//i,
  /\bworktree\b/i,
];
export const BOOTSTRAP_MARKER_PATTERNS = [
  /\bvirtualStoreDir\b/i,
  /\b\.pnpm\b/i,
  /\bbootstrap\b/i,
  /\bhoist(?:ed|ing)?\b/i,
];
