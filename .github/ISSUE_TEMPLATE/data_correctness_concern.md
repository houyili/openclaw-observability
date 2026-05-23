---
name: Data correctness concern
about: The dashboard shows numbers that disagree with official OpenClaw data or with what you can verify by hand.
title: "correctness: "
labels: ["correctness"]
---

> The constitution (`design_doc_read_only/observablity_design_doc.md`
> §1.3.1) requires obs-v2's main table values to match the official
> OpenClaw dashboard. This template helps us reproduce and triage
> divergences.

## Summary

<!-- One sentence: what number is wrong? -->

## Environment

- obs-v2 version (tag or commit SHA):
- Node.js version:
- OpenClaw CLI version:

## What does obs-v2 show?

```text
# Example:
# /api/sessions row for session XYZ shows total_tokens=12345
# /healthz reports tokenSource="transcript-backfill"
```

## What does the official OpenClaw dashboard / CLI show?

```text
# Example:
openclaw sessions --all-agents --active 60 --json | jq '.[] | select(.key=="...") | {totalTokens, inputTokens, outputTokens}'
```

Please redact the identifying suffix of any session key
(e.g. `agent:<agent>:<transport>:<kind>:...<last4>`).

## Cross-check output

If you can, please run:

```bash
npm run test:cross-check -- --retry-wait 0
npm run test:integrity
npm run test:replay
```

and paste the **failing** assertions only.

## Hypothesis

<!-- What do you think is wrong? Parser? Token aggregation?
     `recomputeSessionCounts`? Auth-poller cache? -->

## Additional context

<!-- Anything else. -->
