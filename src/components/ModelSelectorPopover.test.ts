import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StoreProvider } from '../hooks/useStore.js';
import type { ExactChildSettingsTarget } from '../lib/exactChildSettings.js';
import ModelSelectorPopover from './ModelSelectorPopover.js';

function renderTarget(readiness: ExactChildSettingsTarget['readiness']): string {
  const target: ExactChildSettingsTarget = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    role: 'validator',
    label: 'Sub-agent 2',
    modelId: 'validator-model',
    reasoningEffort: 'high',
    readiness,
  };
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(ModelSelectorPopover, {
        childTarget: target,
        onClose: () => undefined,
      }),
    ),
  );
}

test('exact child editor labels readiness and keeps standalone reasoning disabled', () => {
  const opening = renderTarget('opening');
  assert.match(opening, /Sub-agent 2/);
  assert.match(opening, /Opening child…/);
  assert.match(opening, /Change the child model to adjust reasoning/);

  const ready = renderTarget('ready');
  assert.match(ready, /Sub-agent 2/);
  assert.match(ready, /Validator model/);
  assert.match(ready, /Change the child model to adjust reasoning/);
  assert.equal(
    (opening.match(/disabled=""/g) ?? []).length,
    (ready.match(/disabled=""/g) ?? []).length + 1,
  );

  const unavailable = renderTarget('failed');
  assert.match(unavailable, /Child unavailable/);
  assert.equal(
    (unavailable.match(/disabled=""/g) ?? []).length,
    (opening.match(/disabled=""/g) ?? []).length,
  );
});
