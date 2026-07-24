#!/usr/bin/env bash
# Baut das Plugin (main.js) reproduzierbar im Docker-Container - kein Node auf dem Host noetig.
# Nutzung:  bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

docker run --rm -v "${DIR}:/app" -w /app node:22-alpine sh -c '
  npm install --legacy-peer-deps --no-audit --no-fund &&
  npx tsc --noEmit --skipLibCheck &&
  node esbuild.config.mjs production
'
echo "Fertig -> main.js"
ls -la main.js manifest.json styles.css
