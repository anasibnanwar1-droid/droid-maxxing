import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./NativeBrowserSurface.tsx', import.meta.url), 'utf8');

test('iframe lifecycle uses callback refs instead of callback dependencies', () => {
  assert.match(source, /onSelection: \(selection\) => onSelectionRef\.current\(selection\)/);
  assert.match(source, /onLoadedRef\.current\(\{/);
  assert.match(
    source,
    /}, \[browserKey, designMode, native, pencilMode, url, visibleSessionId\]\);/,
  );
});
