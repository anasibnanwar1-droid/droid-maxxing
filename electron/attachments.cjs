/**
 * Image attachment persistence for composer pastes/drops.
 *
 * The renderer hands us a processed image as a data URL; we write it into a
 * dedicated temp directory and return the absolute path so the prompt can
 * reference it as an @-mention. discard() only ever unlinks files inside that
 * directory, so a compromised or buggy renderer cannot delete arbitrary paths.
 *
 * The directory lives in the shared temp dir under a predictable name, so it
 * is kept owner-only (0o700) and a symlinked root is refused outright: writes
 * must never be redirected and discard()'s path boundary must stay real.
 *
 * Kept free of `require('electron')` so it can be unit-tested under plain Node;
 * main.cjs injects the attachments directory.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Pasted retina screenshots can be large; 40 MiB of decoded bytes is generous
// headroom without letting a runaway renderer fill the disk.
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

// base64 inflates 3 bytes into 4 chars, so any payload longer than this must
// decode beyond the cap. Checked before decoding so an oversized data URL
// cannot exhaust main-process memory through replace()/Buffer.from().
const MAX_DATA_URL_BASE64_CHARS = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

// Saved attachments are referenced by the in-flight prompt they were pasted
// into; anything older than a day is residue from an interrupted run. Swept
// on every save so the temp store stays bounded.
const MAX_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1000;

// A generated paste name that already exists (pre-created file or symlink) is
// never followed or clobbered: the exclusive create fails and we retry with a
// fresh name this many times before giving up.
const MAX_SAVE_ATTEMPTS = 3;

const EXTENSION_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

// Returns { ext, buffer } or throws on anything that is not a decodable image
// data URL within the size cap.
function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Attachment payload must be a data URL string');
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Attachment payload is not a base64 data URL');
  const ext = EXTENSION_BY_MIME.get(match[1]);
  if (!ext) {
    throw new Error(
      `Unsupported image type: ${match[1]} (supported: ${[...EXTENSION_BY_MIME.keys()].join(', ')})`,
    );
  }
  if (match[2].length > MAX_DATA_URL_BASE64_CHARS) {
    throw new Error('Attachment exceeds the size limit');
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0) throw new Error('Attachment payload is empty');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the size limit');
  return { ext, buffer };
}

// Creates the attachments root owner-only and verifies it is a real directory
// we own before any read or write. A symlink (or non-directory) at the
// predictable temp path would silently redirect saves and let discard()
// unlink outside the intended root; failing to tighten permissions means the
// directory belongs to someone else. Both fail fast.
async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await fsp.lstat(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing to use attachments directory: ${dir} is not a real directory`);
  }
  try {
    await fsp.chmod(dir, 0o700);
  } catch (error) {
    throw new Error(
      `Refusing to use attachments directory: cannot enforce owner-only permissions on ${dir}`,
      { cause: error },
    );
  }
}

// Best-effort janitor: a stale file that cannot be removed must not block
// saving, so per-file failures are logged and skipped.
async function sweepStale(dir) {
  const entries = await fsp.readdir(dir);
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry);
      try {
        const stats = await fsp.stat(target);
        if (!stats.isFile()) return;
        if (Date.now() - stats.mtimeMs <= MAX_ATTACHMENT_AGE_MS) return;
        await fsp.rm(target, { force: true });
      } catch (error) {
        if (error && error.code === 'ENOENT') return; // vanished between readdir and stat
        console.warn(`Could not sweep stale attachment ${target}:`, error);
      }
    }),
  );
}

// Writes buffer under an exclusive create ('wx'), so a pre-existing file or
// symlink at the generated name is never followed or clobbered. makeName
// supplies a fresh name per attempt; the final EEXIST propagates.
async function writeExclusive(dir, makeName, buffer) {
  for (let attempt = 1; ; attempt += 1) {
    const target = path.join(dir, makeName());
    try {
      await fsp.writeFile(target, buffer, { flag: 'wx' });
      return target;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || attempt === MAX_SAVE_ATTEMPTS) throw error;
    }
  }
}

async function save(dir, dataUrl) {
  const { ext, buffer } = decodeImageDataUrl(dataUrl);
  await ensurePrivateDir(dir);
  await sweepStale(dir);
  return writeExclusive(
    dir,
    () => `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`,
    buffer,
  );
}

// Unlinks a previously saved attachment. Paths escaping the attachments
// directory are refused outright; a missing file is treated as already gone.
async function discard(dir, target) {
  if (typeof target !== 'string' || target.length === 0) return;
  await ensurePrivateDir(dir);
  const resolved = path.resolve(target);
  const root = path.resolve(dir);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to discard a path outside the attachments directory');
  }
  await fsp.rm(resolved, { force: true });
}

module.exports = {
  save,
  discard,
  decodeImageDataUrl,
  writeExclusive,
  MAX_ATTACHMENT_BYTES,
  MAX_DATA_URL_BASE64_CHARS,
};
