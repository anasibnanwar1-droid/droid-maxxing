import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserDesignReferenceDir,
  browserProfileDir,
  browserScreenshotDir,
  isBrowserAssetPath,
  resolveChromePath,
} from './browserPaths.js';

test('browser paths sanitize session and mission ids', () => {
  assert.equal(browserProfileDir('mission/one', '/tmp/droid'), '/tmp/droid/browser-profiles/mission-one');
  assert.equal(browserScreenshotDir('mission one', '/tmp/droid'), '/tmp/droid/browser-screenshots/mission-one');
  assert.equal(browserDesignReferenceDir('mission:one', '/tmp/droid'), '/tmp/droid/design-references/mission-one');
});

test('isBrowserAssetPath allows only files below browser data root', () => {
  assert.equal(isBrowserAssetPath('/tmp/droid/browser-screenshots/a/shot.png', '/tmp/droid'), true);
  assert.equal(isBrowserAssetPath('/tmp/droid-evil/shot.png', '/tmp/droid'), false);
  assert.equal(isBrowserAssetPath('/etc/passwd', '/tmp/droid'), false);
});

test('resolveChromePath fails with an explicit recovery message', () => {
  assert.throws(
    () => resolveChromePath('/tmp/definitely-missing-chrome'),
    /Google Chrome was not found/,
  );
});
