/**
 * Data minimization for model-bound text and screenshots.
 *
 * These patterns are intentionally conservative: false positives are
 * preferable to sending credentials or internal addresses to a model.
 */
const RULES = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9._-]{20,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'assigned-secret', re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*['"]?[^\s'"<>{},;]{8,}/gi },
  { name: 'internal-ipv4', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: 'vplay-env-key', re: /\b(?:VPLAY|DASHSCOPE|DEEPSEEK|OPENAI|QWEN)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\b/g },
];

export function scanSensitive(text) {
  if (typeof text !== 'string') return [];
  const findings = [];
  for (const rule of RULES) {
    const matches = text.match(rule.re);
    if (matches) findings.push({ type: rule.name, count: matches.length });
  }
  return findings;
}

export function redactText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, `[REDACTED:${rule.name}]`);
  return out;
}

/**
 * Redact and cap a source excerpt before it is sent to the text model.
 * Returns metadata so the host can log what was removed without logging values.
 */
export function redactSource(source, { maxChars = 16000 } = {}) {
  if (typeof source !== 'string') return { text: '', findings: [], truncated: false };
  const findings = scanSensitive(source);
  let text = redactText(source);
  const truncated = text.length > maxChars;
  if (truncated) text = `${text.slice(0, maxChars)}\n[SOURCE_TRUNCATED]`;
  return { text, findings, truncated };
}

export function redactObject(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(api[_-]?key|authorization|token|secret|password|credential|headers)$/i.test(key)) out[key] = '[REDACTED]';
      else out[key] = redactObject(item);
    }
    return out;
  }
  return value;
}
