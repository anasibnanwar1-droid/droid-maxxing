import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dnaFilePath, MAX_DNA_BYTES, readDnaFile, writeDnaFile } from './dnaFiles.js';

test('DNA writes reject oversized content without truncating the existing file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-write-'));
  writeDnaFile(cwd, 'design', 'keep me');

  assert.throws(
    () => writeDnaFile(cwd, 'design', 'x'.repeat(MAX_DNA_BYTES + 1)),
    /must not exceed/,
  );
  assert.equal(readDnaFile(cwd, 'design').content, 'keep me');
});

test('DNA reads reject oversized files before loading them as content', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-read-'));
  writeFileSync(dnaFilePath(cwd, 'motion'), Buffer.alloc(MAX_DNA_BYTES + 1));

  assert.throws(() => readDnaFile(cwd, 'motion'), /must not exceed/);
});
