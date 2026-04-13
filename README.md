# backlog-runner

`backlog-runner` is a CLI and library for running an autonomous engineering backlog with Codex and Claude. It manages a structured task store, configurable discovery passes, isolated git worktrees, runtime leases, and backlog reporting.

## What It Does

- Stores backlog tasks as YAML specs instead of ad hoc markdown.
- Runs implementation tasks with one or more agent backends.
- Refines vague work with a planner pass.
- Runs configured discovery passes that can append new candidate work to the queue.
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

If you want the tool to draft passes for the repo instead of relying only on deterministic recommendations:

```bash
npx backlog-runner setup --agentic
```

`setup --agentic` drafts pass ids, descriptions, heuristics, and runner choices. The runner still writes the managed prompt files itself so the queue/schema contract stays valid.

That creates:

- `backlog.config.mjs`
- `backlog/`
- `scripts/backlog/`
- `.backlog-runner/`

Then customize:

1. Update `validation` in `backlog.config.mjs` to point at your real repo checks.
2. Read `scripts/backlog/README.md` for the repo-local pass authoring model.
3. Adjust `scripts/backlog/passes/*.md` prompts to fit your workflow.
4. Add `classification` or extra `validation.routing` rules only if the defaults are too broad.

## Commands

```bash
backlog-runner init
backlog-runner setup
backlog-runner start
backlog-runner pass list
backlog-runner status --verbose
backlog-runner sync
backlog-runner doctor
```

## Config

The runner is configured via `backlog.config.mjs`:

```js
export default {
  preset: 'balanced',
  validation: {
    default: 'bash scripts/backlog/validate.sh',
    profiles: {
      frontend: 'npm run lint --workspace web',
    },
    routing: [
      { profile: 'frontend', pathPrefixes: ['apps/web/', 'src/components/'] },
    ],
  },
  workspace: {
    workers: 2,
    useWorktrees: true,
  },
  classification: {
    uiPathPrefixes: ['apps/web/', 'src/components/'],
  },
  workspaceBootstrap: {
    installCommand: 'npm install',
    repairCommand: 'backlog-runner doctor --repair',
  },
  providers: {
    agents: {
      ui: { tool: 'claude', model: 'claude-opus-4-6' },
      code: { tool: 'codex', model: 'gpt-5.4' },
      planner: { tool: 'codex', model: 'gpt-5.4' },
    },
  },
  discovery: {
    enabled: true,
    passes: {
      frontend: {
        runner: { tool: 'claude', model: 'claude-opus-4-6' },
      },
      deps: {
        runner: { tool: 'codex', model: 'gpt-5.4' },
      },
    },
  },
};
```

## Current Scope

Supported agent providers:

- `codex`
- `claude`

The runner is opinionated around git repos and local CLI-based agent execution. The intended customization model is:

- repo-owned `backlog.config.mjs` for pass metadata and runner selection
- repo-owned `scripts/backlog/passes/*.md` files for pass policy
- optional `backlog-runner setup --agentic` to bootstrap the first pass set, followed by manual editing
