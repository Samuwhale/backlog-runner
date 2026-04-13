import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  BacklogTaskClaim,
  BacklogTaskLease,
  BacklogTaskSpec,
  TaskBlockage,
  TaskActivitySnapshot,
  TaskLeaseSnapshot,
  TaskReservationSnapshot,
} from './types.js';
import { isPidAlive } from './utils.js';

const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;

type RuntimePruneResult = {
  deadRunnerLeases: number;
  expiredLeases: number;
  expiredDeferrals: number;
};

type RuntimeStatement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type RuntimeDatabase = {
  exec(source: string): unknown;
  prepare(source: string): RuntimeStatement;
  close(): unknown;
};

function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function runnerPidFromId(runnerId: string): number | null {
  const match = /^(\d+)-/.exec(runnerId.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function openRuntimeDatabase(dbPath: string): RuntimeDatabase {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export class RuntimeStateStore {
  private readonly db: RuntimeDatabase;
  readonly leaseDurationMs: number;

  constructor(
    dbPath: string,
    options: { leaseDurationMs?: number } = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.db = openRuntimeDatabase(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        task_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (task_id, kind, value)
      );

      CREATE TABLE IF NOT EXISTS blockers (
        task_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deferrals (
        task_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        retry_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_activity (
        task_id TEXT PRIMARY KEY,
        transcript_path TEXT NOT NULL,
        milestones_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  static async create(dbPath: string, options: { leaseDurationMs?: number } = {}): Promise<RuntimeStateStore> {
    await mkdir(path.dirname(dbPath), { recursive: true });
    return new RuntimeStateStore(dbPath, options);
  }

  close(): void {
    this.db.close();
  }

  private pruneExpiredLeases(): RuntimePruneResult {
    const now = isoNow();
    const leaseRows = this.db.prepare('SELECT task_id, runner_id, expires_at FROM leases').all() as {
      task_id: string;
      runner_id: string;
      expires_at: string;
    }[];
    const expiredTaskIds: string[] = [];
    const deadRunnerTaskIds: string[] = [];
    for (const row of leaseRows) {
      if (row.expires_at <= now) {
        expiredTaskIds.push(row.task_id);
        continue;
      }
      const runnerPid = runnerPidFromId(row.runner_id);
      if (runnerPid !== null && !isPidAlive(runnerPid)) {
        deadRunnerTaskIds.push(row.task_id);
      }
    }
    if (expiredTaskIds.length === 0 && deadRunnerTaskIds.length === 0) {
      return { deadRunnerLeases: 0, expiredLeases: 0, expiredDeferrals: 0 };
    }
    const deleteReservations = this.db.prepare('DELETE FROM reservations WHERE task_id = ?');
    const deleteLease = this.db.prepare('DELETE FROM leases WHERE task_id = ?');
    const deleteActivity = this.db.prepare('DELETE FROM task_activity WHERE task_id = ?');
    for (const taskId of [...expiredTaskIds, ...deadRunnerTaskIds]) {
      deleteReservations.run(taskId);
      deleteActivity.run(taskId);
      deleteLease.run(taskId);
    }
    return {
      deadRunnerLeases: deadRunnerTaskIds.length,
      expiredLeases: expiredTaskIds.length,
      expiredDeferrals: 0,
    };
  }

  private pruneExpiredDeferrals(): number {
    const result = this.db.prepare('DELETE FROM deferrals WHERE retry_at <= ?').run(isoNow()) as { changes?: number };
    return result.changes ?? 0;
  }

  reapStaleRuntimeState(): RuntimePruneResult {
    return this.transaction(() => {
      const leaseResult = this.pruneExpiredLeases();
      const expiredDeferrals = this.pruneExpiredDeferrals();
      return {
        deadRunnerLeases: leaseResult.deadRunnerLeases,
        expiredLeases: leaseResult.expiredLeases,
        expiredDeferrals,
      };
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncBlockers(blockages: TaskBlockage[]): void {
    const now = isoNow();
    this.transaction(() => {
      this.pruneExpiredLeases();
      this.pruneExpiredDeferrals();
      this.db.exec('DELETE FROM blockers');
      const insert = this.db.prepare('INSERT INTO blockers (task_id, reason, updated_at) VALUES (?, ?, ?)');
      for (const blockage of blockages) {
        insert.run(blockage.taskId, blockage.reason, now);
      }
    });
  }

  getBlockage(taskId: string): TaskBlockage | null {
    this.pruneExpiredLeases();
    this.pruneExpiredDeferrals();
    const row = this.db.prepare(`
      SELECT blockers.task_id, blockers.reason, deferrals.retry_at
      FROM blockers
      LEFT JOIN deferrals ON deferrals.task_id = blockers.task_id
      WHERE blockers.task_id = ?
    `).get(taskId) as
      | { task_id: string; reason: string; retry_at: string | null }
      | undefined;
    return row ? { taskId: row.task_id, reason: row.reason, retryAt: row.retry_at ?? undefined } : null;
  }

  listActiveDeferrals(): TaskBlockage[] {
    this.pruneExpiredDeferrals();
    const rows = this.db.prepare('SELECT task_id, reason, retry_at FROM deferrals').all() as {
      task_id: string;
      reason: string;
      retry_at: string;
    }[];
    return rows.map(row => ({
      taskId: row.task_id,
      reason: row.reason,
      retryAt: row.retry_at,
    }));
  }

  listActiveTaskIds(): Set<string> {
    this.pruneExpiredLeases();
    this.pruneExpiredDeferrals();
    const rows = this.db.prepare('SELECT task_id FROM leases').all() as { task_id: string }[];
    return new Set(rows.map(row => row.task_id));
  }

  listActiveLeases(taskIndex: Map<string, BacklogTaskSpec>, excludeTaskId?: string): TaskLeaseSnapshot[] {
    this.pruneExpiredLeases();
    this.pruneExpiredDeferrals();
    const rows = this.db.prepare('SELECT task_id, runner_id, claimed_at, heartbeat_at, expires_at FROM leases').all() as {
      task_id: string;
      runner_id: string;
      claimed_at: string;
      heartbeat_at: string;
      expires_at: string;
    }[];

    return rows
      .filter(row => row.task_id !== excludeTaskId)
      .flatMap(row => {
        const task = taskIndex.get(row.task_id);
        if (!task) return [];
        return [{
          taskId: row.task_id,
          title: task.title,
          runnerId: row.runner_id,
          claimedAt: row.claimed_at,
          heartbeatAt: row.heartbeat_at,
          expiresAt: row.expires_at,
        }];
      });
  }

  listActiveReservations(taskIndex: Map<string, BacklogTaskSpec>, excludeTaskId?: string): TaskReservationSnapshot[] {
    this.pruneExpiredLeases();
    this.pruneExpiredDeferrals();
    const leaseRows = this.db.prepare('SELECT task_id, runner_id, expires_at FROM leases').all() as {
      task_id: string;
      runner_id: string;
      expires_at: string;
    }[];
    const reservationRows = this.db.prepare('SELECT task_id, kind, value FROM reservations').all() as {
      task_id: string;
      kind: string;
      value: string;
    }[];

    const byTaskId = new Map<string, { touchPaths: string[]; capabilities: string[] }>();
    for (const row of reservationRows) {
      const current = byTaskId.get(row.task_id) ?? { touchPaths: [], capabilities: [] };
      if (row.kind === 'touch_path') current.touchPaths.push(row.value);
      if (row.kind === 'capability') current.capabilities.push(row.value);
      byTaskId.set(row.task_id, current);
    }

    return leaseRows
      .filter(row => row.task_id !== excludeTaskId)
      .flatMap(row => {
        const task = taskIndex.get(row.task_id);
        if (!task) return [];
        const reservations = byTaskId.get(row.task_id) ?? {
          touchPaths: task.touchPaths,
          capabilities: task.capabilities,
        };
        return [{
          taskId: row.task_id,
          title: task.title,
          touchPaths: [...new Set(reservations.touchPaths)],
          capabilities: [...new Set(reservations.capabilities)],
          runnerId: row.runner_id,
          expiresAt: row.expires_at,
        }];
      });
  }

  listActiveTaskActivity(taskIndex: Map<string, BacklogTaskSpec>, excludeTaskId?: string): TaskActivitySnapshot[] {
    this.pruneExpiredLeases();
    this.pruneExpiredDeferrals();
    const rows = this.db.prepare('SELECT task_id, transcript_path, milestones_json FROM task_activity').all() as {
      task_id: string;
      transcript_path: string;
      milestones_json: string;
    }[];

    return rows
      .filter(row => row.task_id !== excludeTaskId)
      .flatMap(row => {
        const task = taskIndex.get(row.task_id);
        if (!task) return [];

        let milestones: string[] = [];
        try {
          const parsed = JSON.parse(row.milestones_json);
          milestones = Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
        } catch {
          milestones = [];
        }

        return [{
          taskId: row.task_id,
          title: task.title,
          transcriptPath: row.transcript_path,
          milestones,
        }];
      });
  }

  recordTaskActivity(taskId: string, transcriptPath: string, milestone?: string): void {
    this.transaction(() => {
      this.pruneExpiredLeases();
      this.pruneExpiredDeferrals();

      const existing = this.db.prepare(
        'SELECT milestones_json FROM task_activity WHERE task_id = ?',
      ).get(taskId) as { milestones_json: string } | undefined;

      let milestones: string[] = [];
      if (existing) {
        try {
          const parsed = JSON.parse(existing.milestones_json);
          milestones = Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
        } catch {
          milestones = [];
        }
      }

      if (milestone) {
        milestones = milestones.filter(value => value !== milestone);
        milestones.push(milestone);
        milestones = milestones.slice(-3);
      }

      this.db.prepare(`
        INSERT INTO task_activity (task_id, transcript_path, milestones_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          transcript_path = excluded.transcript_path,
          milestones_json = excluded.milestones_json,
          updated_at = excluded.updated_at
      `).run(taskId, transcriptPath, JSON.stringify(milestones), isoNow());
    });
  }

  clearTaskActivity(taskId: string): void {
    this.db.prepare('DELETE FROM task_activity WHERE task_id = ?').run(taskId);
  }

  claimTask(task: BacklogTaskSpec, runnerId: string, claimToken: string): BacklogTaskLease | null {
    return this.transaction(() => {
      this.pruneExpiredLeases();
      this.pruneExpiredDeferrals();
      const existing = this.db.prepare('SELECT task_id FROM leases WHERE task_id = ?').get(task.id) as { task_id: string } | undefined;
      if (existing) return null;

      const lease: BacklogTaskLease = {
        taskId: task.id,
        runnerId,
        claimToken,
        claimedAt: isoNow(),
        heartbeatAt: isoNow(),
        expiresAt: isoNow(this.leaseDurationMs),
      };
      this.db.prepare(`
        INSERT INTO leases (task_id, runner_id, claim_token, claimed_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(lease.taskId, lease.runnerId, lease.claimToken, lease.claimedAt, lease.heartbeatAt, lease.expiresAt);

      const insertReservation = this.db.prepare(
        'INSERT INTO reservations (task_id, kind, value) VALUES (?, ?, ?)',
      );
      for (const touchPath of task.touchPaths) {
        insertReservation.run(task.id, 'touch_path', touchPath);
      }
      for (const capability of task.capabilities) {
        insertReservation.run(task.id, 'capability', capability);
      }

      this.db.prepare('DELETE FROM deferrals WHERE task_id = ?').run(task.id);

      return lease;
    });
  }

  heartbeatClaim(claim: BacklogTaskClaim): void {
    this.transaction(() => {
      this.pruneExpiredLeases();
      this.pruneExpiredDeferrals();
      this.db.prepare(`
        UPDATE leases
        SET heartbeat_at = ?, expires_at = ?
        WHERE task_id = ? AND runner_id = ? AND claim_token = ?
      `).run(isoNow(), isoNow(this.leaseDurationMs), claim.task.id, claim.lease.runnerId, claim.lease.claimToken);
    });
  }

  releaseClaim(claim: BacklogTaskClaim): void {
    this.transaction(() => {
      this.clearTaskActivity(claim.task.id);
      this.db.prepare('DELETE FROM reservations WHERE task_id = ?').run(claim.task.id);
      this.db.prepare('DELETE FROM leases WHERE task_id = ? AND runner_id = ? AND claim_token = ?').run(
        claim.task.id,
        claim.lease.runnerId,
        claim.lease.claimToken,
      );
    });
  }

  deferTask(taskId: string, reason: string, retryAt: string): void {
    this.transaction(() => {
      this.pruneExpiredDeferrals();
      this.clearTaskActivity(taskId);
      this.db.prepare(`
        INSERT INTO deferrals (task_id, reason, retry_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          reason = excluded.reason,
          retry_at = excluded.retry_at,
          updated_at = excluded.updated_at
      `).run(taskId, reason, retryAt, isoNow());
    });
  }

  clearTaskDeferral(taskId: string): void {
    this.db.prepare('DELETE FROM deferrals WHERE task_id = ?').run(taskId);
  }
}
