const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installRendererNavigationGuard, isTrustedRendererUrl } = require('./rendererSecurity.cjs');

test('packaged renderer navigation remains on its exact app file', () => {
  const entry = 'file:///Applications/DROIDEX.app/Contents/Resources/app.asar/dist/index.html';
  assert.equal(isTrustedRendererUrl(`${entry}#/settings`, entry), true);
  assert.equal(isTrustedRendererUrl('file:///etc/passwd', entry), false);
  assert.equal(isTrustedRendererUrl('https://attacker.example/', entry), false);
});

test('development renderer navigation remains on the configured origin', () => {
  const entry = 'http://127.0.0.1:1420/';
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:1420/settings', entry), true);
  assert.equal(isTrustedRendererUrl('http://localhost:1420/', entry), false);
});

test('navigation guard blocks foreign navigation and opens web popups externally', () => {
  const contents = new EventEmitter();
  let windowHandler;
  contents.setWindowOpenHandler = (handler) => {
    windowHandler = handler;
  };
  const opened = [];
  installRendererNavigationGuard(contents, 'http://127.0.0.1:1420/', (url) => opened.push(url));
  let prevented = false;
  contents.emit(
    'will-navigate',
    { preventDefault: () => (prevented = true) },
    'https://attacker.example/',
  );

  assert.equal(prevented, true);
  assert.deepEqual(windowHandler({ url: 'https://docs.example/' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://docs.example/']);
  assert.deepEqual(windowHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://docs.example/']);
});
