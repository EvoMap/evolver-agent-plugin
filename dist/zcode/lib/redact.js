// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const JSON_SECRET_KEYS = [
  /"(?:[A-Za-z0-9]+[_-])*(?:(?:api|access|private|secret|auth|signing|encryption)[_-]?key|client[_-]?secret|secret|token|passw(?:or)?d|pwd)"\s*:\s*/gi,
  /"[A-Z][A-Z0-9_]*_(?:KEY|CREDENTIALS?)"\s*:\s*/g,
  // A bare Key suffix also belongs to ordinary JSON fields such as primaryKey.
  /"[A-Za-z][A-Za-z0-9_-]*(?:(?:Api|API|Access|Private|Secret|Auth|Signing|Encryption)Key|Token|Secret|Password|Passwd|Pwd|Credentials?)"\s*:\s*/g,
];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // A start that an earlier one in the same run already tried cannot match where that one failed; skipping it scans a
  // long run once instead of once per word boundary in it.
  /\beyJ(?<!\beyJ[A-Za-z0-9_-]*?eyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?=[a-z])(?<!\b[a-z][a-z0-9+.-]*?)[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
  // Quoted JSON placeholders already hold the redacted value and keep their key.
  /\b(?<!(?<!\w)[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*-)(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*(?!"\[redacted\]")(?:'[^'\n]{6,}'|"[^"\n]{6,}"|["']?[^\s"',;]{6,})/gi,
  // Only an upper-case config name (DEPLOY_KEY, AWS_CREDENTIALS) counts for a bare KEY or CREDENTIALS: a lower-case one is
  // as often code (cache_key, fetch's credentials: 'include').
  /\b[A-Z][A-Z0-9_]*_(?:KEY|CREDENTIALS?)\b["']?\s*[:=]\s*(?!"\[redacted\]")(?:'[^'\n]{6,}'|"[^"\n]{6,}"|["']?[^\s"',;]{6,})/g,
  // A user:password argument (curl -u), quoted or not, but not a numeric uid:gid (docker -u 1000:1000).
  // Checked before the lookbehind so it walks back over each whitespace run once, not from every position inside it.
  /(?=\S)(?<=(?:^|\s)(?:-u|--user)(?:\s+|=)?)(?!["']?\d+:\d+["']?(?:\s|$))(?:'[^':]+:[^']+'|"[^":]+:[^"]+"|[^\s:'"=]+:[^\s'"]{4,})/g,
  /(?=\S)(?<=(?:^|\s)--(?:password|passwd|token|api[-_]?key|secret|auth[-_]token|access[-_]token|client[-_]secret)(?:\s+|=))(?:'[^']+'|"[^"]+"|[^\s'"-][^\s'"]{3,})/gi,
  // An Authorization header's credential, whatever its length, and every parameter of a Digest one; a template such as
  // `Bearer ${token}` holds none.
  /\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:proxy-)?authorization\s*:\s*digest\s+(?:[\w-]+=(?:"[^"\n]*"|[^\s,'"]+)\s*,?\s*)+/gi,
];

const SECRET_FILE = /(?:^|\/)(?:\.docker\/config\.json|\.kube\/config|\.env(?:rc|\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|[^/]*(?:credential|secret)[^/]*)$/i;

export const REDACTED = '[redacted]';
const REDACTED_JSON = `"${REDACTED}"`;

function jsonValueEnd(text, start) {
  const opening = text[start];
  if (!['"', '{', '['].includes(opening)) return start;
  const closing = opening === '"' ? [] : [opening === '{' ? '}' : ']'];
  let quoted = opening === '"';
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '\r' || char === '\n') return text.length;
      if (char === '\\') {
        if (text[at + 1] === '\r' || text[at + 1] === '\n') return text.length;
        at++;
      } else if (char === '"') {
        quoted = false;
        if (closing.length === 0) return at + 1;
      }
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') closing.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') {
      if (char !== closing.pop()) return text.length;
      if (closing.length === 0) return at + 1;
    }
  }
  // A truncated credential value must not leave its remaining bytes in a prompt or snapshot.
  return text.length;
}

function redactJsonValues(text, keys) {
  const parts = [];
  let from = 0;
  keys.lastIndex = 0;
  while (keys.exec(text)) {
    let start = keys.lastIndex;
    // Unified diffs put a line marker before a value split from its key.
    while (['+', '-'].includes(text[start]) && text[start - 1] === '\n') {
      start++;
      while (start < text.length && /\s/.test(text[start])) start++;
    }
    const end = jsonValueEnd(text, start);
    if (end === start) continue;
    const value = text.slice(start, end);
    if (value === '""' || value === REDACTED_JSON) continue;
    parts.push(text.slice(from, start), REDACTED_JSON);
    from = keys.lastIndex = end;
  }
  return parts.length ? parts.join('') + text.slice(from) : text;
}

export function withoutSecrets(text) {
  if (typeof text !== 'string') return '';
  const redactedJson = JSON_SECRET_KEYS.reduce(redactJsonValues, text);
  return SECRET_PATTERNS.reduce((cleaned, pattern) => cleaned.replace(pattern, REDACTED), redactedJson);
}

export function containsSecret(text) {
  return typeof text === 'string' && withoutSecrets(text) !== text;
}

/** Whether `file` is where keys are kept (an env file, a private key, a keystore), whatever it holds now. */
export const isSecretFile = (file) => typeof file === 'string' && SECRET_FILE.test(file);
