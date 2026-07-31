import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_TAG_CHIP,
  NOTE_TAG_HINT,
  NOTE_TAGS,
  composeNoteText,
  exactNoteTag,
  matchingNoteTags,
  noteTagMenu,
  noteTextWithoutTag,
  parseNoteTag,
} from './notesTags';

test('parses a leading known @tag case-insensitively', () => {
  assert.equal(parseNoteTag('@bug Login crashes on save'), 'bug');
  assert.equal(parseNoteTag('@NEXT ship the panel'), 'next');
});

test('ignores unknown @words, non-leading tags, and a bare token', () => {
  assert.equal(parseNoteTag('@john review this'), null);
  assert.equal(parseNoteTag('ping me @bug later'), null);
  assert.equal(parseNoteTag('plain note'), null);
  assert.equal(parseNoteTag('@bug'), null);
});

test('strips the tag token for display only when the note is tagged', () => {
  assert.equal(noteTextWithoutTag('@idea make notes float'), 'make notes float');
  assert.equal(noteTextWithoutTag('plain note'), 'plain note');
});

test('every tag has chip styling and a menu hint', () => {
  for (const tag of NOTE_TAGS) {
    assert.ok(NOTE_TAG_CHIP[tag].length > 0, `missing chip classes for ${tag}`);
    assert.ok(NOTE_TAG_HINT[tag].length > 0, `missing menu hint for ${tag}`);
    // Pills are fully rounded to match the app's soft geometry.
    assert.match(NOTE_TAG_CHIP[tag], /rounded-full/);
  }
});

test('matchingNoteTags filters by prefix, empty query lists all', () => {
  assert.deepEqual(matchingNoteTags(''), [...NOTE_TAGS]);
  assert.deepEqual(matchingNoteTags('b'), ['bug']);
  assert.deepEqual(matchingNoteTags('CON'), ['constraint']);
  assert.deepEqual(matchingNoteTags('zzz'), []);
});

test('composeNoteText folds the tag into the stored text as a raw token', () => {
  assert.equal(composeNoteText(null, 'plain note'), 'plain note');
  assert.equal(composeNoteText('bug', 'fix the redirect'), '@bug fix the redirect');
  // The composed text round-trips through the stack parser.
  assert.equal(parseNoteTag(composeNoteText('idea', 'make notes float')), 'idea');
});

test('noteTagMenu exposes the @query and matches only for a lone @token', () => {
  assert.deepEqual(noteTagMenu('@', null), { query: '', matching: [...NOTE_TAGS] });
  assert.deepEqual(noteTagMenu('@b', null), { query: 'b', matching: ['bug'] });
  // A draft with a body is no longer a tag query, and a chipped tag closes the menu.
  assert.deepEqual(noteTagMenu('@bug with body', null), { query: undefined, matching: [] });
  assert.deepEqual(noteTagMenu('@', 'idea'), { query: undefined, matching: [] });
  assert.deepEqual(noteTagMenu('plain', null), { query: undefined, matching: [] });
});

test('exactNoteTag chips a fully typed tag, nothing partial or ambiguous', () => {
  assert.equal(exactNoteTag('bug', ['bug']), 'bug');
  assert.equal(exactNoteTag('BUG', ['bug']), 'bug');
  assert.equal(exactNoteTag('b', ['bug']), null);
  assert.equal(exactNoteTag(undefined, []), null);
});
