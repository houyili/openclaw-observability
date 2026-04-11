#!/bin/bash
cd "$(dirname "$0")/.."
exec node --experimental-sqlite --experimental-strip-types --no-warnings src/index.ts
