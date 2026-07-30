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
  writeFileSync(
    packPath,
    JSON.stringify({
      appSessionId: 'm1',
      browserSessionId: 'b1',
      createdAt: new Date().toISOString(),
      instruction: 'What font is this?',
      references: [
        {
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
        },
      ],
    }),
    'utf8',
  );

  assert.deepEqual(
    designPromptDisplayFromText(
      [
        'Design Mode reference pack:',
        '- URL: https://example.com',
        '- Screenshot: none',
        `- References JSON: ${packPath}`,
        '',
        'User instruction:',
        'What font is this?',
      ].join('\n'),
      { browserDataDir: dir },
    ),
    {
      text: 'What font is this?',
      browserRefs: [
        {
          id: '@live-heading',
          kind: 'element',
          label: 'Hero-heading',
          url: 'https://example.com',
          selector: 'h1',
          imageDataUrl: undefined,
        },
      ],
    },
  );
});

test('designPromptDisplayFromText ignores reference packs outside browser data', () => {
  const dir = join(tmpdir(), `droid-display-${Date.now()}-guarded`);
  mkdirSync(dir, { recursive: true });
  const outsidePath = join(tmpdir(), `droid-display-outside-${Date.now()}.json`);
  writeFileSync(
    outsidePath,
    JSON.stringify({
      references: [
        {
          id: '@outside',
          kind: 'element',
          element: { ref: '@outside', tagName: 'button', attributes: {}, computedStyles: {} },
        },
      ],
    }),
    'utf8',
  );

  assert.deepEqual(
    designPromptDisplayFromText(
      [
        'Design Mode reference pack:',
        '- URL: https://example.com',
        '- Screenshot: none',
        `- References JSON: ${outsidePath}`,
        '',
        'User instruction:',
        'What font is this?',
      ].join('\n'),
      { browserDataDir: dir },
    ),
    {
      text: 'What font is this?',
      browserRefs: undefined,
    },
  );
});

test('designPromptDisplayFromText leaves non-design prompts alone', () => {
  assert.equal(designPromptDisplayFromText('hello'), null);
});

test('designPromptDisplayFromText hides the internal Design DNA pointer', () => {
  assert.deepEqual(
    designPromptDisplayFromText(
      [
        "Help me design an AI chat interface for my doctor's clinic.",
        '',
        'Project design DNA:',
        '- This project has a Design DNA at /project/DESIGN.md. Pull exact token values on demand with the design_system tool; do not paste the whole file into context.',
        '- Motion rules live in /project/MOTION.md; consult them for timing and easing.',
      ].join('\n'),
    ),
    { text: "Help me design an AI chat interface for my doctor's clinic." },
  );
});

test('designPromptDisplayFromText preserves user-authored Design DNA prose', () => {
  assert.equal(
    designPromptDisplayFromText('Review this section:\n\nProject design DNA:\nUse warm neutrals.'),
    null,
  );
});

test('designPromptDisplayFromText hides Studio canvas reference metadata', () => {
  assert.deepEqual(
    designPromptDisplayFromText(
      [
        'Apply these references to the dashboard.',
        '',
        'DROIDEX DESIGN reference pack:',
        '{"images":[{"libraryId":"canvas-example","name":"Clinic inspiration"}]}',
        '',
        'Project design DNA:',
        '- Pull exact token values on demand with the design_system tool.',
      ].join('\n'),
    ),
    {
      text: 'Apply these references to the dashboard.',
      browserRefs: [
        {
          id: 'canvas-example',
          label: 'Clinic inspiration',
          kind: 'region',
          url: 'droidex://canvas/canvas-example',
        },
      ],
    },
  );
});
