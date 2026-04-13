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

That creates:

- `backlog.config.mjs`
- `backlog/`
- `scripts/backlog/`
- `.backlog-runner/`

Then customize:

1. Update `validationCommand` and `validationProfiles` in `backlog.config.mjs`.
2. Read `scripts/backlog/README.md` for the repo-local pass authoring model.
3. Adjust `scripts/backlog/passes/*.md` prompts to fit your workflow.
4. Tune `heuristics.validationProfileRules` and `heuristics.uiPathPrefixes` for your codebase.

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
  },
  passes: {
    frontend: {
      kind: 'discovery',
      promptFile: './scripts/backlog/passes/frontend.md',
      runner: { tool: 'claude', model: 'claude-opus-4-6' },
    },
    deps: {
      kind: 'discovery',
      promptFile: './scripts/backlog/passes/deps.md',
      runner: { tool: 'codex', model: 'gpt-5.4' },
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
