import assert from 'node:assert/strict';
import test from 'node:test';
import { bugDescriptionFromCommand } from './bugReport';

test('bugDescriptionFromCommand recognizes only the app command', () => {
  assert.equal(bugDescriptionFromCommand('/bug update froze'), 'update froze');
  assert.equal(bugDescriptionFromCommand('/bug    update froze   '), 'update froze');
  assert.equal(bugDescriptionFromCommand('/bug'), '');
  assert.equal(bugDescriptionFromCommand('/buggy nope'), null);
});
