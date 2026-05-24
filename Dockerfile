# syntax=docker/dockerfile:1.7
#
# OpenClaw Observability — Docker image
#
# Two-stage build:
#   - "src" stage: scratch-like, only copies the versioned source tree.
#   - "runtime" stage: node:22-alpine with the versioned source tree
#     plus the entrypoint flag dance for --experimental-sqlite and
#     --experimental-strip-types.
#
# Hard constraints honored:
#   - No npm install (project ships with zero runtime dependencies).
#   - No build step (--experimental-strip-types reads TypeScript directly).
#   - Image stays small (~80MB on top of node:22-alpine base).
#
# Volume contract:
#   - Mount the host's $OPENCLAW_HOME (or a synthetic equivalent) to
#     /openclaw inside the container, then set OPENCLAW_HOME=/openclaw.
#     This gives obs-v2 access to transcripts at /openclaw/agents/ and
#     a writable obs.db location at /openclaw/logs/observability-v2/.
#   - OBS_PORT defaults to 18902 but can be overridden via env.
#
# OpenClaw CLI availability:
#   - The image does NOT ship the `openclaw` CLI. auth-poller will log
#     a failure every poll cycle, but transcript ingest (the main data
#     source) still works. /healthz will report `authPoll.stale=true`.
#   - See docs/install/docker.md for the OpenClaw CLI sidecar pattern.

FROM node:22-alpine AS runtime

# tini gives us proper PID 1 signal handling so docker stop is clean.
RUN apk add --no-cache tini

WORKDIR /app

# Copy only the versioned source tree (filtered further by .dockerignore).
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY tests ./tests
COPY docs ./docs
COPY README.md DATA_ACCESS.md LICENSE CHANGELOG.md ./

# Defaults — override via `docker run -e` or compose.
ENV NODE_OPTIONS="--experimental-sqlite --experimental-strip-types --no-warnings" \
    OBS_HOST=0.0.0.0 \
    OBS_PORT=18902 \
    OPENCLAW_HOME=/openclaw

# Sanity: the directory the dashboard expects to exist for obs.db.
RUN mkdir -p /openclaw/logs/observability-v2 /openclaw/agents

EXPOSE 18902

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.ts"]
