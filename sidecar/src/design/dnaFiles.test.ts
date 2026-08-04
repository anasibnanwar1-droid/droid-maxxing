import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  dnaFilePath,
  MAX_DNA_BYTES,
  readDnaFile,
  writeDnaFile,
  writeDnaFiles,
} from './dnaFiles.js';

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

test('DNA reads and writes reject repository-controlled symlinks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-symlink-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'droidex-dna-outside-')), 'secret.md');
  writeFileSync(outside, 'must stay private');
  symlinkSync(outside, dnaFilePath(cwd, 'design'));

  assert.throws(() => readDnaFile(cwd, 'design'), /must not be symbolic links/);
  assert.throws(() => writeDnaFile(cwd, 'design', 'replacement'), /must not be symbolic links/);
  assert.equal(readFileSync(outside, 'utf8'), 'must stay private');
});

test('paired DNA persistence rejects an unsafe target without changing either file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-pair-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'droidex-dna-pair-outside-')), 'motion.md');
  writeDnaFile(cwd, 'design', 'original design');
  writeDnaFile(cwd, 'motion', 'original motion');
  unlinkSync(dnaFilePath(cwd, 'motion'));
  writeFileSync(outside, 'outside motion');
  symlinkSync(outside, dnaFilePath(cwd, 'motion'));

  assert.throws(
    () => writeDnaFiles(cwd, { design: 'new design', motion: 'new motion' }),
    /must not be symbolic links/,
  );
  assert.equal(readDnaFile(cwd, 'design').content, 'original design');
  assert.equal(readFileSync(outside, 'utf8'), 'outside motion');
});

test('atomic DNA writes leave no staging files behind', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-atomic-'));

  writeDnaFiles(cwd, { design: 'design', motion: 'motion' });

  assert.equal(readDnaFile(cwd, 'design').content, 'design');
  assert.equal(readDnaFile(cwd, 'motion').content, 'motion');
  assert.deepEqual(readdirSync(cwd).sort(), ['DESIGN.md', 'MOTION.md']);
});

test('paired DNA persistence completes an interrupted commit from its transaction journal', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-dna-recover-'));
  const transactionId = '11111111-1111-4111-8111-111111111111';
  const stagedMotion = `.MOTION.md.${transactionId}.tmp`;
  writeFileSync(dnaFilePath(cwd, 'design'), 'new design');
  writeFileSync(join(cwd, stagedMotion), 'new motion');
  writeFileSync(
    join(cwd, '.droidex-dna-transaction.json'),
    JSON.stringify({
      version: 1,
      design: `.DESIGN.md.${transactionId}.tmp`,
      motion: stagedMotion,
    }),
  );

  assert.equal(readDnaFile(cwd, 'design').content, 'new design');
  assert.equal(readDnaFile(cwd, 'motion').content, 'new motion');
  assert.deepEqual(readdirSync(cwd).sort(), ['DESIGN.md', 'MOTION.md']);
});
