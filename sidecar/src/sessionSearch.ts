/**
 * Transcript content search over the session files under ~/.factory/sessions.
 *
 * The sidebar search matches chat text (user prompts and assistant replies),
 * not tool I/O or thinking. Extraction is cached per file freshness key
 * (path + mtime + size), so a fresh keystroke only re-reads files that
 * changed since the previous query; per-query file and byte budgets cap the
 * cold-scan cost so a large sessions tree cannot monopolize the bridge.
 */
import { parseSessionLineEvents } from './sessionTranscriptParser.js';
import { readSessionRawWindowAsync } from './sessionTranscript.js';
import type { SessionSearchMatch, SessionSearchResult, TranscriptEvent } from './protocol.js';

// One searchable chat moment: who said it, when, and what the text was.
interface SearchableRecord {
  ts: number;
  author: 'user' | 'assistant';
  text: string;
}

// Everything a search needs to open one session file. The caller
// (HistoryIndex) resolves canonical identity; this module only reads.
export interface SessionSearchCandidate {
  providerSessionId: string;
  appSessionId: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

// Most recent files considered per query; older history simply does not
// match rather than slowing every keystroke.
const MAX_FILES_PER_QUERY = 150;
// Total bytes one query may read from disk (cache hits are free). ~8 maximal
// session files; typical scans stay far below.
const MAX_BYTES_PER_QUERY = 40_000_000;
const MAX_RESULTS = 25;
const MAX_MATCHES_PER_SESSION = 3;
// Extraction cache size in files; an active sidebar search touches a handful
// of changing files, so a small LRU is enough.
const MAX_CACHED_FILES = 40;
const SNIPPET_RADIUS = 70;

interface CachedExtraction {
  mtimeMs: number;
  sizeBytes: number;
  records: SearchableRecord[];
}

const extractionCache = new Map<string, CachedExtraction>();

async function cachedExtraction(candidate: SessionSearchCandidate): Promise<SearchableRecord[]> {
  const hit = extractionCache.get(candidate.path);
  if (hit?.mtimeMs === candidate.mtimeMs && hit.sizeBytes === candidate.sizeBytes) {
    // Refresh the LRU position so actively searched files stay warm.
    extractionCache.delete(candidate.path);
    extractionCache.set(candidate.path, hit);
    return hit.records;
  }
  const records = await extractRecords(candidate);
  extractionCache.delete(candidate.path);
  extractionCache.set(candidate.path, {
    mtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.sizeBytes,
    records,
  });
  const oldest = extractionCache.keys().next();
  if (extractionCache.size > MAX_CACHED_FILES && !oldest.done) {
    extractionCache.delete(oldest.value);
  }
  return records;
}

// Parse the file's message lines into searchable chat records. Lines are
// cheaply prefiltered by the message field name so tool-heavy sessions only
// JSON.parse real conversation rows; corrupt rows are skipped like the
// transcript reader does.
async function extractRecords(candidate: SessionSearchCandidate): Promise<SearchableRecord[]> {
  const window = await readSessionRawWindowAsync(candidate.path, candidate.sizeBytes);
  const records: SearchableRecord[] = [];
  for (const raw of window.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes('"message"')) continue;
    let events: TranscriptEvent[];
    try {
      // Candidates are top-level session files, so the transcript role is
      // always 'primary'; the role only keys event attribution, which search
      // does not use.
      events = parseSessionLineEvents(
        candidate.appSessionId,
        candidate.providerSessionId,
        'primary',
        JSON.parse(line) as Parameters<typeof parseSessionLineEvents>[3],
      );
    } catch {
      continue;
    }
    for (const e of events) {
      if (e.kind !== 'text' || !e.text) continue;
      records.push({ ts: e.ts, author: e.author === 'user' ? 'user' : 'assistant', text: e.text });
    }
  }
  return records;
}

// A single-line snippet centered on the first match, ellipsized at the cut
// boundaries, or null when the record does not contain the query.
function buildSnippet(text: string, queryLower: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const index = flat.toLowerCase().indexOf(queryLower);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(flat.length, index + queryLower.length + SNIPPET_RADIUS);
  const snippet = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  return snippet;
}

/**
 * Search the given candidates (most recent first) for chat text containing
 * `query` (case-insensitive substring). Returns one result per session with
 * up to MAX_MATCHES_PER_SESSION snippets, newest match first.
 *
 * Async because this answers a bridge command: each awaited file read (and
 * the explicit yield between files) lets the event loop pump WebSocket
 * traffic, so a cold multi-MB scan never stalls streaming for other sessions.
 */
export async function searchSessionFiles(
  candidates: SessionSearchCandidate[],
  query: string,
): Promise<SessionSearchResult[]> {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) return [];
  const results: SessionSearchResult[] = [];
  let filesScanned = 0;
  let bytesRead = 0;
  for (const candidate of candidates) {
    if (results.length >= MAX_RESULTS || filesScanned >= MAX_FILES_PER_QUERY) break;
    if (bytesRead > MAX_BYTES_PER_QUERY) break;
    const hit = extractionCache.get(candidate.path);
    const warm = hit?.mtimeMs === candidate.mtimeMs && hit.sizeBytes === candidate.sizeBytes;
    if (!warm) {
      filesScanned += 1;
      bytesRead += candidate.sizeBytes;
      // Warm-cache hits continue in microtasks; a cold file's read/parse is a
      // sync burst, so hand the loop a macrotask slot before the next file.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    const matches: SessionSearchMatch[] = [];
    const records = await cachedExtraction(candidate);
    for (let i = records.length - 1; i >= 0 && matches.length < MAX_MATCHES_PER_SESSION; i -= 1) {
      const record = records[i];
      const snippet = buildSnippet(record.text, queryLower);
      if (snippet !== null) {
        matches.push({ snippet, author: record.author, ts: record.ts });
      }
    }
    if (matches.length > 0) {
      results.push({ appSessionId: candidate.appSessionId, matches });
    }
  }
  return results;
}

/** Test hook: drop cached extractions so file edits are observed. */
export function resetSessionSearchCache(): void {
  extractionCache.clear();
}
