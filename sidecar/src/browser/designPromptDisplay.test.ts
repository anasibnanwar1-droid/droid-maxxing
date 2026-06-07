import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { designPromptDisplayFromText } from './designPromptDisplay.js';

test('designPromptDisplayFromText extracts instruction and browser chips from a pack', () => {
  const dir = join(tmpdir(), `droid-display-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const packPath = join(dir, 'pack.json');
  writeFileSync(packPath, JSON.stringify({
    missionId: 'm1',
    browserSessionId: 'b1',
    createdAt: new Date().toISOString(),
    instruction: 'What font is this?',
    references: [{
      id: '@live-heading',
      kind: 'element',
      url: 'https://example.com',
      viewport: { width: 1000, height: 800, deviceScaleFactor: 2 },
      scroll: { x: 0, y: 0 },
      element: {
        ref: '@live-heading',
        selector: 'h1',
        tagName: 'h1',
        name: 'Hero heading',
        attributes: {},
        box: { x: 10, y: 20, width: 200, height: 48 },
        computedStyles: {},
      },
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
  ].join('\n')), {
    text: 'What font is this?',
    browserRefs: [{
      id: '@live-heading',
      kind: 'element',
      label: 'Hero-heading',
      url: 'https://example.com',
      selector: 'h1',
    }],
  });
});

test('designPromptDisplayFromText leaves non-design prompts alone', () => {
  assert.equal(designPromptDisplayFromText('hello'), null);
});
