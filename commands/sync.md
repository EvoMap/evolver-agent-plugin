---
description: Sync evolution assets (genes/capsules) between the local store and the EvoMap Hub.
argument-hint: "[--scope=all|purchased|published] [--type=Gene|Capsule] [--export=<path.gepx>] [--dry-run]"
---

Sync Evolver assets with the EvoMap Hub.

Read the user's arguments: `$ARGUMENTS`. Use the installed
`evolver` executable, or `npx -y @evomap/evolver` when absent, and invoke its `sync`
subcommand followed by those exact arguments. Preserve `--dry-run`, scope, type, and export
paths exactly as supplied.

Summarize how many assets were pulled or updated, any local-only assets, and the `.gepx`
archive path when `--export` was used. If node identity or Hub credentials are missing,
point the user to `/evolver-status` and the README's network setup section.
