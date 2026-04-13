import path from 'node:path';
import { analyzeRepository, applySetupResult, recommendDiscoveryPasses } from './setup.js';

export type InitBacklogRunnerOptions = {
  cwd?: string;
  force?: boolean;
};

export async function initBacklogRunner(targetDir: string, options: InitBacklogRunnerOptions = {}): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = path.resolve(cwd, targetDir);
  const force = options.force ?? false;

  const analysis = await analyzeRepository(projectRoot);
  const passes = recommendDiscoveryPasses(analysis);
  await applySetupResult(path.join(projectRoot, 'backlog.config.mjs'), projectRoot, null, passes, {
    forceScaffold: force,
  });

  return [
    `Initialized backlog-runner scaffold in ${projectRoot}`,
    'Edit backlog.config.mjs to point validation at your real repo checks.',
    'Review scripts/backlog/README.md and scripts/backlog/passes/*.md to customize discovery for your repo.',
  ];
}
