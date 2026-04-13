import { describe, expect, it } from 'vitest';
import { classifyValidationFailure } from '../scheduler/validation-classify.js';
import type { BacklogTaskClaim, BacklogTaskSpec } from '../types.js';

function makeClaim(overrides: Partial<BacklogTaskSpec> = {}): BacklogTaskClaim {
  return {
    task: {
      id: overrides.id ?? 'task-a',
      title: overrides.title ?? 'Test task',
      priority: overrides.priority ?? 'normal',
      taskKind: overrides.taskKind ?? 'implementation',
      executionDomain: overrides.taskKind === 'research' ? undefined : overrides.executionDomain ?? 'code_logic',
      dependsOn: overrides.dependsOn ?? [],
      touchPaths: overrides.touchPaths ?? ['packages/server/src/routes/sets.ts'],
      capabilities: overrides.capabilities ?? [],
      validationProfile: overrides.validationProfile ?? 'repo',
      statusNotes: overrides.statusNotes ?? [],
      state: overrides.state ?? 'ready',
      acceptanceCriteria: overrides.acceptanceCriteria ?? ['Test task'],
      source: overrides.source ?? 'manual',
      createdAt: overrides.createdAt ?? '2026-04-11T00:00:00.000Z',
      updatedAt: overrides.updatedAt ?? '2026-04-11T00:00:00.000Z',
    },
    lease: {
      taskId: overrides.id ?? 'task-a',
      runnerId: 'runner-1',
      claimToken: 'claim-1',
      claimedAt: '2026-04-11T00:00:00.000Z',
      heartbeatAt: '2026-04-11T00:00:00.000Z',
      expiresAt: '2026-04-11T01:00:00.000Z',
    },
  };
}

describe('classifyValidationFailure', () => {
  it('keeps workspace bootstrap failures non-blocking', () => {
    const classification = classifyValidationFailure(
      makeClaim(),
      "validation failed: Error: Failed to load url fastify (resolved id: fastify) in /tmp/worktree/packages/server/src/index.ts. Does the file exist?",
      ['packages/server/src/routes/sets.ts'],
    );

    expect(classification.blocking).toBe(false);
  });

  it('keeps shared install policy failures blocking so they defer instead of queueing follow-ups', () => {
    const classification = classifyValidationFailure(
      makeClaim(),
      'validation failed: dependency refresh required from main repo [BACKLOG_MAIN_REPO_INSTALL_REQUIRED]: poisoned shared install targets: packages/server/node_modules/fastify -> /tmp/backlog-123/node_modules/.pnpm/fastify/node_modules/fastify Recovery: remove poisoned package-local node_modules links and rerun pnpm install from the main repo root.',
      ['packages/server/src/routes/sets.ts'],
    );

    expect(classification).toEqual({
      blocking: true,
      reason: 'validation failed: dependency refresh required from main repo [BACKLOG_MAIN_REPO_INSTALL_REQUIRED]: poisoned shared install targets: packages/server/node_modules/fastify -> /tmp/backlog-123/node_modules/.pnpm/fastify/node_modules/fastify Recovery: remove poisoned package-local node_modules links and rerun pnpm install from the main repo root.',
    });
  });

  it('treats failures in changed files as blocking', () => {
    const classification = classifyValidationFailure(
      makeClaim(),
      'validation failed: packages/server/src/routes/sets.ts(10,2): error TS2322: broken',
      ['packages/server/src/routes/sets.ts'],
    );

    expect(classification).toEqual({
      blocking: true,
      reason: 'validation failed: packages/server/src/routes/sets.ts(10,2): error TS2322: broken',
    });
  });

  it('treats failures in a different package as non-blocking follow-ups', () => {
    const classification = classifyValidationFailure(
      makeClaim(),
      "validation failed: packages/core/src/index.ts(10,2): error TS2307: Cannot find module 'fastify' or its corresponding type declarations.",
      ['packages/server/src/routes/sets.ts'],
    );

    expect(classification.blocking).toBe(false);
    if (!classification.blocking) {
      expect(classification.followup.touchPaths).toEqual(['packages/core/src/index.ts']);
    }
  });

  it('keeps same-package failures blocking when they do not reference the exact changed file', () => {
    const classification = classifyValidationFailure(
      makeClaim(),
      'validation failed: packages/server/src/services/token-store.ts(20,4): error TS2554: Expected 1 arguments, but got 0.',
      ['packages/server/src/routes/sets.ts'],
    );

    expect(classification).toEqual({
      blocking: true,
      reason: 'validation failed: packages/server/src/services/token-store.ts(20,4): error TS2554: Expected 1 arguments, but got 0.',
    });
  });
});
