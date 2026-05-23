---
name: Bug report
about: Something is broken in the dashboard, install scripts, or API.
title: "bug: "
labels: ["bug"]
---

## Summary

<!-- One sentence: what does not work? -->

## Environment

- obs-v2 version (tag or commit SHA):
- Node.js version (`node -v`):
- OS:
- OpenClaw CLI version (`openclaw --version`, if applicable):

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What should have happened? -->

## Actual behavior

<!-- What actually happened? -->

## Relevant output

```text
# Service logs:
./scripts/service.sh logs

# Doctor:
./scripts/doctor.sh

# Health endpoint:
curl http://127.0.0.1:18902/healthz
```

If you paste session keys from your local obs.db, please redact the
identifying suffix (e.g. `agent:<agent>:<transport>:<kind>:...<last4>`).

## Additional context

<!-- Anything else: screenshots, related PRs, theories about root
     cause. -->
