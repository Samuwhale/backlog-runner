import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeBacklogRunnerConfig } from '../config.js';
import { createFileBackedTaskStore } from '../store/task-store.js';
import { createTaskFromCandidate, parseTaskSpec, writeTaskSpec } from '../task-specs.js';
import type { BacklogCandidateRecord, BacklogRunnerConfig, BacklogTaskSpec } from '../types.js';

const tempDirs: string[] = [];

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-store-test-'));
  tempDirs.push(root);
  await mkdir(path.join(root, 'scripts/backlog'), { recursive: true });
  await mkdir(path.join(root, 'backlog/tasks'), { recursive: true });
  await mkdir(path.join(root, 'backlog'), { recursive: true });
  await mkdir(path.join(root, '.backlog-runner'), { recursive: true });
  await writeFile(path.join(root, 'backlog.md'), '', 'utf8');
  await writeFile(path.join(root, 'backlog/inbox.jsonl'), '', 'utf8');
  await writeFile(path.join(root, 'backlog-stop'), '', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/patterns.md'), '# Patterns\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/progress.txt'), '# Backlog Progress Log\nStarted: today\n---\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/archive.md'), '# Backlog Archive\n', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/agent.md'), 'agent', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/planner.md'), 'planner', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/product.md'), 'product', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/ux.md'), 'ux', 'utf8');
  await writeFile(path.join(root, 'scripts/backlog/code.md'), 'code', 'utf8');

  const config = normalizeBacklogRunnerConfig(
    {
      files: {
        backlog: './backlog.md',
        candidateQueue: './backlog/inbox.jsonl',
        taskSpecsDir: './backlog/tasks',
        stop: './backlog-stop',
        runtimeReport: './.backlog-runner/runtime-report.md',
        patterns: './scripts/backlog/patterns.md',
        progress: './scripts/backlog/progress.txt',
        stateDb: './.backlog-runner/state.sqlite',
        runnerLogDir: './scripts/backlog',
        runtimeDir: './.backlog-runner',
      },
      prompts: {
        agent: './scripts/backlog/agent.md',
        planner: './scripts/backlog/planner.md',
        product: './scripts/backlog/product.md',
        interface: './scripts/backlog/interface.md',
        ux: './scripts/backlog/ux.md',
        code: './scripts/backlog/code.md',
      },
      validationCommand: 'bash scripts/backlog/validate.sh',
      validationProfiles: {
        repo: 'bash scripts/backlog/validate.sh',
        backlog: 'pnpm --filter @tokenmanager/backlog-runner exec vitest run',
      },
      runners: {
        taskUi: { tool: 'claude', model: 'opus' },
        taskCode: { tool: 'codex', model: 'default' },
        planner: { tool: 'codex', model: 'default' },
        product: { tool: 'codex', model: 'default' },
        interface: { tool: 'claude', model: 'sonnet' },
        ux: { tool: 'codex', model: 'default' },
        code: { tool: 'codex', model: 'default' },
      },
    },
    path.join(root, 'backlog.config.mjs'),
  );

  const store = createFileBackedTaskStore(config);
  await store.ensureProgressFile();
  await store.ensureTaskSpecsReady();
  return { root, config, store };
}

function taskSpec(overrides: Partial<BacklogTaskSpec> & Pick<BacklogTaskSpec, 'id' | 'title'>): BacklogTaskSpec {
  return {
    id: overrides.id,
    title: overrides.title,
    priority: overrides.priority ?? 'normal',
    taskKind: overrides.taskKind ?? 'implementation',
    executionDomain: overrides.taskKind === 'research' ? undefined : overrides.executionDomain ?? 'ui_ux',
    dependsOn: overrides.dependsOn ?? [],
    touchPaths: overrides.touchPaths ?? ['packages/figma-plugin/src/ui/App.tsx'],
    capabilities: overrides.capabilities ?? [],
    validationProfile: overrides.validationProfile ?? 'repo',
    statusNotes: overrides.statusNotes ?? ['Seeded by test.'],
    state: overrides.state ?? 'ready',
    acceptanceCriteria: overrides.acceptanceCriteria ?? [overrides.title],
    source: overrides.source ?? 'manual',
    createdAt: overrides.createdAt ?? '2026-04-08T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-08T00:00:00.000Z',
  };
}

async function seedTask(config: BacklogRunnerConfig, task: BacklogTaskSpec): Promise<void> {
  await writeTaskSpec(config.files.taskSpecsDir, task);
}

async function claimNextRunnableTask(
  store: ReturnType<typeof createFileBackedTaskStore>,
  runnerId: string,
) {
  const claims = await store.claimNextRunnableTasks(1, runnerId);
  return claims[0] ?? null;
}

function candidate(overrides: Partial<BacklogCandidateRecord> & Pick<BacklogCandidateRecord, 'title' | 'touchPaths' | 'acceptanceCriteria' | 'source'>): BacklogCandidateRecord {
  return {
    title: overrides.title,
    priority: overrides.priority ?? 'normal',
    touchPaths: overrides.touchPaths,
    acceptanceCriteria: overrides.acceptanceCriteria,
    validationProfile: overrides.validationProfile,
    capabilities: overrides.capabilities,
    context: overrides.context,
    source: overrides.source,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('task store', () => {
  it('claims multiple runnable tasks atomically in priority order', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-low', title: 'Task Low', priority: 'low', touchPaths: ['packages/core/src/low.ts'] }));
    await seedTask(config, taskSpec({ id: 'task-high', title: 'Task High', priority: 'high', touchPaths: ['packages/core/src/high.ts'] }));
    await seedTask(config, taskSpec({ id: 'task-normal', title: 'Task Normal', priority: 'normal', touchPaths: ['packages/core/src/normal.ts'] }));

    const claims = await store.claimNextRunnableTasks(2, 'runner-a');

    expect(claims.map(claim => claim.task.id)).toEqual(['task-high', 'task-normal']);
  });

  it('claims different runnable tasks across runners without double-claiming', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));
    await seedTask(config, taskSpec({ id: 'task-b', title: 'Task B', touchPaths: ['packages/server/src/b.ts'] }));

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    const claimB = await claimNextRunnableTask(storeB, 'runner-b');

    expect(claimA?.task.id).toBe('task-a');
    expect(claimB?.task.id).toBe('task-b');
  });

  it('allows non-overlapping package-local source tasks to run concurrently', async () => {
    const { config } = await makeFixture();
    const taskA = createTaskFromCandidate(candidate({
      title: 'Update server path A',
      touchPaths: ['packages/server/src/a.ts'],
      acceptanceCriteria: ['Update server path A'],
      source: 'manual',
    }), config.validationProfiles);
    const taskB = createTaskFromCandidate(candidate({
      title: 'Update server path B',
      touchPaths: ['packages/server/src/b.ts'],
      acceptanceCriteria: ['Update server path B'],
      source: 'manual',
    }), config.validationProfiles);

    await seedTask(config, taskA!);
    await seedTask(config, taskB!);

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    const claimB = await claimNextRunnableTask(storeB, 'runner-b');

    expect(claimA?.task.capabilities).toEqual([]);
    expect(claimB?.task.capabilities).toEqual([]);
    expect(claimA?.task.id).not.toBe(claimB?.task.id);
  });

  it('blocks dependent tasks until upstream work is done', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));
    await seedTask(config, taskSpec({
      id: 'task-b',
      title: 'Task B',
      dependsOn: ['task-a'],
      touchPaths: ['packages/core/src/b.ts'],
    }));

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    const blockedClaim = await claimNextRunnableTask(storeB, 'runner-b');

    expect(claimA?.task.id).toBe('task-a');
    expect(blockedClaim).toBeNull();
    const blockage = await storeB.getTaskBlockage('task-b');
    expect(blockage).not.toBeNull();
    expect(blockage!.reason).toMatch(/dependency/i);

    await storeA.completeClaim(claimA!, 'done');
    const claimB = await claimNextRunnableTask(storeB, 'runner-b');
    expect(claimB?.task.id).toBe('task-b');
  });

  it('treats archived done tasks as satisfied dependencies', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'done',
      touchPaths: ['packages/core/src/a.ts'],
    }));
    await seedTask(config, taskSpec({
      id: 'task-b',
      title: 'Task B',
      dependsOn: ['task-a'],
      touchPaths: ['packages/core/src/b.ts'],
    }));

    const store = createFileBackedTaskStore(config);
    const claim = await claimNextRunnableTask(store, 'runner-a');

    expect(claim?.task.id).toBe('task-b');
  });

  it('auto-heals duplicate task ids during ensureTaskSpecsReady', async () => {
    const { config, store } = await makeFixture();
    await writeFile(path.join(config.files.taskSpecsDir, 'task-a.yaml'), [
      'id: task-a',
      'title: Task A active',
      'priority: normal',
      'task_kind: implementation',
      'execution_domain: code_logic',
      'depends_on:',
      'touch_paths:',
      '  - packages/core/src/a.ts',
      'capabilities:',
      'validation_profile: repo',
      'status_notes:',
      '  - Active copy',
      'state: ready',
      'acceptance_criteria:',
      '  - Task A',
      'source: manual',
      'created_at: 2026-04-08T00:00:00.000Z',
      'updated_at: 2026-04-08T00:00:00.000Z',
      '',
    ].join('\n'), 'utf8');
    await mkdir(path.join(config.files.taskSpecsDir, 'done'), { recursive: true });
    await writeFile(path.join(config.files.taskSpecsDir, 'done', 'task-a.yaml'), [
      'id: task-a',
      'title: Task A archived',
      'priority: normal',
      'task_kind: implementation',
      'execution_domain: code_logic',
      'depends_on:',
      'touch_paths:',
      '  - packages/core/src/a.ts',
      'capabilities:',
      'validation_profile: repo',
      'status_notes:',
      '  - Archived copy',
      'state: done',
      'acceptance_criteria:',
      '  - Task A',
      'source: manual',
      'created_at: 2026-04-08T00:00:00.000Z',
      'updated_at: 2026-04-08T00:01:00.000Z',
      '',
    ].join('\n'), 'utf8');

    await store.ensureTaskSpecsReady();

    expect((await readdir(config.files.taskSpecsDir)).filter(name => name.endsWith('.yaml'))).toEqual([]);
    expect((await readdir(path.join(config.files.taskSpecsDir, 'done'))).filter(name => name.endsWith('.yaml'))).toEqual(['task-a.yaml']);
    const healed = await store.getTaskSpec('task-a');
    expect(healed?.title).toBe('Task A archived');
    expect(healed?.state).toBe('done');
  });

  it('blocks overlapping touch_paths while another lease is active', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/server/src/routes'] }));
    await seedTask(config, taskSpec({ id: 'task-b', title: 'Task B', touchPaths: ['packages/server/src/routes/tokens.ts'] }));

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    const blockedClaim = await claimNextRunnableTask(storeB, 'runner-b');

    expect(claimA?.task.id).toBe('task-a');
    expect(blockedClaim).toBeNull();
    const blockage = await storeB.getTaskBlockage('task-b');
    expect(blockage).not.toBeNull();
    expect(blockage!.reason).toMatch(/reservation/i);
  });

  it('skips conflicting tasks within the same batch claim', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', priority: 'high', touchPaths: ['packages/server/src/routes'] }));
    await seedTask(config, taskSpec({ id: 'task-b', title: 'Task B', priority: 'normal', touchPaths: ['packages/server/src/routes/tokens.ts'] }));
    await seedTask(config, taskSpec({ id: 'task-c', title: 'Task C', priority: 'low', touchPaths: ['packages/core/src/other.ts'] }));

    const claims = await store.claimNextRunnableTasks(3, 'runner-a');

    expect(claims.map(claim => claim.task.id)).toEqual(['task-a', 'task-c']);
  });

  it('skips conflicting capabilities within the same batch claim', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', priority: 'high', touchPaths: ['package.json'], capabilities: ['workspace-config'] }));
    await seedTask(config, taskSpec({ id: 'task-b', title: 'Task B', priority: 'normal', touchPaths: ['.github/workflows/ci.yml'], capabilities: ['workspace-config'] }));

    const claims = await store.claimNextRunnableTasks(2, 'runner-a');

    expect(claims.map(claim => claim.task.id)).toEqual(['task-a']);
  });

  it('blocks shared workspace config surfaces via inferred capabilities', async () => {
    const { config } = await makeFixture();
    const taskA = createTaskFromCandidate(candidate({
      title: 'Update package config',
      touchPaths: ['package.json'],
      acceptanceCriteria: ['Update package config'],
      source: 'manual',
    }), config.validationProfiles);
    const taskB = createTaskFromCandidate(candidate({
      title: 'Update CI workflow',
      touchPaths: ['.github/workflows/ci.yml'],
      acceptanceCriteria: ['Update CI workflow'],
      source: 'manual',
    }), config.validationProfiles);

    await seedTask(config, taskA!);
    await seedTask(config, taskB!);

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    const blockedClaim = await claimNextRunnableTask(storeB, 'runner-b');

    expect(claimA?.task.capabilities).toContain('workspace-config');
    expect(blockedClaim).toBeNull();
  });

  it('does not run tasks with unknown scope', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'planned',
      touchPaths: [],
    }));

    const claim = await claimNextRunnableTask(store, 'runner-a');
    const counts = await store.getQueueCounts();

    expect(claim).toBeNull();
    expect(counts.ready).toBe(0);
    expect(counts.planned).toBe(1);
  });

  it('reclaims expired leases safely', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));

    const storeA = createFileBackedTaskStore(config);
    const storeB = createFileBackedTaskStore(config);
    const claimA = await claimNextRunnableTask(storeA, 'runner-a');
    expect(claimA?.task.id).toBe('task-a');

    const db = new Database(config.files.stateDb);
    db.prepare('UPDATE leases SET expires_at = ? WHERE task_id = ?').run('2000-01-01T00:00:00.000Z', 'task-a');
    db.close();

    const reclaimed = await claimNextRunnableTask(storeB, 'runner-b');
    expect(reclaimed?.task.id).toBe('task-a');
  });

  it('reclaims dead-runner leases immediately and clears reservations and activity', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));

    const storeB = createFileBackedTaskStore(config);
    const db = new Database(config.files.stateDb);
    db.prepare(`
      INSERT INTO leases (task_id, runner_id, claim_token, claimed_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('task-a', '999999-1', 'dead-claim', new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    db.prepare(`
      INSERT INTO reservations (task_id, kind, value)
      VALUES (?, ?, ?)
    `).run('task-a', 'touch_path', 'packages/core/src/a.ts');
    db.prepare(`
      INSERT INTO task_activity (task_id, transcript_path, milestones_json, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('task-a', '/tmp/task-a.jsonl', JSON.stringify(['Inspecting repo state.']), new Date().toISOString());
    db.close();

    const reclaimedRuntime = await storeB.reapStaleRuntimeState();
    const reclaimed = await claimNextRunnableTask(storeB, 'runner-b');

    expect(reclaimedRuntime.deadRunnerLeases).toBe(1);
    expect(reclaimed?.task.id).toBe('task-a');
    const blockage = await storeB.getTaskBlockage('task-a');
    expect(blockage).toBeNull();
  });

  it('blocks deferred ready tasks until the runtime deferral expires', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));

    const store = createFileBackedTaskStore(config);
    const claim = await claimNextRunnableTask(store, 'runner-a');
    expect(claim?.task.id).toBe('task-a');

    await store.deferClaim(claim!, 'dirty workspace preflight: staged user-staged.txt', 15 * 60 * 1000);

    const countsWhileDeferred = await store.getQueueCounts();
    const blockage = await store.getTaskBlockage('task-a');
    const blockedClaim = await claimNextRunnableTask(store, 'runner-b');

    expect(countsWhileDeferred.ready).toBe(0);
    expect(countsWhileDeferred.blocked).toBe(1);
    expect(blockage?.reason).toBe('dirty workspace preflight: staged user-staged.txt');
    expect(blockage?.retryAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(blockedClaim).toBeNull();
    const spec = await store.getTaskSpec('task-a');
    expect(spec?.statusNotes?.some(n => n.includes('Deferred'))).toBe(true);

    const db = new Database(config.files.stateDb);
    db.prepare('UPDATE deferrals SET retry_at = ? WHERE task_id = ?').run('2000-01-01T00:00:00.000Z', 'task-a');
    db.close();

    const countsAfterExpiry = await store.getQueueCounts();
    const reclaimed = await claimNextRunnableTask(store, 'runner-b');

    expect(countsAfterExpiry.blocked).toBe(0);
    expect(reclaimed?.task.id).toBe('task-a');
  });

  it('refreshes queue counts without rewriting backlog.md and writes runtime-report.md', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));
    await writeFile(config.files.backlog, 'sentinel backlog', 'utf8');

    const counts = await store.getQueueCounts();
    expect(counts.ready).toBe(1);
    expect(counts.done).toBe(0);
    expect(await readFile(config.files.backlog, 'utf8')).toBe('sentinel backlog');
    expect(await readFile(config.files.runtimeReport, 'utf8')).toContain('Queue: 1 ready');
  });

  it('keeps backlog.md stable while recording active leases in runtime-report.md', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));

    const store = createFileBackedTaskStore(config);
    await store.ensureTaskSpecsReady();
    const claim = await claimNextRunnableTask(store, 'runner-a');
    const backlogReport = await readFile(config.files.backlog, 'utf8');
    const runtimeReport = await readFile(config.files.runtimeReport, 'utf8');

    expect(claim?.task.id).toBe('task-a');
    expect(backlogReport).toContain('- [ ] Task A');
    expect(backlogReport).not.toContain('- [~] Task A');
    expect(backlogReport).not.toContain('Blocked:');
    expect(runtimeReport).toContain('## Active Leases');
    expect(runtimeReport).toContain('Task A (task-a) — runner runner-a');
  });

  it('records active task progress in runtime-report.md and keeps only the latest three distinct milestones', async () => {
    const { config } = await makeFixture();
    await seedTask(config, taskSpec({ id: 'task-a', title: 'Task A', touchPaths: ['packages/core/src/a.ts'] }));

    const store = createFileBackedTaskStore(config);
    await store.ensureTaskSpecsReady();
    const claim = await claimNextRunnableTask(store, 'runner-a');
    expect(claim?.task.id).toBe('task-a');

    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl' });
    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl', milestone: 'First milestone' });
    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl', milestone: 'Second milestone' });
    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl', milestone: 'Second milestone' });
    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl', milestone: 'Third milestone' });
    await store.recordTaskActivity('task-a', { transcriptPath: '/tmp/task-a.jsonl', milestone: 'Fourth milestone' });

    const runtimeReport = await readFile(config.files.runtimeReport, 'utf8');
    expect(runtimeReport).toContain('## Active Task Progress');
    expect(runtimeReport).toContain('Task A (task-a) — transcript: /tmp/task-a.jsonl');
    expect(runtimeReport).not.toContain('First milestone');
    expect(runtimeReport).toContain('Second milestone');
    expect(runtimeReport).toContain('Third milestone');
    expect(runtimeReport).toContain('Fourth milestone');

    await store.completeClaim(claim!, 'done');
    const clearedRuntimeReport = await readFile(config.files.runtimeReport, 'utf8');
    expect(clearedRuntimeReport).toContain('## Active Task Progress');
    expect(clearedRuntimeReport).toContain('- None');
    expect(clearedRuntimeReport).not.toContain('/tmp/task-a.jsonl');
  });

  it('supersedes planned parents into runnable planner children', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'parent-a',
      title: 'Parent A',
      state: 'planned',
      touchPaths: [],
      statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
    }));

    const applied = await store.applyPlannerSupersede({
      action: 'supersede',
      parentTaskIds: ['parent-a'],
      children: [{
        title: 'Research Parent A implementation plan',
        taskKind: 'research',
        priority: 'normal',
        touchPaths: ['backlog/inbox.jsonl', 'scripts/backlog/progress.txt'],
        acceptanceCriteria: ['Concrete follow-up implementation tasks are written to backlog/inbox.jsonl'],
        validationProfile: 'backlog',
        context: 'Inspect the Parent A surface and emit concrete follow-up work.',
      }],
    });

    const parent = await store.getTaskSpec('parent-a');
    const child = await store.getTaskSpec(applied.childTaskIds[0]!);
    const counts = await store.getQueueCounts();
    const backlogReport = await readFile(config.files.backlog, 'utf8');
    const runtimeReport = await readFile(config.files.runtimeReport, 'utf8');

    expect(applied.childTaskIds).toHaveLength(1);
    expect(parent?.state).toBe('superseded');
    expect(parent?.statusNotes.join('\n')).toContain('Superseded by planner-pass');
    expect(child?.taskKind).toBe('research');
    expect(child?.validationProfile).toBe('backlog');
    expect(counts.planned).toBe(0);
    expect(counts.ready).toBe(1);
    expect(backlogReport).not.toContain('- [ ] Parent A');
    expect(backlogReport).toContain('Research Parent A implementation plan');
    expect(runtimeReport).toContain('## Planner Candidates Awaiting Refinement');
    expect(runtimeReport).toContain('- None');
  });

  it('lists failed planner candidates ahead of planned work', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'planned-high',
      title: 'Planned High',
      state: 'planned',
      priority: 'high',
      touchPaths: [],
    }));
    await seedTask(config, taskSpec({
      id: 'failed-normal',
      title: 'Failed Normal',
      state: 'failed',
      priority: 'normal',
      touchPaths: ['packages/core/src/failed-normal.ts'],
      statusNotes: ['Failed: validation failed'],
    }));
    await seedTask(config, taskSpec({
      id: 'failed-low',
      title: 'Failed Low',
      state: 'failed',
      priority: 'low',
      touchPaths: ['packages/core/src/failed-low.ts'],
      statusNotes: ['Failed: write scope violation'],
    }));

    const candidates = await store.listPlannerCandidates();
    await store.getQueueCounts();

    expect(candidates.map(task => task.id)).toEqual(['failed-normal', 'failed-low', 'planned-high']);
    expect(await readFile(config.files.runtimeReport, 'utf8')).toContain('## Planner Candidates Awaiting Refinement');
  });

  it('supersedes failed parents into runnable recovery children', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'failed-parent',
      title: 'Failed Parent',
      state: 'failed',
      touchPaths: ['packages/figma-plugin/src/ui/App.tsx'],
      statusNotes: ['Failed: validation failed: missing dependency'],
    }));

    const applied = await store.applyPlannerSupersede({
      action: 'supersede',
      parentTaskIds: ['failed-parent'],
      children: [{
        title: 'Recover failed parent with narrower implementation scope',
        taskKind: 'implementation',
        priority: 'high',
        touchPaths: ['packages/figma-plugin/src/ui/App.tsx'],
        acceptanceCriteria: ['Narrower recovery task is runnable'],
        validationProfile: 'repo',
        context: 'Recover the failed task with tighter scope.',
      }],
    }, {
      allowedParentTaskIds: ['failed-parent'],
    });

    const parent = await store.getTaskSpec('failed-parent');
    const child = await store.getTaskSpec(applied.childTaskIds[0]!);
    const counts = await store.getQueueCounts();

    expect(parent?.state).toBe('superseded');
    expect(parent?.statusNotes.join('\n')).toContain('Superseded by planner-pass');
    expect(child?.state).toBe('ready');
    expect(child?.priority).toBe('high');
    expect(counts.failed).toBe(0);
    expect(counts.ready).toBe(1);
  });

  it('elevates recovery child priority to preserve failed-parent urgency', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'failed-high',
      title: 'Failed High',
      state: 'failed',
      priority: 'high',
      touchPaths: ['packages/figma-plugin/src/ui/App.tsx'],
      statusNotes: ['Failed: validation failed'],
    }));

    const applied = await store.applyPlannerSupersede({
      action: 'supersede',
      parentTaskIds: ['failed-high'],
      children: [{
        title: 'Recover failed high-priority parent',
        taskKind: 'implementation',
        priority: 'low',
        touchPaths: ['packages/figma-plugin/src/ui/App.tsx'],
        acceptanceCriteria: ['Recovery task is runnable'],
        validationProfile: 'repo',
        context: 'Retry the failed work with the same urgency.',
      }],
    }, {
      allowedParentTaskIds: ['failed-high'],
    });

    const child = await store.getTaskSpec(applied.childTaskIds[0]!);

    expect(child?.priority).toBe('high');
    expect(child?.statusNotes).toContain('Priority elevated to high to preserve failed-parent urgency.');
  });

  it('rejects planner children that collide with each other', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'parent-a',
      title: 'Parent A',
      state: 'planned',
      touchPaths: [],
      statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
    }));

    await expect(store.applyPlannerSupersede({
      action: 'supersede',
      parentTaskIds: ['parent-a'],
      children: [
        {
          title: 'Duplicate child title',
          taskKind: 'research',
          priority: 'normal',
          touchPaths: ['backlog/inbox.jsonl'],
          acceptanceCriteria: ['Write follow-up task A'],
          validationProfile: 'backlog',
        },
        {
          title: 'Duplicate child title',
          taskKind: 'research',
          priority: 'normal',
          touchPaths: ['scripts/backlog/progress.txt'],
          acceptanceCriteria: ['Write follow-up task B'],
          validationProfile: 'backlog',
        },
      ],
    })).rejects.toThrow(/duplicate child task ids/i);
  });

  it('rejects planner actions that target parents outside the selected batch', async () => {
    const { config, store } = await makeFixture();
    await seedTask(config, taskSpec({
      id: 'parent-a',
      title: 'Parent A',
      state: 'planned',
      touchPaths: [],
      statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
    }));
    await seedTask(config, taskSpec({
      id: 'parent-b',
      title: 'Parent B',
      state: 'planned',
      touchPaths: [],
      statusNotes: ['Imported from legacy backlog.md.', 'Planner could not infer touch_paths from the title; refine this task before execution.'],
    }));

    await expect(store.applyPlannerSupersede({
      action: 'supersede',
      parentTaskIds: ['parent-b'],
      children: [{
        title: 'Research Parent B implementation plan',
        taskKind: 'research',
        priority: 'normal',
        touchPaths: ['backlog/inbox.jsonl'],
        acceptanceCriteria: ['Write follow-up task'],
        validationProfile: 'backlog',
      }],
    }, {
      allowedParentTaskIds: ['parent-a'],
    })).rejects.toThrow(/outside the selected planning batch/i);
  });

  it('closes the runtime store safely more than once', async () => {
    const { store } = await makeFixture();

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('drains structured candidate queue records into runnable tasks', async () => {
    const { config, store } = await makeFixture();
    await writeFile(
      config.files.candidateQueue,
      `${JSON.stringify({
        title: 'Implement structured planner',
        priority: 'high',
        touch_paths: ['packages/backlog-runner/src/store/task-store.ts'],
        acceptance_criteria: ['Candidate queue drains into task specs'],
        source: 'manual',
      })}\n`,
      'utf8',
    );

    const result = await store.drainCandidateQueue();
    const claim = await claimNextRunnableTask(store, 'runner-a');

    expect(result).toMatchObject({ drained: true, createdTasks: 1, skippedDuplicates: 0, ignoredInvalidLines: 0 });
    expect(claim?.task.title).toBe('Implement structured planner');
    expect(claim?.task.priority).toBe('high');
  });

  it('rejects malformed candidate queue records without creating limbo tasks', async () => {
    const { config, store } = await makeFixture();
    await writeFile(
      config.files.candidateQueue,
      [
        '{"title":"broken json"',
        JSON.stringify({
          title: 'Missing touch paths',
          priority: 'normal',
          acceptance_criteria: ['Missing touch paths'],
          source: 'manual',
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await store.drainCandidateQueue();
    const counts = await store.getQueueCounts();

    expect(result).toMatchObject({ drained: true, createdTasks: 0, ignoredInvalidLines: 2 });
    expect(counts.planned).toBe(0);
    expect(counts.ready).toBe(0);
  });

  it('rejects task specs with unknown source values', async () => {
    const { root } = await makeFixture();
    const filePath = path.join(root, 'backlog/tasks', 'invalid-source.yaml');
    const raw = 'id: invalid-source\n'
      + 'title: Invalid source\n'
      + 'priority: normal\n'
      + 'task_kind: implementation\n'
      + 'execution_domain: code_logic\n'
      + 'depends_on: []\n'
      + 'touch_paths:\n'
      + '  - packages/core/src/index.ts\n'
      + 'capabilities: []\n'
      + 'validation_profile: core\n'
      + 'status_notes:\n'
      + '  - Seeded by test.\n'
      + 'state: ready\n'
      + 'acceptance_criteria:\n'
      + '  - Reject unknown sources\n'
      + 'source: legacy-backlog\n'
      + 'created_at: 2026-04-08T00:00:00.000Z\n'
      + 'updated_at: 2026-04-08T00:00:00.000Z\n';

    expect(() => parseTaskSpec(raw, filePath)).toThrow(/invalid source/i);
  });
});
