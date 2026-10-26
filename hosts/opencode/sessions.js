// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// OpenCode fires every plugin hook for every session, so whose session a hook fired for is read off the session
// itself: a task tool's child session has a parent, and this plugin's own distillation helper carries a mark in
// its metadata, which reaches every process that looks the session up.

export const HELPER_METADATA = Object.freeze({ evolver: 'distill' });

export const isHelperSession = (info) => info?.metadata?.evolver === HELPER_METADATA.evolver;

/** Only the person's own sessions are recalled for and reported; a session nobody could look up counts as theirs. */
export const isPersonSession = (info) => !isHelperSession(info) && !info?.parentID;
