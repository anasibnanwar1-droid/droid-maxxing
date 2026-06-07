import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSnapshot } from './domSnapshot.js';

test('normalizeSnapshot keeps compact valid refs', () => {
  const snapshot = normalizeSnapshot({
    url: 'https://example.com',
    title: 'Example',
    scroll: { x: 2, y: 10 },
    refs: [
      {
        ref: '@e1',
        selector: 'button:nth-of-type(1)',
        tagName: 'button',
        role: 'button',
        name: 'Save',
        text: 'Save',
        attributes: { type: 'button', disabled: false },
        className: 'primary',
        box: { x: 10, y: 20, width: 80, height: 32 },
        computedStyles: { color: 'rgb(255, 255, 255)', fontSize: '14px' },
      },
      { ref: '@bad' },
    ],
  });

  assert.equal(snapshot.url, 'https://example.com');
  assert.equal(snapshot.title, 'Example');
  assert.deepEqual(snapshot.scroll, { x: 2, y: 10 });
  assert.equal(snapshot.refs.length, 1);
  assert.deepEqual(snapshot.refs[0].attributes, { type: 'button' });
});
