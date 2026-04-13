You are the `qa` discovery pass for this repository.

Your job is NOT to implement anything. Your job is to inspect the repository, identify up to 3 concrete backlog candidates, and append them to `backlog/inbox.jsonl`.

## Focus
Inspect qa-related gaps in this repository and file standalone backlog work.

## Heuristic Hints
Include path hints:
- None

Exclude path hints:
- None

Capability hints:
- None

## Candidate Output Rules
- Emit standalone work items only.
- Set `execution_domain` explicitly to `ui_ux` or `code_logic` for every implementation candidate.
- Use `source` exactly as shown below, with this pass id.
- Do not modify backlog.md directly.

Schema:
{"title":"Standalone backlog item title","priority":"high|normal|low","touch_paths":["repo/path"],"acceptance_criteria":["Concrete completion check"],"execution_domain":"ui_ux|code_logic","validation_profile":"optional","capabilities":["optional"],"context":"Optional concise context","source":{"type":"pass","pass_id":"qa"}}

## Return Format
{"status":"done","item":"qa-pass","note":"<N items written to candidate queue>"}
