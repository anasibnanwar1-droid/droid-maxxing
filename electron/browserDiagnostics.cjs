function redactBrowserDiagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|auth|signature|credential|code)/i.test(key)) {
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
  const sensitiveKey =
    '([\\w-]*(?:token|secret|password|passcode|authorization|api[-_]?key|private[-_]?key|credential|cookie|session|csrf|otp)[\\w-]*)';
  return String(value || '')
    .replace(
      /\b(Bearer|Basic)\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[A-Za-z0-9._~+/=-]+)/gi,
      '$1 [redacted]',
    )
    .replace(
      new RegExp(`(["']?)${sensitiveKey}\\1(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\4).)*\\4`, 'gi'),
      '$1$2$1$3$4[redacted]$4',
    )
    .replace(
      new RegExp(`(["']?)${sensitiveKey}\\1(\\s*[:=]\\s*)(?!["'])([^\\s,;}]+)`, 'gi'),
      '$1$2$1$3[redacted]',
    )
    .slice(0, 1000);
}

module.exports = { redactBrowserDiagnosticText, redactBrowserDiagnosticUrl };
