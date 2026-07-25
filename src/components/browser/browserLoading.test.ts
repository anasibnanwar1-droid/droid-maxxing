import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldResetBrowserLoading } from './browserLoading';

test('initial session allocation preserves an in-flight browser load', () => {
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'mission-a', sessionId: undefined },
      { browserKey: 'mission-a', sessionId: 'browser-a' },
    ),
    false,
  );
});

test('mission and established session changes reset browser loading', () => {
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'mission-a', sessionId: 'browser-a' },
      { browserKey: 'mission-b', sessionId: 'browser-b' },
    ),
    true,
  );
  assert.equal(
    shouldResetBrowserLoading(
      { browserKey: 'mission-a', sessionId: 'browser-a' },
      { browserKey: 'mission-a', sessionId: 'browser-b' },
    ),
    true,
  );
});
