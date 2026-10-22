#!/usr/bin/env bash
# Hot reload watches the files of a real folder: a symlinked plugin loads once
# and never reloads, so a dev copy is synced instead, sharing node_modules.
set -euo pipefail
target="${1:?usage: sync-dev-mod.sh <dev-mods plugin folder>}"
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$target"
rsync -a --delete --exclude node_modules --exclude .claude --exclude .claude-plugin/types "$source_dir/" "$target/"
ln -sfn "$source_dir/node_modules" "$target/node_modules"
