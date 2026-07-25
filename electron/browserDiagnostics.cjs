const SENSITIVE_KEY_PARTS = [
  'token',
  'key',
  'secret',
  'password',
  'passcode',
  'auth',
  'authorization',
  'signature',
  'credential',
  'code',
  'cookie',
  'session',
  'csrf',
  'otp',
];

function isSensitiveBrowserKey(value) {
  const key = String(value || '').toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => key.includes(part));
}

function redactBrowserDiagnosticUrl(value, baseUrl) {
  try {
    const url = baseUrl ? new URL(String(value), baseUrl) : new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveBrowserKey(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '').slice(0, 1000);
  }
}

function redactBrowserDiagnosticText(value) {
  const bounded = String(value || '').slice(0, 4000);
  return redactUnquotedAssignments(
    redactQuotedAssignments(redactAuthenticationSchemes(bounded)),
  ).slice(0, 1000);
}

function redactAuthenticationSchemes(value) {
  const chunks = [];
  let index = 0;
  let copyStart = 0;
  while (index < value.length) {
    const match = authenticationSchemeAt(value, index);
    if (!match) {
      index += 1;
      continue;
    }
    chunks.push(value.slice(copyStart, match.tokenStart), '[redacted]');
    index = match.tokenEnd;
    copyStart = index;
  }
  chunks.push(value.slice(copyStart));
  return chunks.join('');
}

function authenticationSchemeAt(value, index) {
  if (index > 0 && isKeyChar(value[index - 1])) return null;
  const bearer = value.slice(index, index + 6).toLowerCase() === 'bearer';
  const basic = value.slice(index, index + 5).toLowerCase() === 'basic';
  const length = bearer ? 6 : basic ? 5 : 0;
  if (!length || !isWhitespace(value[index + length])) return null;
  let cursor = index + length;
  while (isWhitespace(value[cursor])) cursor += 1;
  const tokenStart = cursor;
  const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : '';
  if (quote) {
    cursor += 1;
    while (cursor < value.length) {
      if (value[cursor] === '\\') {
        cursor = Math.min(value.length, cursor + 2);
      } else if (value[cursor] === quote) {
        return { tokenStart, tokenEnd: cursor + 1 };
      } else {
        cursor += 1;
      }
    }
    return { tokenStart, tokenEnd: value.length };
  }
  while (isAuthenticationTokenChar(value[cursor])) cursor += 1;
  return cursor > tokenStart ? { tokenStart, tokenEnd: cursor } : null;
}

function redactQuotedAssignments(value) {
  return redactAssignments(value, true);
}

function redactUnquotedAssignments(value) {
  return redactAssignments(value, false);
}

function redactAssignments(value, quoted) {
  const chunks = [];
  let index = 0;
  let copyStart = 0;
  while (index < value.length) {
    if (!isAssignmentKeyStart(value, index)) {
      index += 1;
      continue;
    }
    const match = assignmentAt(value, index, quoted);
    if (!match) {
      index = assignmentKeyEnd(value, index);
      continue;
    }
    chunks.push(value.slice(copyStart, match.valueStart), '[redacted]', match.closingQuote);
    index = match.end;
    copyStart = index;
  }
  chunks.push(value.slice(copyStart));
  return chunks.join('');
}

function isAssignmentKeyStart(value, index) {
  if (value[index] === '"' || value[index] === "'") return isKeyChar(value[index + 1]);
  return isKeyChar(value[index]) && (index === 0 || !isKeyChar(value[index - 1]));
}

function assignmentKeyEnd(value, index) {
  let cursor = value[index] === '"' || value[index] === "'" ? index + 1 : index;
  while (isKeyChar(value[cursor])) cursor += 1;
  return Math.max(index + 1, cursor);
}

function assignmentAt(value, index, quotedValue) {
  let cursor = index;
  const keyQuote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : '';
  if (keyQuote) cursor += 1;
  const keyStart = cursor;
  while (isKeyChar(value[cursor])) cursor += 1;
  if (cursor === keyStart) return null;
  const key = value.slice(keyStart, cursor);
  if (!isSensitiveBrowserKey(key)) return null;
  if (keyQuote) {
    if (value[cursor] !== keyQuote) return null;
    cursor += 1;
  }
  while (isWhitespace(value[cursor])) cursor += 1;
  if (value[cursor] !== ':' && value[cursor] !== '=') return null;
  cursor += 1;
  while (isWhitespace(value[cursor])) cursor += 1;

  const valueStart = cursor;
  const valueQuote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : '';
  if (quotedValue !== Boolean(valueQuote)) return null;
  if (valueQuote) {
    cursor += 1;
    const contentStart = cursor;
    while (cursor < value.length) {
      if (value[cursor] === '\\') {
        cursor = Math.min(value.length, cursor + 2);
      } else if (value[cursor] === valueQuote) {
        return {
          valueStart: contentStart,
          closingQuote: valueQuote,
          end: cursor + 1,
        };
      } else {
        cursor += 1;
      }
    }
    return { valueStart: contentStart, closingQuote: '', end: value.length };
  }

  while (cursor < value.length && !isAssignmentDelimiter(value[cursor])) cursor += 1;
  if (cursor === valueStart) return null;
  return { valueStart, closingQuote: '', end: cursor };
}

function isKeyChar(value) {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === '_' ||
    value === '-'
  );
}

function isWhitespace(value) {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r' || value === '\f';
}

function isAssignmentDelimiter(value) {
  return isWhitespace(value) || value === ',' || value === ';' || value === '}';
}

function isAuthenticationTokenChar(value) {
  if (!value) return false;
  return (
    isKeyChar(value) ||
    value === '.' ||
    value === '~' ||
    value === '+' ||
    value === '/' ||
    value === '='
  );
}

function normalizeBrowserConsoleMessage(details) {
  const level = { debug: 0, info: 1, warning: 2, error: 3 }[details?.level] ?? 0;
  return {
    level,
    message: redactBrowserDiagnosticText(details?.message),
    line: Number.isFinite(details?.lineNumber) ? details.lineNumber : undefined,
    source: details?.sourceId ? redactBrowserDiagnosticUrl(details.sourceId) : undefined,
  };
}

module.exports = {
  isSensitiveBrowserKey,
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticText,
  redactBrowserDiagnosticUrl,
};
