import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BacklogRunnerConfig } from './types.js';
import { isPidAlive } from './utils.js';

type LocalLockState = {
  ownerId: string;
  count: number;
};

const localLocks = new Map<string, LocalLockState>();
const lockOwnerStorage = new AsyncLocalStorage<string>();

async function pidFromLock(lockDir: string): Promise<number | null> {
  try {
    const value = await readFile(`${lockDir}/pid`, 'utf8');
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}


export class LockHandle {
  constructor(
    readonly lockDir: string,
    readonly pid: number,
    readonly ownerId: string,
    readonly reentrant = false,
  ) {}
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function removeLockDirectory(lockDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(lockDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') {
        throw error;
      }
      await sleep(25 * (attempt + 1));
    }
  }
  await rm(lockDir, { recursive: true, force: true });
}

export async function acquireLock(lockDir: string, timeoutSeconds = 30): Promise<LockHandle> {
  const startedAt = Date.now();
  const ownPid = process.pid;
  const ownerId = lockOwnerStorage.getStore() ?? `lock-owner-${randomUUID()}`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  const localState = localLocks.get(lockDir);
  if (localState && localState.ownerId === ownerId) {
    localState.count += 1;
    return new LockHandle(lockDir, ownPid, ownerId, true);
  }

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(`${lockDir}/pid`, `${ownPid}\n`, 'utf8');
      localLocks.set(lockDir, { ownerId, count: 1 });
      return new LockHandle(lockDir, ownPid, ownerId);
    } catch {
      const currentLocalState = localLocks.get(lockDir);
      if (currentLocalState && currentLocalState.ownerId === ownerId) {
        currentLocalState.count += 1;
        return new LockHandle(lockDir, ownPid, ownerId, true);
      }

      const existingPid = await pidFromLock(lockDir);
      if (!isPidAlive(existingPid)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutSeconds * 1000) {
        throw new Error(`Could not acquire lock ${lockDir} after ${timeoutSeconds}s`);
      }

      await sleep(200);
    }
  }
}

export async function releaseLock(lock: LockHandle): Promise<void> {
  const localState = localLocks.get(lock.lockDir);
  if (!localState || localState.ownerId !== lock.ownerId) {
    return;
  }
  if (localState.count > 1) {
    localState.count -= 1;
    return;
  }
  await removeLockDirectory(lock.lockDir);
  localLocks.delete(lock.lockDir);
}

export async function withLock<T>(lockDir: string, timeoutSeconds: number, fn: () => Promise<T>): Promise<T> {
  const currentOwnerId = lockOwnerStorage.getStore();
  const execute = async (): Promise<T> => {
    const lock = await acquireLock(lockDir, timeoutSeconds);
    try {
      return await fn();
    } finally {
      await releaseLock(lock);
    }
  };

  if (currentOwnerId) {
    return execute();
  }

  return lockOwnerStorage.run(`lock-owner-${randomUUID()}`, execute);
}

export function lockPath(config: BacklogRunnerConfig, name: 'backlog' | 'git' | 'pass' | 'planner' | 'worktree'): string {
  return `${config.files.locksDir}/${name}.lock`;
}
