# Workflow Graph

Workflow Graph answers: "What happened at the session/workflow level, and
where did parent/child/runtime coordination break?"

## API

```text
GET /api/sessions/:key/workflow?runId=<optional>&sessionId=<optional>
```

Response shape:

```json
{
  "sessionKey": "agent:main:channel:id",
  "sessionId": "runtime-session-id",
  "runId": "run-id",
  "lanes": [],
  "events": [],
  "edges": [],
  "diagnostics": [],
  "runs": []
}
```

## Default Lanes

- `User`
- `Parent Session`
- `OpenClaw Runtime`
- `Child ...`
- `Workflow State`

## Event Types

The public event type names are stable for v0.1:

- `user_message`
- `skill_or_source_step`
- `checkpoint_write`
- `sessions_spawn_requested`
- `sessions_spawn_accepted`
- `sessions_yield`
- `child_started`
- `child_artifact_written`
- `child_final`
- `parent_resumed`
- `taskflow_plan_snapshot`
- `taskflow_child_bound`
- `taskflow_gap`

The `taskflow_*` names are kept for wire compatibility. UI labels are generic
workflow-state labels.

## Provenance

Each event carries the strongest available source references, for example:

- `step_id`
- `run_id`
- `session_key`
- `childSessionKey`
- `child_run_id`
- `artifact_path`
- `flow_id`
- `adapter_id`

## Managed Workflow Adapters

The default adapter reads a generic managed block:

```text
<!-- openclaw-workflow:start -->
flow_id: example
current_step: collect_sources
waiting_children:
- childSessionKey: ...
- runId: ...
<!-- openclaw-workflow:end -->
```

Legacy managed workflow blocks are recognized for existing local data. Set
`OBS_WORKFLOW_ADAPTERS=none` to disable all managed-workflow adapters, or set a
comma-separated allowlist such as `openclaw-managed-workflow`.
