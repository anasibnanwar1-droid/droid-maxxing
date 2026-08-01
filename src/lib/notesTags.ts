// Lightweight inline tags for session notes. A note starting with a known
// @tag renders a chip in the stack; the raw text (tag included) still rides
// into the composer so the model sees the context. Unknown @words stay plain
// text, so mentions never turn into chips by accident.
export const NOTE_TAGS = ['bug', 'next', 'idea', 'constraint'] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];

const TAG_TOKEN = /^@([a-z]+)\s+/i;

export function parseNoteTag(text: string): NoteTag | null {
  const word = TAG_TOKEN.exec(text)?.[1]?.toLowerCase();
  return NOTE_TAGS.find((tag) => tag === word) ?? null;
}

// Display text with the tag token removed (the chip carries it visually).
export function noteTextWithoutTag(text: string): string {
  return parseNoteTag(text) === null ? text : text.replace(TAG_TOKEN, '');
}

// Fully-rounded pill to match the app's soft geometry; usage sites add only
// padding and text sizing.
export const NOTE_TAG_CHIP: Record<NoteTag, string> = {
  bug: 'rounded-full bg-droid-red/15 text-droid-red',
  next: 'rounded-full bg-droid-orange/15 text-droid-orange',
  idea: 'rounded-full bg-droid-green/15 text-droid-green',
  constraint: 'rounded-full bg-droid-accent/15 text-droid-accent',
};

// One-line hints shown next to each tag in the pad's @ menu.
export const NOTE_TAG_HINT: Record<NoteTag, string> = {
  bug: 'something broken',
  next: 'follow-up step',
  idea: 'worth exploring',
  constraint: 'must not break',
};

// Tags matching a partial @query (an empty query lists all), for the pad's
// autocomplete menu.
export function matchingNoteTags(query: string): NoteTag[] {
  const prefix = query.toLowerCase();
  return NOTE_TAGS.filter((tag) => tag.startsWith(prefix));
}

// The stored note keeps the tag as a raw @token prefix, so the stack chip and
// the composer seeding keep working off the note text alone.
export function composeNoteText(tag: NoteTag | null, draft: string): string {
  return tag === null ? draft : `@${tag} ${draft}`;
}

// The pad's @ autocomplete state: the live query (undefined once the draft is
// more than a lone @token, or when a tag is already chipped) and the matching
// tags the menu should list.
export function noteTagMenu(
  draft: string,
  chipped: NoteTag | null,
): { query: string | undefined; matching: NoteTag[] } {
  const query = chipped === null ? /^@([a-z]*)$/i.exec(draft)?.[1] : undefined;
  return { query, matching: query === undefined ? [] : matchingNoteTags(query) };
}

// Resolves a fully typed tag ("@bug" followed by Space) to a chip without
// requiring the menu, but only when it names exactly one known tag.
export function exactNoteTag(query: string | undefined, matching: NoteTag[]): NoteTag | null {
  const only = matching.length === 1 ? matching[0] : undefined;
  return only !== undefined && query?.toLowerCase() === only ? only : null;
}
