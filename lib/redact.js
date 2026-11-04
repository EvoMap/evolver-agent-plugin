// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
  /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)\b["']?\s*[:=]\s*(?:'[^'\n]{6,}'|"[^"\n]{6,}"|["']?[^\s"',;]{6,})/gi,
  // Only an upper-case config name (DEPLOY_KEY) counts for a bare KEY: a lower-case one is as often code (cache_key).
  /\b[A-Z][A-Z0-9_]*_KEY\b["']?\s*[:=]\s*(?:'[^'\n]{6,}'|"[^"\n]{6,}"|["']?[^\s"',;]{6,})/g,
  // A user:password argument (curl -u), quoted or not, but not a numeric uid:gid (docker -u 1000:1000).
  /(?<=(?:^|\s)(?:-u|--user)(?:\s+|=)?)(?!["']?\d+:\d+["']?(?:\s|$))(?:'[^':]+:[^']+'|"[^":]+:[^"]+"|[^\s:'"=]+:[^\s'"]{4,})/g,
  /(?<=(?:^|\s)--(?:password|passwd|token|api[-_]?key|secret|auth[-_]token|access[-_]token|client[-_]secret)(?:\s+|=))(?:'[^']+'|"[^"]+"|[^\s'"-][^\s'"]{3,})/gi,
  // An Authorization header's credential, whatever its length; a template such as `Bearer ${token}` holds none.
  /\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const SECRET_FILE = /(?:^|\/)(?:\.env(?:rc|\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|[^/]*(?:credential|secret)[^/]*)$/i;

export const REDACTED = '[redacted]';

export function withoutSecrets(text) {
  if (typeof text !== 'string') return '';
  return SECRET_PATTERNS.reduce((cleaned, pattern) => cleaned.replace(pattern, REDACTED), text);
}

export function containsSecret(text) {
  return typeof text === 'string' && withoutSecrets(text) !== text;
}

/** Whether `file` is where keys are kept (an env file, a private key, a keystore), whatever it holds now. */
export const isSecretFile = (file) => typeof file === 'string' && SECRET_FILE.test(file);
