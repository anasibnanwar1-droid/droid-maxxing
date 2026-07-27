import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldResetBrowserLoading } from './browserLoading';

test('initial browser session allocation preserves an in-flight load', () => {
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'session-a', browserSessionId: undefined },
      { browserKey: 'session-a', browserSessionId: 'browser-a' },
    ),
    false,
  );
});

test('app and established browser session changes reset browser loading', () => {
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'session-a', browserSessionId: 'browser-a' },
      { browserKey: 'session-b', browserSessionId: 'browser-b' },
    ),
    true,
  );
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'session-a', browserSessionId: 'browser-a' },
      { browserKey: 'session-a', browserSessionId: 'browser-b' },
    ),
    true,
  );
});
