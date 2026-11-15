#!/usr/bin/env bash
# Copies app/ to dist/ and stamps the current commit's sha into the page (R6).
# Refuses on a dirty tree, so the sha always names exactly what dist/ holds.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain -- app)" ]; then
  echo "build: app/ has uncommitted changes; commit first so the sha matches" >&2
  exit 1
fi
sha=$(git rev-parse --short=7 HEAD)
rm -rf dist
cp -R app dist
sed -i '' "s/__BUILD_SHA__/${sha}/g" dist/index.html
grep -q "content=\"${sha}\"" dist/index.html
echo "built dist/ at ${sha}"
