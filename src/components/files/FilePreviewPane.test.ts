import assert from 'node:assert/strict';
import test from 'node:test';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfDocumentForPreview, parseDelimitedText } from '../../lib/filePreview';

test('delimited previews discard columns beyond the visible column limit', () => {
  const firstRow = Array.from({ length: 60 }, (_, index) => `value${index + 1}`).join(',');
  const rows = parseDelimitedText(`${firstRow}\nnext,row`, ',', 500, 50);

  assert.equal(rows[0].length, 50);
  assert.equal(rows[0][49], 'value50');
  assert.deepEqual(rows[1], ['next', 'row']);
});

test('PDF loading does not create a task after the preview is cancelled', async () => {
  let resolveLibrary:
    | ((library: { getDocument: () => PDFDocumentLoadingTask }) => void)
    | undefined;
  const library = new Promise<{ getDocument: () => PDFDocumentLoadingTask }>((resolve) => {
    resolveLibrary = resolve;
  });
  let cancelled = false;
  let getDocumentCalled = false;
  const loading = loadPdfDocumentForPreview(
    () => library,
    new Uint8Array([1, 2, 3]),
    () => cancelled,
    () => {},
  );

  cancelled = true;
  resolveLibrary?.({
    getDocument: () => {
      getDocumentCalled = true;
      throw new Error('should not create a loading task');
    },
  });

  assert.equal(await loading, null);
  assert.equal(getDocumentCalled, false);
});

test('PDF loading destroys a completed task when cancellation wins the race', async () => {
  let resolveDocument: ((document: PDFDocumentProxy) => void) | undefined;
  const document = { numPages: 1 } as PDFDocumentProxy;
  const documentPromise = new Promise<PDFDocumentProxy>((resolve) => {
    resolveDocument = resolve;
  });
  let destroyed = 0;
  const loadingTask = {
    promise: documentPromise,
    destroy: async () => {
      destroyed += 1;
    },
  } as PDFDocumentLoadingTask;
  let cancelled = false;
  const loading = loadPdfDocumentForPreview(
    async () => ({ getDocument: () => loadingTask }),
    new Uint8Array([1, 2, 3]),
    () => cancelled,
    () => {},
  );

  await Promise.resolve();
  cancelled = true;
  resolveDocument?.(document);

  assert.equal(await loading, null);
  assert.equal(destroyed, 1);
});
