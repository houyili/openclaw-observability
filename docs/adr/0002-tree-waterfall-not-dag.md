# 0002: Render execution as tree + waterfall Gantt, not DAG

- Status: Accepted
- Date: 2026-04-05
- Deciders: @houyili
- Related: v0 architecture snapshot, prior-art survey of LLM observability tools

## Context

When designing the trace-view of a session, the obvious shape question is:
tree, waterfall, or DAG?

A pre-implementation survey of comparable LLM observability products
(Langfuse, Arize Phoenix, LangSmith, W&B Weave) found that all four
present trace data as a tree on the left plus a waterfall / Gantt timeline
on the right. None of them use a DAG layout for execution traces.

The reason is structural, not stylistic. An LLM agent's execution model is
a ReAct loop — Reason, Act, Observe, repeat — and that is fundamentally a
tree (parent → children), not a DAG. Parallel tool calls express naturally
as siblings under the same parent: multiple Gantt bars at the same depth,
all rooted in the same assistant turn. There is no fan-out / fan-in shape
that DAG layout exists to handle.

A DAG layout library would also conflict with this project's hard
constraint of zero npm runtime dependencies and zero build step (see
[CONTRIBUTING.md](../../CONTRIBUTING.md)). The available libraries
(`dagre`, `cytoscape`, `elkjs`) are tens to hundreds of kilobytes of
JavaScript that need a bundler.

## Decision

Render the trace view as a tree on the left and a waterfall Gantt timeline
on the right, using plain CSS grid and proportional widths. No external
graph library, no bundler, no transpiler.

The tree is built from `(session_key, run_id, parent_step_id)` in the
`steps` table. Gantt-bar widths are computed from each step's
`duration_ms` divided by the run's total elapsed time.

## Consequences

What becomes easier:

- The frontend stays in the zero-dependency, zero-build-step regime that
  the project promises operators.
- The mental model matches every other tool in this category, so a
  reader who has used Langfuse or LangSmith already understands the view.
- Parallel tool calls, deeply nested subagent spawns, and synchronous
  tool chains all render with the same primitives.

What becomes harder:

- Anything that genuinely needs a DAG (e.g. visualizing a future workflow
  graph that has fan-in joins) will need either a separate, narrower
  view or a deliberate dependency decision.

What we accept:

- We give up the freedom to lay out unusual cross-link shapes. If the
  execution model later evolves into something that is not a tree, this
  ADR will need to be revisited.
