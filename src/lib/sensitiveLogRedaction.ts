const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(api[-_]?key|authorization|auth[-_]?token|bridge[-_]?token|cookie|password|secret|token)($|[_-])/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENV_SECRET_ASSIGNMENT_PATTERN =
  /\b(FACTORY_API_KEY|BRIDGE_TOKEN|AUTH_TOKEN|API_KEY|PASSWORD|SECRET)=([^\s"'`]+)/gi;

export type SanitizedLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizedLogValue[]
  | { [key: string]: SanitizedLogValue | undefined };

function shouldRedactKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactString(value: string) {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTED}`);
}

export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): SanitizedLogValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => sanitizeForLog(entry, seen));
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  const sanitized: { [key: string]: SanitizedLogValue | undefined } = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = shouldRedactKey(key) ? REDACTED : sanitizeForLog(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}
