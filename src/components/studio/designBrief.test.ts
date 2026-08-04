import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authoringInstruction,
  briefImageReferences,
  briefWithSupportedImages,
  isSupportedBriefImage,
  type DesignBrief,
} from './designBrief';

test('design intake images become durable library imports and multimodal transcript references', () => {
  const brief: DesignBrief = {
    references: {
      selected: [],
      text: 'Calm editorial direction',
      images: ['data:image/png;base64,YQ==', 'data:image/webp;base64,Yg=='],
    },
  };
  let sequence = 0;
  const references = briefImageReferences(brief, () => `image-${String(++sequence)}`);

  assert.deepEqual(
    references.map(({ id, name, dataUrl }) => ({ id, name, dataUrl })),
    [
      {
        id: 'canvas-intake-image-1',
        name: 'Intake reference 1',
        dataUrl: 'data:image/png;base64,YQ==',
      },
      {
        id: 'canvas-intake-image-2',
        name: 'Intake reference 2',
        dataUrl: 'data:image/webp;base64,Yg==',
      },
    ],
  );
  assert.deepEqual(references[0]?.transcript, {
    id: 'canvas-intake-image-1',
    label: 'Intake reference 1',
    kind: 'region',
    url: 'droidex://canvas/canvas-intake-image-1',
    imageDataUrl: 'data:image/png;base64,YQ==',
  });
  assert.match(
    authoringInstruction(
      3,
      references.map((reference) => reference.id),
    ),
    /canvas-intake-image-1[\s\S]*design_reference_library/,
  );
});

test('unsupported and oversized intake images never become agent references', () => {
  const valid = 'data:image/png;base64,YQ==';
  const unsupported = 'data:image/svg+xml;base64,YQ==';
  const oversized = 'data:image/png;base64,YWJjZA==';
  assert.equal(isSupportedBriefImage(valid), true);
  assert.equal(isSupportedBriefImage(unsupported), false);
  assert.equal(isSupportedBriefImage(oversized, 3), false);

  const brief: DesignBrief = {
    references: { selected: [], text: '', images: [unsupported, valid, oversized] },
  };
  const sanitized = briefWithSupportedImages(brief, 3);
  assert.deepEqual(sanitized.references?.images, [valid]);
  assert.deepEqual(
    briefImageReferences(brief, () => 'id', 3).map((reference) => reference.dataUrl),
    [valid],
  );
});
