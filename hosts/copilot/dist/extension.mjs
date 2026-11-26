// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isHeadlessRun } from '../../../lib/channels/plugin/adapter.js';
import { connectCopilot } from './adapter.js';

if (!isHeadlessRun()) {
  const { joinSession } = await import('@github/copilot-sdk/extension');
  await connectCopilot(joinSession);
}
