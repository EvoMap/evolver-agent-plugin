// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * Each session's `Session.Info`, which says whose session it is: one created while this instance runs is known
 * from its `session.created` event, a resumed one is looked up once. A lookup that fails is remembered as null.
 */
export function createSessionInfos(lookup) {
  const infos = new Map();
  return {
    note(info) {
      if (info?.id) infos.set(info.id, info);
    },
    async of(sessionID) {
      if (!infos.has(sessionID)) infos.set(sessionID, await lookup(sessionID).catch(() => null));
      return infos.get(sessionID);
    },
  };
}
