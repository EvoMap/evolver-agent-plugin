#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EvoMap

# Usage: scripts/publish-release-branch.sh [release branch] [source branch]   (defaults: release main)
# Commits HEAD's tree plus the packed dist/ onto the release branch at origin, one commit per build, and pushes it.
# The hosts' marketplaces install from that branch. Only the source branch's tip is published, so a run that
# finishes after a newer push, or a re-run of an old one, never moves the branch back. It never force-pushes: a
# branch that moved apart fails the push.

set -euo pipefail

branch="${1:-release}"
source_branch="${2:-main}"
source_commit="$(git rev-parse HEAD)"

if [ ! -d dist ]; then
  echo "No dist/ folder: run npm run pack first." >&2
  exit 1
fi

source_tip="$(git ls-remote --exit-code origin "refs/heads/$source_branch" | cut -f1)"
if [ "$source_tip" != "$source_commit" ]; then
  echo "$source_branch is at $source_tip now, not $source_commit: its own run publishes it."
  exit 0
fi

index="$(mktemp)"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add --force dist
tree="$(GIT_INDEX_FILE="$index" git write-tree)"

parents=()
listed=0
git ls-remote --exit-code origin "refs/heads/$branch" > /dev/null || listed=$?
if [ "$listed" -eq 0 ]; then
  git fetch --quiet --depth=1 origin "refs/heads/$branch"
  previous="$(git rev-parse FETCH_HEAD)"
  if [ "$(git rev-parse "$previous^{tree}")" = "$tree" ]; then
    echo "$branch already holds the build of $source_commit."
    exit 0
  fi
  parents=(-p "$previous")
elif [ "$listed" -ne 2 ]; then
  echo "Could not list origin's branches (git exit $listed)." >&2
  exit "$listed"
fi

commit="$(git commit-tree "$tree" ${parents[@]+"${parents[@]}"} \
  -m "Release ${source_commit:0:7}" \
  -m "$source_branch at $source_commit, with dist/ packed by scripts/pack.mjs.")"
git push --quiet origin "$commit:refs/heads/$branch"
echo "Pushed $commit to $branch."
