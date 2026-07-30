/**
 * Image attachment persistence for composer pastes/drops.
 *
 * The renderer hands us a processed image as a data URL; we write it into a
 * dedicated temp directory and return the absolute path so the prompt can
 * reference it as an @-mention. discard() only ever unlinks files inside that
 * directory, so a compromised or buggy renderer cannot delete arbitrary paths.
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
  if (!ext) throw new Error(`Unsupported image type: ${match[1]}`);
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0) throw new Error('Attachment payload is empty');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the size limit');
  return { ext, buffer };
}

async function save(dir, dataUrl) {
  const { ext, buffer } = decodeImageDataUrl(dataUrl);
  await fsp.mkdir(dir, { recursive: true });
  const name = `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const target = path.join(dir, name);
  await fsp.writeFile(target, buffer);
  return target;
}

// Unlinks a previously saved attachment. Paths escaping the attachments
// directory are refused outright; a missing file is treated as already gone.
async function discard(dir, target) {
  if (typeof target !== 'string' || target.length === 0) return;
  const resolved = path.resolve(target);
  const root = path.resolve(dir);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to discard a path outside the attachments directory');
  }
  await fsp.rm(resolved, { force: true });
}

module.exports = { save, discard, decodeImageDataUrl, MAX_ATTACHMENT_BYTES };
