#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EvoMap

# Usage: scripts/publish-tag.sh vX.Y.Z [release branch]   (from a checkout of the tag, after
#        node scripts/pack.mjs all dist --version=vX.Y.Z; the branch defaults to release)
# Publishes the tag a maintainer pushed on main: one commit more on the release branch, the tagged source plus the
# packed dist/, and the tag re-pointed at it, in one atomic push. The hosts install from that branch, so nothing on
# main names a version. A tag already published is left alone, a tag off main or older than the release is refused,
# and the push only replaces the tag the maintainer pushed.

set -euo pipefail

tag="$1"
branch="${2:-release}"
source_commit="$(git rev-parse HEAD)"

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "$tag is not a release tag (vX.Y.Z)." >&2
  exit 1
fi

if [ ! -d dist ]; then
  echo "No dist/ folder: run node scripts/pack.mjs all dist --version=$tag first." >&2
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

parents=()
listed=0
git ls-remote --exit-code origin "refs/heads/$branch" > /dev/null || listed=$?
if [ "$listed" -eq 0 ]; then
  git fetch --quiet origin "refs/heads/$branch"
  previous="$(git rev-parse FETCH_HEAD)"
  previous_source="$(git log -1 --format=%B "$previous" | sed -n 's/^main at \([0-9a-f]\{40\}\).*/\1/p')"
  if [ -n "$previous_source" ] && [ "$previous_source" != "$source_commit" ] && git merge-base --is-ancestor "$source_commit" "$previous_source"; then
    echo "$tag is older than what $branch holds ($previous_source): a release only moves forward." >&2
    exit 1
  fi
  parents=(-p "$previous")
elif [ "$listed" -ne 2 ]; then
  echo "Could not list origin's branches (git exit $listed)." >&2
  exit "$listed"
fi

index="$(mktemp)"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add --force dist
tree="$(GIT_INDEX_FILE="$index" git write-tree)"

commit="$(git commit-tree "$tree" ${parents[@]+"${parents[@]}"} \
  -m "Release $tag" \
  -m "main at $source_commit, with dist/ packed by scripts/pack.mjs at $tag.")"
git tag --force --annotate "$tag" --message "Release $tag" "$commit"
git push --quiet --atomic --force-with-lease="refs/tags/$tag:$pushed" origin "$commit:refs/heads/$branch" "refs/tags/$tag"
echo "Published $tag at $commit on $branch."
