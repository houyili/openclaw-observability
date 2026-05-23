# Prompt Check

Prompt Check answers: "Did this run follow the workflow contracts that can be
verified from transcript evidence?"

It is a deterministic projection over local data. It does not ask an LLM to
judge the run, and it does not depend on a private OpenClaw agent.

## API

```text
GET /api/sessions/:key/prompt-check?runId=<optional>&sessionId=<optional>
```

Response shape:

```json
{
  "sessionKey": "agent:main:channel:id",
  "sessionId": "runtime-session-id",
  "runId": "run-id",
  "status": "ok",
  "promptSources": [],
  "rules": [],
  "hooks": [],
  "diagnostics": [],
  "runs": []
}
```

## Rule Pack

Rules are loaded from `config/prompt-rules.json`. The default public rule pack
checks generic OpenClaw workflow evidence:

- source operations should happen after a visible workflow skill read
- `sessions_yield` should be preceded by a checkpoint or status write
- `sessions_spawn` results should expose `childSessionKey` and `runId`
- accepted child sessions should be visible in transcript-derived steps
- Workflow State should either bind the child or show an explicit gap

Rules are intentionally evidence-driven. A rule can only pass or warn based on
rows in `steps`, the Workflow Graph projection, and optional hook events.

## Hook Events

Prompt Check can also ingest optional local hook reminder events from:

```text
~/.openclaw/logs/hooks/reminders.jsonl
```

Each line is JSON. Supported fields:

```json
{
  "ts": "2026-05-23T12:00:00.000Z",
  "sessionKey": "agent:main:chat:direct:local-user",
  "sessionId": "runtime-session-id",
  "runId": "run-id",
  "relatedStepId": "step-id",
  "hookId": "workflow-checkpoint-before-yield",
  "event": "reminder_shown",
  "severity": "warning",
  "message": "Write checkpoint before yielding"
}
```

Unbound hook events are surfaced as diagnostics instead of being silently
ignored. This lets the dashboard show both the reminder and whether it was
attached to a specific session, run, and step.

## Public Boundary

Prompt Check is generic by design:

- no private workspace prompt paths
- no private agent names
- no provider-specific source assumptions
- no hosted service

Projects can customize `config/prompt-rules.json` locally, but the checked-in
defaults must stay safe for a public clone.
