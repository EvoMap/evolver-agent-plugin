#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EvoMap

# Usage: scripts/publish-tag.sh vX.Y.Z   (run from a checkout of that tag, after npm run pack)
# Re-points the release tag a maintainer pushed on main at one commit more: the tagged source plus the packed dist/,
# which the hosts install from. A tag that already holds dist/ is left alone, so a re-run changes nothing, and the
# push only replaces the tag the maintainer pushed: a tag moved meanwhile fails it.

set -euo pipefail

tag="$1"
source_commit="$(git rev-parse HEAD)"

if [ ! -d dist ]; then
  echo "No dist/ folder: run npm run pack first." >&2
  exit 1
fi

if git cat-file -e "$source_commit:dist" 2>/dev/null; then
  echo "$tag already holds dist/: it is published."
  exit 0
fi

git fetch --quiet origin main
if ! git merge-base --is-ancestor "$source_commit" FETCH_HEAD; then
  echo "$tag points at $source_commit, which is not on main: only main is released." >&2
  exit 1
fi

pushed="$(git ls-remote --exit-code origin "refs/tags/$tag" | cut -f1)"

index="$(mktemp)"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add --force dist
tree="$(GIT_INDEX_FILE="$index" git write-tree)"

commit="$(git commit-tree "$tree" -p "$source_commit" \
  -m "Release $tag" \
  -m "main at $source_commit, with dist/ packed by scripts/pack.mjs.")"
git tag --force --annotate "$tag" --message "Release $tag" "$commit"
git push --quiet --force-with-lease="refs/tags/$tag:$pushed" origin "refs/tags/$tag"
echo "Published $tag at $commit."
