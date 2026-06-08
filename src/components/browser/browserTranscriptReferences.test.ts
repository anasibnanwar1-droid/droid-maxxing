import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserTranscriptReferenceFromDesignReference,
  normalizeBrowserReferenceLabel,
} from './browserTranscriptReferences';
import type { DesignReference } from '../../types/bridge';

test('normalizeBrowserReferenceLabel creates compact mention labels', () => {
  assert.equal(normalizeBrowserReferenceLabel('Hero title', 'element'), 'Hero-title');
  assert.equal(normalizeBrowserReferenceLabel('@live-abcd', 'element'), 'live-abcd');
  assert.equal(normalizeBrowserReferenceLabel('  Buy now!  ', 'button'), 'Buy-now');
});

test('browserTranscriptReferenceFromDesignReference prefers element names for labels', () => {
  const reference: DesignReference = {
    id: '@live-hero',
    kind: 'element',
    note: 'https://example.com',
    element: {
      ref: '@live-hero',
      selector: '#hero',
      tagName: 'h1',
      name: 'Main heading',
      attributes: {},
      box: { x: 0, y: 0, width: 100, height: 24 },
      computedStyles: {},
    },
  };

  assert.deepEqual(browserTranscriptReferenceFromDesignReference(reference), {
    id: '@live-hero',
    kind: 'element',
    label: 'Main-heading',
    url: 'https://example.com',
    selector: '#hero',
  });
});

test('browserTranscriptReferenceFromDesignReference labels sketched regions', () => {
  assert.deepEqual(browserTranscriptReferenceFromDesignReference({
    id: '@region-1',
    kind: 'region',
    note: 'https://example.com',
    box: { x: 10, y: 20, width: 30, height: 40 },
  }), {
    id: '@region-1',
    kind: 'region',
    label: 'region',
    url: 'https://example.com',
    selector: undefined,
  });
});
