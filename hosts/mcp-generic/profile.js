// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { defineProfile } from '../../lib/agent/profile.js';

// Any MCP client without hooks (Kiro, openclaw, …): everything comes from the MCP channel's defaults.
export default defineProfile({ name: 'mcp-generic', label: 'MCP client', channel: 'mcp' });
