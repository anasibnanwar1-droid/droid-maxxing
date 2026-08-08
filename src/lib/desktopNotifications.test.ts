import test from 'node:test';
import assert from 'node:assert/strict';
import { notify, requestNotificationPermission } from './desktop';

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test('notify returns the desktop bridge delivery result', async () => {
  const expected = { shown: false, reason: 'timeout' };
  const restore = replaceGlobal('window', {
    droidControl: { notify: async () => expected },
  });
  try {
    assert.deepEqual(await notify('DROIDEX', 'Finished'), expected);
  } finally {
    restore();
  }
});

test('requestNotificationPermission returns denied from the browser permission prompt', async () => {
  const restore = replaceGlobal('Notification', {
    permission: 'default',
    requestPermission: async () => 'denied',
  });
  try {
    assert.equal(await requestNotificationPermission(), 'denied');
  } finally {
    restore();
  }
});

test('requestNotificationPermission reports unsupported when the API is absent', async () => {
  const restore = replaceGlobal('Notification', undefined);
  try {
    assert.equal(await requestNotificationPermission(), 'unsupported');
  } finally {
    restore();
  }
});
