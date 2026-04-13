import { defineBacklogRunnerConfig } from 'backlog-runner';

export default defineBacklogRunnerConfig(
{
  "projectRoot": "../repo",
  "files": {
    "backlog": "../repo/backlog.md",
    "candidateQueue": "../repo/backlog/inbox.jsonl",
    "candidateRejectLog": "../repo/.backlog-runner/candidate-rejections.jsonl",
    "taskSpecsDir": "../repo/backlog/tasks",
    "stop": "../repo/backlog-stop",
    "runtimeReport": "../repo/.backlog-runner/runtime-report.md",
    "patterns": "../repo/scripts/backlog/patterns.md",
    "progress": "../repo/scripts/backlog/progress.txt",
    "stateDb": "../repo/.backlog-runner/state.sqlite",
    "models": "../repo/scripts/backlog/models.json",
    "runnerLogDir": "../repo/.backlog-runner/logs",
    "runtimeDir": "../repo/.backlog-runner",
    "locksDir": "../repo/.backlog-runner/locks"
  },
  "prompts": {
    "agent": "../repo/scripts/backlog/agent.md",
    "planner": "../repo/scripts/backlog/planner.md"
  },
  "validationCommand": "bash scripts/backlog/validate.sh",
  "validationProfiles": {
    "repo": "bash scripts/backlog/validate.sh"
  },
  "heuristics": {
    "backlogRuntimePaths": [
      "backlog/",
      ".backlog-runner/",
      "scripts/backlog/"
    ],
    "uiPathPrefixes": [
      "src/ui/",
      "src/components/",
      "src/routes/",
      "src/pages/",
      "app/",
      "apps/web/",
      "frontend/",
      "web/"
    ],
    "validationProfileRules": []
  },
  "workspaceBootstrap": {
    "installCommand": "npm install",
    "repairCommand": "backlog-runner doctor --repair"
  },
  "runners": {
    "taskUi": {
      "tool": "claude",
      "model": "claude-opus-4-6"
    },
    "taskCode": {
      "tool": "codex",
      "model": "gpt-5.4"
    },
    "planner": {
      "tool": "codex",
      "model": "gpt-5.4"
    }
  },
  "defaults": {
    "workers": 2,
    "passes": true,
    "worktrees": true
  },
  "passes": {
    "deps": {
      "kind": "discovery",
      "enabled": true,
      "description": "Inspect dependency, build, tooling, and developer workflow issues that should land as deterministic backlog tasks.",
      "promptFile": "../repo/scripts/backlog/passes/deps.md",
      "runner": {
        "tool": "codex",
        "model": "gpt-5.4"
      },
      "heuristics": {
        "includePaths": [
          "package.json",
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
          "bun.lock",
          ".github/"
        ],
        "excludePaths": [],
        "capabilities": [
          "tooling",
          "dependencies"
        ]
      }
    },
    "docs": {
      "kind": "discovery",
      "enabled": true,
      "description": "Inspect repository docs, onboarding, and operator guidance for gaps that should become standalone backlog work.",
      "promptFile": "../repo/scripts/backlog/passes/docs.md",
      "runner": {
        "tool": "claude",
        "model": "claude-opus-4-6"
      },
      "heuristics": {
        "includePaths": [
          "README.md"
        ],
        "excludePaths": [],
        "capabilities": [
          "documentation"
        ]
      }
    },
    "qa": {
      "kind": "discovery",
      "enabled": true,
      "description": "Inspect qa-related gaps in this repository and file standalone backlog work.",
      "promptFile": "../repo/scripts/backlog/passes/qa.md"
    }
  }
}
);
