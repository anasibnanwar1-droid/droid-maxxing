import test from 'node:test';
import assert from 'node:assert';
import {
  TEXT_PREVIEW_CAP_BYTES,
  BINARY_PREVIEW_CAP_BYTES,
  classifyByName,
  classifyPreview,
  isPreviewable,
  previewSizeCapBytes,
  previewSizeLabel,
} from './filePreview';

test('classifyByName groups common text, markdown, json, csv, and config types', () => {
  for (const name of [
    'notes.txt',
    'README.md',
    'config.json',
    'data.csv',
    'app.yml',
    'schema.graphql',
    'Dockerfile',
    '.gitignore',
    'main.ts',
    'patch.diff',
  ]) {
    assert.equal(classifyByName(name), 'text', `expected ${name} to be text`);
  }
});

test('classifyByName routes raster images, pdf, docx, and xlsx to their own buckets', () => {
  assert.equal(classifyByName('logo.png'), 'image');
  assert.equal(classifyByName('photo.JPEG'), 'image');
  assert.equal(classifyByName('icon.svg'), 'image');
  assert.equal(classifyByName('paper.pdf'), 'pdf');
  assert.equal(classifyByName('report.docx'), 'docx');
  assert.equal(classifyByName('budget.xlsx'), 'xlsx');
});

test('classifyByName falls back to external for macro, legacy, archive, and unknown types', () => {
  // legacy / macro office payloads that the renderer cannot render safely
  for (const name of [
    'old.doc',
    'macro.docm',
    'legacy.xls',
    'macro.xlsm',
    'slides.ppt',
    'macro.pptm',
  ]) {
    assert.equal(classifyByName(name), 'external', `expected ${name} to be external`);
  }
  // archives / executables / unknown
  for (const name of ['bundle.zip', 'installer.exe', 'library.dylib', 'thing.bin', 'noext']) {
    assert.equal(classifyByName(name), 'external', `expected ${name} to be external`);
  }
});

test('classifyByName handles dotfiles and well-known filenames regardless of case', () => {
  assert.equal(classifyByName('.npmrc'), 'text');
  assert.equal(classifyByName('MAKEFILE'), 'text');
  assert.equal(classifyByName('path/To/Dockerfile'), 'text');
});

test('previewSizeCapBytes applies the text cap only to text', () => {
  assert.equal(previewSizeCapBytes('text'), TEXT_PREVIEW_CAP_BYTES);
  assert.equal(previewSizeCapBytes('image'), BINARY_PREVIEW_CAP_BYTES);
  assert.equal(previewSizeCapBytes('pdf'), BINARY_PREVIEW_CAP_BYTES);
  assert.equal(previewSizeCapBytes('docx'), BINARY_PREVIEW_CAP_BYTES);
  assert.equal(previewSizeCapBytes('xlsx'), BINARY_PREVIEW_CAP_BYTES);
  // external also uses the binary cap so the badge stays consistent, even
  // though readPreview will short-circuit before reading any bytes.
  assert.equal(previewSizeCapBytes('external'), BINARY_PREVIEW_CAP_BYTES);
});

test('isPreviewable is false only for external', () => {
  assert.equal(isPreviewable('text'), true);
  assert.equal(isPreviewable('image'), true);
  assert.equal(isPreviewable('pdf'), true);
  assert.equal(isPreviewable('docx'), true);
  assert.equal(isPreviewable('xlsx'), true);
  assert.equal(isPreviewable('external'), false);
});

test('classifyPreview returns a complete classification object', () => {
  const result = classifyPreview('plan.md');
  assert.deepEqual(result, {
    category: 'text',
    previewable: true,
    sizeCapBytes: TEXT_PREVIEW_CAP_BYTES,
  });

  const external = classifyPreview('payload.zip');
  assert.deepEqual(external, {
    category: 'external',
    previewable: false,
    sizeCapBytes: BINARY_PREVIEW_CAP_BYTES,
  });
});

test('previewSizeLabel keeps text and external distinct from binary', () => {
  assert.equal(previewSizeLabel('text'), '5 MiB text');
  assert.equal(previewSizeLabel('image'), '25 MiB binary');
  assert.equal(previewSizeLabel('pdf'), '25 MiB binary');
  assert.equal(previewSizeLabel('external'), 'Open externally');
});
