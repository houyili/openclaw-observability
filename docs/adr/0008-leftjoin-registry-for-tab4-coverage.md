# 0008: LEFT JOIN registry in `getMcpStats` so installed-but-unused MCPs surface

- Status: Accepted
- Date: 2026-05-24
- Deciders: @houyili
- Related: Round 8 R11 + R12, OpenClaw observability constitution §4.3.1,
  hermetic suite `mcp-registry-coverage.test.ts`

## Context

The user-facing constitution for this dashboard (§4.3.1) states clearly:

> Every MCP installed on the local machine must appear on Tab 4,
> including ones that have never been called.

Pre-v0.1.2 the implementation did not honour that contract. Two
compounding bugs were responsible:

1. `getMcpStats` aggregated only over the `steps` table:
   `FROM steps WHERE node_type = 'MCP_CALL'`. An MCP that had never been
   called had no rows in `steps`, so it did not appear on Tab 4. By
   contrast, `getSkillStats` already used a `FROM registry r LEFT JOIN
   steps s` shape and surfaced installed-but-unused skills correctly.
2. The registry scanner was reading `~/.openclaw/settings.json`, a path
   that does not exist on any real OpenClaw install. The actual MCP
   configuration lives in `~/.openclaw/openclaw.json` under
   `mcp.servers` and `mcpServers`, and additionally in
   `~/.openclaw/mcp/*.json` under `mcpServers`. As a result the
   registry table was never populated with any MCP entries on real
   machines, and even if `getMcpStats` had used a `LEFT JOIN`, the
   right side would have been empty.

The combined effect was that Tab 4 never met the constitution
requirement on any real install — only MCPs that happened to have been
called in the visible time window were ever shown.

## Decision

Two coordinated fixes shipped in v0.1.2:

1. Rewrite the registry scanner to read `~/.openclaw/openclaw.json`'s
   `mcp.servers` and `mcpServers` sections, plus
   `~/.openclaw/mcp/*.json::mcpServers` (skipping `*.example.*` and
   `*.template.json` files). Dedupe by server name with `openclaw.json`
   taking precedence.
2. Rewrite `getMcpStats` to follow the same shape as `getSkillStats`:

   ```sql
   FROM registry r
   LEFT JOIN steps s
     ON s.mcp_tool = r.name
    AND s.node_type = 'MCP_CALL'
    AND s.ts_epoch_ms >= ?
   WHERE r.type = 'mcp'
   GROUP BY r.name, r.status, r.path
   ORDER BY call_count DESC, r.name ASC
   ```

   The `error_rate` is wrapped in `CASE WHEN COUNT > 0 THEN ... ELSE 0
   END` to avoid divide-by-zero for unused MCPs.

A new hermetic suite, `mcp-registry-coverage.test.ts` (47 assertions),
locks the contract in: it seeds a registry with installed MCPs, runs no
calls, asserts every installed MCP shows up on Tab 4 with `call_count =
0`, and additionally tests the merge / dedupe / file-skip logic of the
scanner.

## Consequences

What becomes easier:

- Tab 4 now matches the constitution on every real install.
- The MCP and skill code paths now have the same query shape, so
  changes to one are easy to mirror to the other.
- New MCP sources can be added to the scanner in one place without
  touching any aggregation SQL.

What becomes harder:

- A `LEFT JOIN` always touches the registry table, but registries are
  small (tens of entries) and the live `perf-bench` measurement after
  the change still shows `getMcpStats` at sub-2 ms, well inside the
  100 ms budget.

What we accept:

- A permanent dependence on the registry table being kept fresh by the
  scanner. The scanner runs at startup and on each registry refresh
  tick, and is itself covered by the hermetic suite.
