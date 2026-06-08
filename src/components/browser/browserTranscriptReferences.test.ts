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
    anchor: {
      id: '@live-hero',
      kind: 'element',
      label: 'Main heading',
      tag: 'h1',
      name: 'Main heading',
      box: { x: 0, y: 0, width: 100, height: 24 },
    },
    detail: {
      id: '@live-hero',
      selector: '#hero',
      selectorVerified: true,
      attributes: {},
      styles: {},
      ancestors: [],
    },
    url: 'https://example.com',
    viewport: { width: 1000, height: 800, deviceScaleFactor: 2 },
    scroll: { x: 0, y: 0 },
    createdAt: '2026-06-06T12:00:00.000Z',
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
    anchor: {
      id: '@region-1',
      kind: 'region',
      label: 'region',
      box: { x: 10, y: 20, width: 30, height: 40 },
    },
    url: 'https://example.com',
    viewport: { width: 1000, height: 800, deviceScaleFactor: 2 },
    scroll: { x: 0, y: 0 },
    createdAt: '2026-06-06T12:00:00.000Z',
  }), {
    id: '@region-1',
    kind: 'region',
    label: 'region',
    url: 'https://example.com',
    selector: undefined,
  });
});
