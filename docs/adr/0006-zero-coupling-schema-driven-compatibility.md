# 0006: Keep zero coupling to private fleets via schema-driven compatibility

- Status: Accepted
- Date: 2026-05-23
- Deciders: @houyili
- Related: Round 8 open-source remediation, [docs/compatibility.md](../compatibility.md)

## Context

OpenClaw Observability grew up reading data from a specific private
deployment. Several pieces of pre-v0.1.x logic carried artifacts of that
origin:

- The Workflow Graph "wire-type" classifier had branches that named
  specific private chat transports.
- Channel inference for session keys had branches keyed on specific
  agent names and on private MCP server prefixes.
- Managed workflow blocks were keyed on a private marker that did not
  exist anywhere outside the original deployment.

For an Apache-2.0 open-source release, this was both a privacy concern
(private fleet metadata baked into source) and a compatibility concern
(other deployments would not match the hard-coded names). The fix had to
preserve historical data — the operator's existing `obs.db` must keep
reading correctly after the upgrade — and it had to leave no allow-list
of private names anywhere in the public source tree.

## Decision

Replace every name-driven branch with a **schema-driven generic rule**
keyed only on the publicly documented session-key and tool-id formats.

Concretely:

- Any session key that matches the public shape
  `agent:<agent>:<transport>:<kind>:<id>` is classified by structure as
  `<transport>-<kind>`. No private transport name appears in the source.
- Any tool name of the form `<server>_<tool>` that is not in the small
  builtin tool list is classified as an MCP call attributed to
  `<server>`. The MCP scanner reads `~/.openclaw/openclaw.json` and
  `~/.openclaw/mcp/*.json` to confirm registry membership, but the
  classification rule itself does not consult any allow-list.
- Managed workflow blocks read only the public `openclaw-workflow`
  marker, which is documented in `docs/workflow-graph.md`. Private
  markers are not recognized.

A standing hermetic test (`open-source-sanitization`) sweeps the source
tree for any string that looks like private fleet metadata and fails the
build if it finds one.

## Consequences

What becomes easier:

- The published source tree contains no allow-list of private names.
- Any deployment whose session keys and tool ids follow the public shape
  works automatically — no patching required.
- Historical `obs.db` rows continue to read correctly because the
  classification rules are about shape, not about names.

What becomes harder:

- Specialised classifications that were "free" when we knew the names
  (e.g. distinguishing two private MCP servers that share a prefix)
  have to be solved with public structural cues or moved into a local
  config file.

What we accept:

- A small classification-precision cost in exchange for an open-source
  posture that is honestly free of private metadata.
- A standing sanitization test as a permanent maintenance surface.
