import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NOTES_PER_SESSION,
  MAX_NOTE_TEXT_LENGTH,
  addSessionNote,
  dismissNotesIntro,
  loadNotesIntroSeen,
  loadSessionNotes,
  markSessionNoteUsed,
  removeSessionNote,
  saveSessionNotes,
  type SessionNotesMap,
} from './sessionNotes';

function fakeStorage() {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return data;
}

test('addSessionNote trims, prepends newest first, and rejects blank input', () => {
  const first = addSessionNote({}, 's1', '  remember the migration  ');
  assert.ok(first);
  assert.equal(first.s1.length, 1);
  assert.equal(first.s1[0].text, 'remember the migration');
  assert.equal(first.s1[0].usedAt, null);

  const second = addSessionNote(first, 's1', 'ask about rollout');
  assert.ok(second);
  assert.equal(second.s1[0].text, 'ask about rollout');
  assert.equal(second.s1[1].text, 'remember the migration');

  assert.equal(addSessionNote(second, 's1', '   '), null);
  // Sessions stay isolated.
  assert.equal(addSessionNote(second, 's2', 'other')?.s1.length, 2);
});

test('addSessionNote bounds text length and notes per session', () => {
  const long = addSessionNote({}, 's1', 'x'.repeat(MAX_NOTE_TEXT_LENGTH + 500));
  assert.equal(long?.s1[0].text.length, MAX_NOTE_TEXT_LENGTH);

  let map: SessionNotesMap = {};
  for (let i = 0; i < MAX_NOTES_PER_SESSION + 10; i++) {
    map = addSessionNote(map, 's1', `note ${String(i)}`) ?? map;
  }
  assert.equal(map.s1.length, MAX_NOTES_PER_SESSION);
  // Oldest notes are dropped first.
  assert.equal(map.s1.at(-1)?.text, `note ${String(10)}`);
});

test('markSessionNoteUsed stamps the first use only', () => {
  const map = addSessionNote(addSessionNote({}, 's1', 'a') ?? {}, 's1', 'b') ?? {};
  const id = map.s1[1].id;

  const marked = markSessionNoteUsed(map, 's1', id);
  assert.ok(marked);
  assert.equal(typeof marked.s1[1].usedAt, 'number');
  // The other note is untouched.
  assert.equal(marked.s1[0].usedAt, null);

  // A second mark keeps the original timestamp and returns null (no-op).
  assert.equal(markSessionNoteUsed(marked, 's1', id), null);
  // Unknown notes and sessions are no-ops.
  assert.equal(markSessionNoteUsed(map, 's1', 'nope'), null);
  assert.equal(markSessionNoteUsed(map, 'unknown', id), null);
});

test('removeSessionNote drops the note and prunes empty sessions', () => {
  const withOne = addSessionNote({}, 's1', 'a');
  const id = withOne?.s1[0].id;
  assert.ok(id);
  const emptied = removeSessionNote(withOne ?? {}, 's1', id);
  assert.deepEqual(emptied, {});

  // Unknown ids and sessions are no-ops that preserve identity.
  const map = addSessionNote({}, 's1', 'b') ?? {};
  assert.equal(removeSessionNote(map, 's1', 'nope'), map);
  assert.equal(removeSessionNote(map, 'unknown', id), map);
});

test('session notes round-trip through localStorage, including used state', () => {
  fakeStorage();
  const added = addSessionNote(addSessionNote({}, 's1', 'first') ?? {}, 's1', 'second') ?? {};
  const map = markSessionNoteUsed(added, 's1', added.s1[1].id) ?? added;
  saveSessionNotes(map);
  const loaded = loadSessionNotes();
  assert.deepEqual(
    loaded.s1.map((note) => note.text),
    ['second', 'first'],
  );
  assert.equal(loaded.s1[1].usedAt, map.s1[1].usedAt);
  assert.equal(loaded.s1[0].usedAt, null);
});

test('notes intro is unseen on a fresh profile and seen after dismissal', () => {
  fakeStorage();
  assert.equal(loadNotesIntroSeen(), false);
  dismissNotesIntro();
  assert.equal(loadNotesIntroSeen(), true);
});

test('loadSessionNotes sanitizes corrupt payloads', () => {
  const data = fakeStorage();
  data.set(
    'droid-session-notes',
    JSON.stringify({
      ok: [{ id: 'n1', text: 'keep me', createdAt: 1, usedAt: 42 }],
      junkUsedAt: [{ id: 'n3', text: 'valid text', createdAt: 3, usedAt: 'yesterday' }],
      blanks: [{ id: 'n2', text: '   ', createdAt: 2 }],
      malformed: [{ id: 3, text: 4 }, 'junk', null],
      notArray: 'nope',
    }),
  );
  const loaded = loadSessionNotes();
  assert.deepEqual(Object.keys(loaded).sort(), ['junkUsedAt', 'ok']);
  assert.deepEqual(loaded.ok, [{ id: 'n1', text: 'keep me', createdAt: 1, usedAt: 42 }]);
  // A non-numeric usedAt degrades to "unused" instead of breaking the note.
  assert.equal(loaded.junkUsedAt[0].usedAt, null);

  data.set('droid-session-notes', 'not json{');
  assert.deepEqual(loadSessionNotes(), {});
  data.set('droid-session-notes', '[1,2]');
  assert.deepEqual(loadSessionNotes(), {});
});
