import assert from 'node:assert/strict';
import test from 'node:test';
import { browserDesignReferenceDir, isBrowserAssetPath } from './browserPaths.js';

test('browser paths sanitize app session ids', () => {
  assert.equal(
    browserDesignReferenceDir('app-session:one', '/tmp/droid'),
    '/tmp/droid/design-references/app-session-one',
  );
});

test('isBrowserAssetPath allows only files below browser data root', () => {
  assert.equal(isBrowserAssetPath('/tmp/droid/design-references/a/pack.json', '/tmp/droid'), true);
  assert.equal(isBrowserAssetPath('/tmp/droid-evil/shot.png', '/tmp/droid'), false);
  assert.equal(isBrowserAssetPath('/etc/passwd', '/tmp/droid'), false);
});
