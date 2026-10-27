#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EvoMap

# Usage: scripts/publish-release-branch.sh [branch]   (default: release)
# Commits HEAD's tree plus the packed dist/ onto the branch at origin, one commit per build, and pushes it. The
# hosts' marketplaces install from that branch. It never force-pushes: a branch that moved apart fails the push.

set -euo pipefail

branch="${1:-release}"
source_commit="$(git rev-parse HEAD)"

if [ ! -d dist ]; then
  echo "No dist/ folder: run npm run pack first." >&2
  exit 1
fi

index="$(mktemp)"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add --force dist
tree="$(GIT_INDEX_FILE="$index" git write-tree)"

parents=()
if git ls-remote --exit-code origin "refs/heads/$branch" > /dev/null; then
  git fetch --quiet --depth=1 origin "refs/heads/$branch"
  previous="$(git rev-parse FETCH_HEAD)"
  if [ "$(git rev-parse "$previous^{tree}")" = "$tree" ]; then
    echo "$branch already holds the build of $source_commit."
    exit 0
  fi
  parents=(-p "$previous")
fi

commit="$(git commit-tree "$tree" ${parents[@]+"${parents[@]}"} \
  -m "Release ${source_commit:0:7}" \
  -m "main at $source_commit, with dist/ packed by scripts/pack.mjs.")"
git push --quiet origin "$commit:refs/heads/$branch"
echo "Pushed $commit to $branch."
