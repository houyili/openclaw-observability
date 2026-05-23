<!--
Thanks for opening a PR! A few notes:

- Constitution: design_doc_read_only/observablity_design_doc.md
- Public risk register: agents_design_doc/opensource/08_obs_v2_open_source_full_process_risk_register_*
- See CONTRIBUTING.md for repository layout, test layout, commit
  style, and what kinds of changes fit.
-->

## What does this change?

<!-- One paragraph. Focus on user-visible behavior or invariants. -->

## Why?

<!-- Cite the bug, the section of the constitution it implements,
     the risk ID it closes (e.g. R6, R11), or the issue it fixes. -->

## How was it tested?

- [ ] `npm run test:hermetic` passes locally
- [ ] `npm run test:open-source-sanitization` passes locally
- [ ] `bash -n scripts/*.sh` passes locally
- [ ] (if touching ingest/storage/api) `npm run test:integrity` and
      `npm run test:replay` pass locally against my obs.db
- [ ] (if touching token math) `npm run test:cross-check -- --retry-wait 0`
      passes locally

## Checklist

- [ ] My commits are focused (one bug per commit, no drive-by refactors)
- [ ] My commit messages explain the why, not just the what
- [ ] I added or extended a hermetic test for any code change
- [ ] I did NOT add any new npm runtime dependency
- [ ] I did NOT introduce a build step
- [ ] I did NOT couple obs-v2 back to a private fleet
      (private agent name, private workspace path, private prompt)
- [ ] My new test fixtures use only synthetic identifiers
- [ ] I updated CHANGELOG.md under `## Unreleased` if the change is
      user-visible

## Notes for the reviewer

<!-- Anything that is non-obvious from the diff: trade-offs you
     considered, alternatives you rejected, follow-up work you are
     deferring. -->
