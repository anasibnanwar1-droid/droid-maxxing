const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactBrowserDiagnosticText,
  redactBrowserDiagnosticUrl,
} = require('./browserDiagnostics.cjs');

test('browser console diagnostics redact structured credentials', () => {
  assert.equal(
    redactBrowserDiagnosticText(
      '{"password":"hunter2 with spaces","access_token":"secret-token","safe":"visible"}',
    ),
    '{"password":"[redacted]","access_token":"[redacted]","safe":"visible"}',
  );
  assert.equal(
    redactBrowserDiagnosticText("credential='private value'; authorization=Bearer-value"),
    "credential='[redacted]'; authorization=[redacted]",
  );
  assert.equal(
    redactBrowserDiagnosticText('Authorization: Bearer abc.def-123'),
    'Authorization: [redacted] [redacted]',
  );
  assert.equal(
    redactBrowserDiagnosticText('Cookie: session_id="private value"; Bearer "quoted secret"'),
    'Cookie: [redacted]; Bearer [redacted]',
  );
});

test('browser network diagnostics remove URL credentials and sensitive parameters', () => {
  assert.equal(
    redactBrowserDiagnosticUrl(
      'https://user:pass@example.com/video?access_token=secret&part=snippet#private',
    ),
    'https://example.com/video?access_token=%5Bredacted%5D&part=snippet',
  );
});
