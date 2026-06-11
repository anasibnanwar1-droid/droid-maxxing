import test from 'node:test';
import assert from 'node:assert';
import { extractFileChange } from './diff';

test('apply_patch recovers the path from a "*** Update File" header', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/components/App.tsx',
    '@@',
    '-const a = 1;',
    '+const a = 2;',
    '*** End Patch',
  ].join('\n');
  const change = extractFileChange('apply_patch', { input: patch });
  assert.ok(change);
  assert.equal(change?.path, 'src/components/App.tsx');
  assert.equal(change?.verb, 'patch');
});

test('apply_patch recovers the path from a unified-diff +++ header', () => {
  const patch = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@', '-old', '+new'].join('\n');
  const change = extractFileChange('apply_patch', { patch });
  assert.equal(change?.path, 'src/x.ts');
});

test('recovers the path from the --- header for a delete-only diff (+++ /dev/null)', () => {
  const patch = ['--- a/src/gone.ts', '+++ /dev/null', '@@', '-old line 1', '-old line 2'].join('\n');
  const change = extractFileChange('apply_patch', { patch });
  assert.equal(change?.path, 'src/gone.ts');
});

test('an explicit path arg still wins over the patch body', () => {
  const patch = ['*** Update File: ignored.ts', '-old', '+new'].join('\n');
  const change = extractFileChange('apply_patch', { file_path: 'real.ts', patch });
  assert.equal(change?.path, 'real.ts');
});

test('falls back to "file" when no path is present anywhere', () => {
  const change = extractFileChange('apply_patch', { patch: '-old\n+new' });
  assert.equal(change?.path, 'file');
});
