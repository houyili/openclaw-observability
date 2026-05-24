# Maintainers

This file lists the current maintainers of OpenClaw Observability and the
process for becoming one.

## Current Maintainers

| GitHub Handle | Role | Areas |
| --- | --- | --- |
| @houyili | Lead maintainer | Architecture, releases, all subsystems |

## Bus Factor

OpenClaw Observability currently has a bus factor of 1. This is a known
risk and is tracked openly so contributors understand the operational
state of the project. We actively welcome new maintainers — see the
section below.

## Becoming a Maintainer

We use a lightweight "show up and own things" model:

1. Open or fix at least 3 substantive issues / PRs that touch different
   subsystems (ingest, storage, API, frontend, tests, docs, scripts).
2. Demonstrate fluency with the project's hard constraints: zero npm
   runtime dependencies, no build step, no LLM in the observability
   path, no private fleet coupling (see [CONTRIBUTING.md](CONTRIBUTING.md)
   and [docs/api-stability.md](docs/api-stability.md)).
3. Be visible: comment on issues, review PRs, help triage. New
   maintainers come from active reviewers, not first-time contributors.
4. Ask. Open a discussion or DM the current lead maintainer; we will
   pair on one or two PRs to confirm working style.

Once granted, a new maintainer receives:

- Commit access to the `houyili/openclaw-observability` repository
- The `Maintainers` team in GitHub for issue/PR assignment routing
- An entry in this file
- Co-ownership of release decisions

## Responsibilities

Maintainers commit to:

- Triage new issues within ~7 days
- Review PRs within ~7 days
- Cut releases when the changelog warrants
- Keep this file accurate
- Disclose anything that affects bus factor (planned absences, capacity
  changes)

## Stepping Down

There is no formal off-boarding ritual. Open a PR removing your entry
from this file (or ask another maintainer to do it on your behalf) and
note any handoff context in the PR description.
