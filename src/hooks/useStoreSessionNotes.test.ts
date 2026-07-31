import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';

test('session notes stack newest first per session and remove cleanly', () => {
  const first = reducer(initialState, {
    type: 'SESSION_NOTE_ADD',
    appSessionId: 's1',
    text: 'first note',
  });
  const second = reducer(first, { type: 'SESSION_NOTE_ADD', appSessionId: 's1', text: 'second' });
  assert.deepEqual(
    second.sessionNotes.s1.map((note) => note.text),
    ['second', 'first note'],
  );

  // Notes from another session are untouched.
  const other = reducer(second, { type: 'SESSION_NOTE_ADD', appSessionId: 's2', text: 'other' });
  assert.equal(other.sessionNotes.s1.length, 2);
  assert.equal(other.sessionNotes.s2.length, 1);

  const id = other.sessionNotes.s1[0].id;
  const removed = reducer(other, { type: 'SESSION_NOTE_REMOVE', appSessionId: 's1', noteId: id });
  assert.deepEqual(
    removed.sessionNotes.s1.map((note) => note.text),
    ['first note'],
  );

  const emptied = reducer(removed, {
    type: 'SESSION_NOTE_REMOVE',
    appSessionId: 's1',
    noteId: removed.sessionNotes.s1[0].id,
  });
  assert.equal(emptied.sessionNotes.s1, undefined);
});

test('blank notes are rejected without changing state', () => {
  const next = reducer(initialState, {
    type: 'SESSION_NOTE_ADD',
    appSessionId: 's1',
    text: '   ',
  });
  assert.equal(next, initialState);
  assert.deepEqual(next.sessionNotes, {});
});

test('marking a note used stamps it once and no-ops afterwards', () => {
  const withNote = reducer(initialState, {
    type: 'SESSION_NOTE_ADD',
    appSessionId: 's1',
    text: 'send me later',
  });
  const noteId = withNote.sessionNotes.s1[0].id;

  const marked = reducer(withNote, { type: 'SESSION_NOTE_MARK_USED', appSessionId: 's1', noteId });
  assert.equal(typeof marked.sessionNotes.s1[0].usedAt, 'number');

  // Repeated marks and unknown notes leave state untouched.
  assert.equal(
    reducer(marked, { type: 'SESSION_NOTE_MARK_USED', appSessionId: 's1', noteId }),
    marked,
  );
  assert.equal(
    reducer(marked, { type: 'SESSION_NOTE_MARK_USED', appSessionId: 's1', noteId: 'nope' }),
    marked,
  );
});
