import assert from 'node:assert/strict';
import test from 'node:test';
import { __resetToasts, dismissToast, pushToast, subscribeToasts } from './toast';

test('pushToast adds a toast and notifies subscribers', () => {
  __resetToasts();
  let latest: { id: number; message: string; variant: string }[] = [];
  const unsub = subscribeToasts((t) => {
    latest = t;
  });

  const id = pushToast('Opened VS Code', 'success', 0);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, id);
  assert.equal(latest[0].message, 'Opened VS Code');
  assert.equal(latest[0].variant, 'success');
  unsub();
});

test('dismissToast removes only the matching toast', () => {
  __resetToasts();
  let latest: { id: number }[] = [];
  const unsub = subscribeToasts((t) => {
    latest = t;
  });

  const first = pushToast('one', 'info', 0);
  const second = pushToast('two', 'error', 0);
  assert.equal(latest.length, 2);

  dismissToast(first);
  assert.deepEqual(
    latest.map((t) => t.id),
    [second],
  );
  unsub();
});

test('subscribeToasts unsubscribes cleanly', () => {
  __resetToasts();
  let calls = 0;
  const unsub = subscribeToasts(() => {
    calls += 1;
  });
  assert.equal(calls, 1); // immediate snapshot
  unsub();
  pushToast('ignored', 'info', 0);
  assert.equal(calls, 1);
});
