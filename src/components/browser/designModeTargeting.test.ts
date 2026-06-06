import assert from 'node:assert/strict';
import test from 'node:test';
import { pickDesignModeTarget } from './designModeTargeting';
import type { BrowserElementRef } from '../../types/bridge';

const viewport = { width: 1200, height: 800 };

test('pickDesignModeTarget prefers precise text over a broad container', () => {
  const picked = pickDesignModeTarget([
    ref('@e1', 'div', { x: 0, y: 0, width: 900, height: 500 }, { name: 'CardBody' }),
    ref('@e2', 'p', { x: 32, y: 42, width: 360, height: 30 }, { text: 'Working on it with Claude Sonnet.' }),
  ], { x: 120, y: 52 }, viewport);

  assert.equal(picked?.ref, '@e2');
});

test('pickDesignModeTarget prefers controls over nearby text', () => {
  const picked = pickDesignModeTarget([
    ref('@e1', 'span', { x: 80, y: 80, width: 180, height: 36 }, { text: 'View product' }),
    ref('@e2', 'a', { x: 76, y: 76, width: 194, height: 46 }, { role: 'link', name: 'View product' }),
  ], { x: 92, y: 88 }, viewport);

  assert.equal(picked?.ref, '@e2');
});

test('pickDesignModeTarget avoids giant layout regions when a smaller match exists', () => {
  const picked = pickDesignModeTarget([
    ref('@e1', 'section', { x: 0, y: 0, width: 1100, height: 720 }, { name: 'Page' }),
    ref('@e2', 'div', { x: 380, y: 280, width: 210, height: 80 }, { name: 'Composer' }),
  ], { x: 420, y: 310 }, viewport);

  assert.equal(picked?.ref, '@e2');
});

function ref(
  id: string,
  tagName: string,
  box: BrowserElementRef['box'],
  patch: Partial<BrowserElementRef> = {},
): BrowserElementRef {
  return {
    ref: id,
    selector: id,
    tagName,
    attributes: {},
    box,
    computedStyles: {},
    ...patch,
  };
}
