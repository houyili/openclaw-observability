# Compatibility Notes

OpenClaw Observability keeps compatibility behavior schema-driven so old local
data remains readable without coupling the public project to a private fleet.

## Public Defaults

Public docs and examples use generic OpenClaw language:

- `User`
- `Parent Session`
- `OpenClaw Runtime`
- `Child Session`
- `Workflow State`

Workflow Graph UI labels use those generic terms even when older transcript
data came from project-specific deployments.

## Legacy Session Keys

Older OpenClaw deployments may contain project-specific transport names, agent
ids, and MCP tool prefixes. The parser keeps those rows readable through
generic rules:

- `agent:<agent>:<transport>:group:<id>` is shown as `<transport>-group`.
- `agent:<agent>:<transport>:direct:<id>` is shown as `<transport>-direct`.
- `<server>_<tool>` is classified as an MCP call from `<server>`.
- Managed workflow state is read only from the generic
  `openclaw-workflow` marker.

Allowed compatibility surfaces:

- `src/ingest/auth-poller.ts`: schema-based channel inference.
- `src/ingest/tool-classifier.ts`: schema-based MCP server inference.
- `src/storage/workflow-repo.ts`: generic managed-workflow marker detection.
- Tests that exercise the generic compatibility paths.

Compatibility inputs are data, not product branding or source-level coupling.
