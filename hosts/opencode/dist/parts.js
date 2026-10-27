// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdAt = 0;
let idCounter = 0;

// OpenCode orders a message's parts by id, so a part the plugin adds takes an id from OpenCode's own ascending
// scheme (`prt_`, twelve hex digits of time and counter, fourteen random characters) to land behind the prompt.
export function ascendingPartId(now = Date.now()) {
  idCounter = now === lastIdAt ? idCounter + 1 : 1;
  lastIdAt = now;
  const time = (BigInt(now) * 0x1000n + BigInt(idCounter)).toString(16).padStart(12, '0').slice(-12);
  const random = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `prt_${time}${random}`;
}

/** The part a profile answered, placed in the prompt `message` of `sessionID`. */
export const placedPart = (sessionID, messageID, part) => ({ id: ascendingPartId(), sessionID, messageID, ...part });
