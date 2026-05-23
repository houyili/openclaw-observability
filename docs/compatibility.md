# Compatibility Notes

OpenClaw Observability keeps a small amount of legacy parsing behavior so old
local data remains readable after v0.1.0.

## Public Defaults

Public docs and examples use generic OpenClaw language:

- `User`
- `Parent Session`
- `OpenClaw Runtime`
- `Child Session`
- `Workflow State`

Workflow Graph UI labels use those generic terms even when older transcript
data came from a project-specific workflow.

## Legacy Session Keys

Older OpenClaw deployments may contain session keys and channels with names
such as `feishu` or agent ids from private local fleets. The parser still
recognizes those strings because they are part of historical session keys and
MCP tool names. Removing that support would change data correctness.

Allowed compatibility surfaces:

- `src/ingest/auth-poller.ts`: historical channel inference.
- `src/ingest/tool-classifier.ts`: historical MCP server inference.
- `src/storage/workflow-repo.ts`: legacy managed-workflow marker detection.
- Tests that explicitly exercise those compatibility paths.

These strings are compatibility inputs, not public product branding.
