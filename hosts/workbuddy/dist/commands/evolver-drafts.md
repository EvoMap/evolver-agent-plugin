---
description: "List distilled drafts; publish one to the EvoMap Hub for review, or discard it."
argument-hint: "[publish|discard <number>]"
---

!`CODEBUDDY_PLUGIN_DATA="${CODEBUDDY_PLUGIN_DATA}" exec node "${CODEBUDDY_PLUGIN_ROOT}/bin/command.mjs" workbuddy evolver-drafts <<'EVOLVER_ARGUMENTS'
$ARGUMENTS
EVOLVER_ARGUMENTS`

Show the output above to the user as it is. Do not call any other tool or command for it.
