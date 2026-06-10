import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { designPromptDisplayFromText } from './designPromptDisplay.js';
import { browserDesignReferenceDir } from './browserPaths.js';

test('designPromptDisplayFromText extracts instruction and browser chips from a pack', () => {
  const dir = join(tmpdir(), `droid-display-${Date.now()}`);
  const packDir = browserDesignReferenceDir('m1', dir);
  mkdirSync(packDir, { recursive: true });
  const packPath = join(packDir, 'pack.json');
  writeFileSync(packPath, JSON.stringify({
    missionId: 'm1',
    browserSessionId: 'b1',
    createdAt: new Date().toISOString(),
    instruction: 'What font is this?',
    references: [{
      id: '@live-heading',
      anchor: {
        id: '@live-heading',
        kind: 'element',
        label: 'Hero heading',
        tag: 'h1',
        name: 'Hero heading',
        box: { x: 10, y: 20, width: 200, height: 48 },
      },
      detail: {
        id: '@live-heading',
        selector: 'h1',
        selectorVerified: true,
        attributes: {},
        styles: {},
        ancestors: [],
      },
      url: 'https://example.com',
      viewport: { width: 1000, height: 800, deviceScaleFactor: 2 },
      scroll: { x: 0, y: 0 },
      createdAt: new Date().toISOString(),
    }],
  }), 'utf8');

  assert.deepEqual(designPromptDisplayFromText([
    'Design Mode reference pack:',
    '- URL: https://example.com',
    '- Screenshot: none',
    `- References JSON: ${packPath}`,
    '',
    'User instruction:',
    'What font is this?',
  ].join('\n'), { browserDataDir: dir }), {
    text: 'What font is this?',
    browserRefs: [{
      id: '@live-heading',
      kind: 'element',
      label: 'Hero-heading',
      url: 'https://example.com',
      selector: 'h1',
      imageDataUrl: undefined,
    }],
  });
});

test('designPromptDisplayFromText ignores reference packs outside browser data', () => {
  const dir = join(tmpdir(), `droid-display-${Date.now()}-guarded`);
  mkdirSync(dir, { recursive: true });
  const outsidePath = join(tmpdir(), `droid-display-outside-${Date.now()}.json`);
  writeFileSync(outsidePath, JSON.stringify({
    references: [{
      id: '@outside',
      kind: 'element',
      element: { ref: '@outside', tagName: 'button', attributes: {}, computedStyles: {} },
    }],
  }), 'utf8');

  assert.deepEqual(designPromptDisplayFromText([
    'Design Mode reference pack:',
    '- URL: https://example.com',
    '- Screenshot: none',
    `- References JSON: ${outsidePath}`,
    '',
    'User instruction:',
    'What font is this?',
  ].join('\n'), { browserDataDir: dir }), {
    text: 'What font is this?',
    browserRefs: undefined,
  });
});

test('designPromptDisplayFromText leaves non-design prompts alone', () => {
  assert.equal(designPromptDisplayFromText('hello'), null);
});
