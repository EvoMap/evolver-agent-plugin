// What `evolver login` (@evomap/evolver-cli 2.0.46, dist/login.js) writes, character for character.
export const deviceText = (verificationUri, userCode) => `\nTo authorize this device:\n`
  + `  1. open  ${verificationUri}\n`
  + `  2. enter code:  ${userCode}\n\n`
  + `Waiting for approval (Ctrl-C to cancel)...\n`;
export const signedInText = (hubUrl, credPath = '/home/me/.evomap/token.json', exp = '2026-10-27T08:11:34.470Z') =>
  `\n✓ Logged in to ${hubUrl}. Token stored at ${credPath} (expires ${exp}).\n`;
export const failedText = (message) => `login failed: ${message}\n`;
