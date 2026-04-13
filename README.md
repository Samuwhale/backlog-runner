# backlog-runner

`backlog-runner` is a CLI and library for running an autonomous engineering backlog with Codex and Claude. It manages a structured task store, planner/discovery passes, isolated git worktrees, runtime leases, and backlog reporting.

## What It Does

- Stores backlog tasks as YAML specs instead of ad hoc markdown.
- Runs implementation tasks with one or more agent backends.
- Refines vague work with a planner pass.
- Runs discovery passes that can append new candidate work to the queue.
- Coordinates concurrent workers with leases and runtime state.
- Produces a generated `backlog.md` report from the task store.

## Install

```bash
npm install --save-dev backlog-runner
```

## Quick Start

Initialize a repo scaffold:

```bash
npx backlog-runner init
```

That creates:

- `backlog.config.mjs`
- `backlog/`
- `scripts/backlog/`
- `.backlog-runner/`

Then customize:

1. Update `validationCommand` and `validationProfiles` in `backlog.config.mjs`.
2. Adjust `scripts/backlog/*.md` prompts to fit your workflow.
3. Tune `heuristics.validationProfileRules` and `heuristics.uiPathPrefixes` for your codebase.

## Commands

```bash
backlog-runner init
backlog-runner start
backlog-runner status --verbose
backlog-runner sync
backlog-runner doctor
```

## Config

The runner is configured via `backlog.config.mjs`:

```js
import { defineBacklogRunnerConfig } from 'backlog-runner';

export default defineBacklogRunnerConfig({
  validationCommand: 'bash scripts/backlog/validate.sh',
  validationProfiles: {
    repo: 'bash scripts/backlog/validate.sh',
    frontend: 'npm run lint --workspace web',
  },
  heuristics: {
    uiPathPrefixes: ['apps/web/', 'src/components/'],
    validationProfileRules: [
      { profile: 'frontend', pathPrefixes: ['apps/web/', 'src/components/'] },
    ],
  },
  workspaceBootstrap: {
    installCommand: 'npm install',
    repairCommand: 'backlog-runner doctor --repair',
  },
  runners: {
    taskUi: { tool: 'claude', model: 'claude-opus-4-6' },
    taskCode: { tool: 'codex', model: 'gpt-5.4' },
    planner: { tool: 'codex', model: 'gpt-5.4' },
    product: { tool: 'codex', model: 'gpt-5.4' },
    interface: { tool: 'claude', model: 'claude-opus-4-6' },
    ux: { tool: 'claude', model: 'claude-opus-4-6' },
    code: { tool: 'codex', model: 'gpt-5.4' },
  },
});
```

## Current Scope

Supported agent providers:

- `codex`
- `claude`

The runner is opinionated around git repos and local CLI-based agent execution.
