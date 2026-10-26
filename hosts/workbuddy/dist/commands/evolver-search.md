---
description: "Find the EvoMap strategy that best fits a task and add it to the conversation."
argument-hint: "<task description or error text>"
---

!`CODEBUDDY_PLUGIN_DATA="${CODEBUDDY_PLUGIN_DATA}" exec node "${CODEBUDDY_PLUGIN_ROOT}/bin/command.mjs" workbuddy evolver-search <<'EVOLVER_ARGUMENTS'
$ARGUMENTS
EVOLVER_ARGUMENTS`

Show the output above to the user as it is. Do not call any other tool or command for it.
