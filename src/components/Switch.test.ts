import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Switch } from './Switch';

function renderSwitch(disabled: boolean): string {
  return renderToStaticMarkup(
    createElement(Switch, {
      label: 'Automatic updates',
      checked: true,
      disabled,
      onChange: () => {},
    }),
  );
}

test('disabled switches cannot change while preferences are saving', () => {
  assert.match(renderSwitch(true), /disabled=""/);
  assert.doesNotMatch(renderSwitch(false), /disabled=""/);
});
