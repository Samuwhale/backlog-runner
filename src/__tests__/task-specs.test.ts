import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferExecutionDomain, normalizeTaskSpecStore, readTaskSpecs, renderGeneratedBacklog, writeTaskSpec } from '../task-specs.js';
import type { BacklogTaskSpec } from '../types.js';

const tempDirs: string[] = [];

function renderTaskYaml(task: BacklogTaskSpec): string {
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `priority: ${task.priority}`,
    `task_kind: ${task.taskKind}`,
    ...(task.taskKind === 'implementation' ? [`execution_domain: ${task.executionDomain}`] : []),
    'depends_on:',
    ...task.dependsOn.map(value => `  - ${value}`),
    'touch_paths:',
    ...task.touchPaths.map(value => `  - ${value}`),
    'capabilities:',
    ...task.capabilities.map(value => `  - ${value}`),
    `validation_profile: ${task.validationProfile}`,
    'status_notes:',
    ...task.statusNotes.map(value => `  - ${value}`),
    `state: ${task.state}`,
    'acceptance_criteria:',
    ...task.acceptanceCriteria.map(value => `  - ${value}`),
    `source: ${task.source}`,
    `created_at: ${task.createdAt}`,
    `updated_at: ${task.updatedAt}`,
    '',
  ].join('\n');
}

function taskSpec(overrides: Partial<BacklogTaskSpec> & Pick<BacklogTaskSpec, 'id' | 'title'>): BacklogTaskSpec {
  return {
    id: overrides.id,
    title: overrides.title,
    priority: overrides.priority ?? 'normal',
    taskKind: overrides.taskKind ?? 'implementation',
    executionDomain: overrides.taskKind === 'research' ? undefined : overrides.executionDomain ?? 'code_logic',
    dependsOn: overrides.dependsOn ?? [],
    touchPaths: overrides.touchPaths ?? ['feature.txt'],
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('task specs', () => {
  it('reads task specs recursively from nested directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-specs-test-'));
    tempDirs.push(root);
    const taskDir = path.join(root, 'backlog/tasks');
    await mkdir(path.join(taskDir, 'done'), { recursive: true });
    await writeFile(path.join(taskDir, 'task-b.yaml'), renderTaskYaml(taskSpec({
      id: 'task-b',
      title: 'Task B',
      createdAt: '2026-04-08T00:01:00.000Z',
      updatedAt: '2026-04-08T00:01:00.000Z',
    })), 'utf8');
    await writeFile(path.join(taskDir, 'done', 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'done',
    })), 'utf8');

    const tasks = await readTaskSpecs(taskDir);

    expect(tasks.map(task => task.id)).toEqual(['task-a', 'task-b']);
    expect(tasks.map(task => task.state)).toEqual(['done', 'ready']);
  });

  it('renders backlog metadata for nested task spec directories', () => {
    const backlog = renderGeneratedBacklog([taskSpec({ id: 'task-a', title: 'Task A' })]);

    expect(backlog).toContain('backlog/tasks/**/*.yaml');
    expect(backlog).toContain('backlog/tasks/done/');
  });

  it('updates a nested task spec in place without creating a top-level duplicate', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-specs-test-'));
    tempDirs.push(root);
    const taskDir = path.join(root, 'backlog/tasks');
    await mkdir(path.join(taskDir, 'done'), { recursive: true });
    await writeFile(path.join(taskDir, 'done', 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'done',
    })), 'utf8');

    const updated = taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'done',
      statusNotes: ['Seeded by test.', 'Updated note'],
    });
    await writeTaskSpec(taskDir, updated);

    const topLevelFiles = (await readdir(taskDir)).filter(name => name.endsWith('.yaml'));
    expect(topLevelFiles).toEqual([]);

    const nestedFiles = (await readdir(path.join(taskDir, 'done'))).filter(name => name.endsWith('.yaml'));
    expect(nestedFiles).toEqual(['task-a.yaml']);

    const tasks = await readTaskSpecs(taskDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.statusNotes).toContain('Updated note');
  });

  it('normalizes duplicate task ids to a single canonical file using the newest update', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-specs-test-'));
    tempDirs.push(root);
    const taskDir = path.join(root, 'backlog/tasks');
    await mkdir(path.join(taskDir, 'done'), { recursive: true });
    await writeFile(path.join(taskDir, 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A active',
      state: 'ready',
      updatedAt: '2026-04-08T00:00:00.000Z',
    })), 'utf8');
    await writeFile(path.join(taskDir, 'done', 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A archived',
      state: 'done',
      updatedAt: '2026-04-08T00:01:00.000Z',
      statusNotes: ['Archived winner'],
    })), 'utf8');

    const result = await normalizeTaskSpecStore(taskDir);

    expect(result.normalizedTaskIds).toEqual(['task-a']);
    expect((await readdir(taskDir)).filter(name => name.endsWith('.yaml'))).toEqual([]);
    expect((await readdir(path.join(taskDir, 'done'))).filter(name => name.endsWith('.yaml'))).toEqual(['task-a.yaml']);

    const tasks = await readTaskSpecs(taskDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Task A archived');
    expect(tasks[0]!.statusNotes).toContain('Archived winner');
  });

  it('readTaskSpecs auto-normalizes duplicate task ids instead of throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-specs-test-'));
    tempDirs.push(root);
    const taskDir = path.join(root, 'backlog/tasks');
    await mkdir(path.join(taskDir, 'done'), { recursive: true });
    await writeFile(path.join(taskDir, 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A older',
      state: 'ready',
      updatedAt: '2026-04-08T00:00:00.000Z',
    })), 'utf8');
    await writeFile(path.join(taskDir, 'done', 'task-a.yaml'), renderTaskYaml(taskSpec({
      id: 'task-a',
      title: 'Task A newer',
      state: 'done',
      updatedAt: '2026-04-08T00:01:00.000Z',
      statusNotes: ['Winner'],
    })), 'utf8');

    // readTaskSpecs should normalize the duplicates rather than throwing
    const tasks = await readTaskSpecs(taskDir);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Task A newer');
    expect(tasks[0]!.statusNotes).toContain('Winner');
  });

  it('moves done tasks into done/ when rewriting canonical task specs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'backlog-task-specs-test-'));
    tempDirs.push(root);
    const taskDir = path.join(root, 'backlog/tasks');
    await mkdir(taskDir, { recursive: true });

    await writeTaskSpec(taskDir, taskSpec({
      id: 'task-a',
      title: 'Task A',
      state: 'done',
    }));

    expect((await readdir(taskDir)).filter(name => name.endsWith('.yaml'))).toEqual([]);
    expect((await readdir(path.join(taskDir, 'done'))).filter(name => name.endsWith('.yaml'))).toEqual(['task-a.yaml']);
  });

  it('infers ui_ux for implementation work confined to plugin ui surfaces', () => {
    expect(inferExecutionDomain(
      'implementation',
      'manual',
      ['packages/figma-plugin/src/ui/components/TokenList.tsx'],
    )).toBe('ui_ux');
  });

  it('defaults ambiguous implementation work to code_logic', () => {
    expect(inferExecutionDomain(
      'implementation',
      'manual',
      ['packages/figma-plugin/src/ui/components/TokenList.tsx', 'packages/server/src/routes/tokens.ts'],
    )).toBe('code_logic');
  });
});
