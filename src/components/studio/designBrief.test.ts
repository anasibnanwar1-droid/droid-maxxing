import assert from 'node:assert/strict';
import test from 'node:test';
import { authoringInstruction, briefImageReferences, type DesignBrief } from './designBrief';

test('design intake images become durable library imports and multimodal transcript references', () => {
  const brief: DesignBrief = {
    references: {
      selected: [],
      text: 'Calm editorial direction',
      images: ['data:image/png;base64,one', 'data:image/webp;base64,two'],
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
        dataUrl: 'data:image/png;base64,one',
      },
      {
        id: 'canvas-intake-image-2',
        name: 'Intake reference 2',
        dataUrl: 'data:image/webp;base64,two',
      },
    ],
  );
  assert.deepEqual(references[0]?.transcript, {
    id: 'canvas-intake-image-1',
    label: 'Intake reference 1',
    kind: 'region',
    url: 'droidex://canvas/canvas-intake-image-1',
    imageDataUrl: 'data:image/png;base64,one',
  });
  assert.match(
    authoringInstruction(
      3,
      references.map((reference) => reference.id),
    ),
    /canvas-intake-image-1[\s\S]*design_reference_library/,
  );
});
