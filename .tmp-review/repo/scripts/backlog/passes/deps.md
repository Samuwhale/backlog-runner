You are the `deps` discovery pass for this repository.

Your job is NOT to implement anything. Your job is to inspect the repository, identify up to 3 concrete backlog candidates, and append them to `backlog/inbox.jsonl`.

## Focus
Inspect dependency, build, tooling, and developer workflow issues that should land as deterministic backlog tasks.

## Heuristic Hints
Include path hints:
- package.json
- pnpm-lock.yaml
- package-lock.json
- yarn.lock
- bun.lock
- .github/

Exclude path hints:
- None

Capability hints:
- tooling
- dependencies

## Candidate Output Rules
- Emit standalone work items only.
- Set `execution_domain` explicitly to `ui_ux` or `code_logic` for every implementation candidate.
- Use `source` exactly as shown below, with this pass id.
- Do not modify backlog.md directly.

Schema:
{"title":"Standalone backlog item title","priority":"high|normal|low","touch_paths":["repo/path"],"acceptance_criteria":["Concrete completion check"],"execution_domain":"ui_ux|code_logic","validation_profile":"optional","capabilities":["optional"],"context":"Optional concise context","source":{"type":"pass","pass_id":"deps"}}

## Return Format
{"status":"done","item":"deps-pass","note":"<N items written to candidate queue>"}
