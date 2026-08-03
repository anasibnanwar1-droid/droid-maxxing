import { createCanvas, loadImage } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDesignMcpServer } from './designMcpServer.js';
import { serializeMotionTokenBlock } from './motionTokens.js';
import {
  MODEL_REFERENCE_MAX_EDGE_PX,
  MODEL_REFERENCE_MAX_IMAGE_BYTES,
  MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE,
  MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES,
} from './modelReferenceImage.js';
import { importReferenceImage } from './referenceLibrary.js';
import { serializeTokenBlock } from './tokens.js';

interface ToolImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ReferenceMetadata {
  id: string;
  modelImage: {
    imageIndex: number;
    mimeType: string;
    maxBytes: number;
    source: {
      mimeType: string;
      declaredMimeType?: string;
      width: number;
      height: number;
      bytes: number;
    };
    derivative: {
      width: number;
      height: number;
      bytes: number;
      base64Characters: number;
    };
  };
}

test('design DNA and system tools expose executable project motion', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-design-tools-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, 'DESIGN.md'),
    serializeTokenBlock({
      colors: { accent: '#3366ff' },
      fonts: { sans: 'Inter, sans-serif' },
      typeScale: [14, 16],
      spacing: [4, 8],
      radii: [6, 10],
    }),
  );
  writeFileSync(
    join(cwd, 'MOTION.md'),
    serializeMotionTokenBlock({
      durations: { element: [200, 260], page: 320 },
      easings: { standard: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      pressScale: 0.97,
      reducedMotion: 'reduce',
    }),
  );
  const server = createDesignMcpServer(() => cwd);
  const dna = server.tools.find((candidate) => candidate.name === 'design_dna');
  const system = server.tools.find((candidate) => candidate.name === 'design_system');
  assert.ok(dna);
  assert.ok(system);

  const dnaResult = JSON.parse(String(await dna.handler({}))) as {
    motionTokens: { durations: Record<string, number | [number, number]> };
  };
  const systemResult = JSON.parse(
    String(await system.handler({ duration: 230, easing: 'standard' })),
  ) as {
    motion: { pressScale: number };
    matches: {
      duration: {
        input: number;
        name: string;
        value: number | [number, number];
        distanceMs: number;
        onScale: boolean;
      };
      easing: { role: string; value: string };
    };
  };

  assert.deepEqual(dnaResult.motionTokens.durations.element, [200, 260]);
  assert.equal(systemResult.motion.pressScale, 0.97);
  assert.deepEqual(systemResult.matches.duration, {
    input: 230,
    name: 'element',
    value: [200, 260],
    distanceMs: 0,
    onScale: true,
  });
  assert.deepEqual(systemResult.matches.easing, {
    input: 'standard',
    role: 'standard',
    value: 'cubic-bezier(0.16, 1, 0.3, 1)',
  });
});

test('design system resolves motion for a MOTION-only project', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-motion-tools-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, 'MOTION.md'),
    serializeMotionTokenBlock({
      durations: { page: 300 },
      easings: { enter: 'ease-out' },
      reducedMotion: 'reduce',
    }),
  );
  const system = createDesignMcpServer(() => cwd).tools.find(
    (candidate) => candidate.name === 'design_system',
  );
  assert.ok(system);

  const result = JSON.parse(String(await system.handler({ duration: 280, easing: 'enter' }))) as {
    ok: boolean;
    tokens?: unknown;
    motion: { durations: { page: number } };
    matches: { duration: { name: string }; easing: { role: string } };
  };
  assert.equal(result.ok, true);
  assert.equal(result.tokens, undefined);
  assert.equal(result.motion.durations.page, 300);
  assert.equal(result.matches.duration.name, 'page');
  assert.equal(result.matches.easing.role, 'enter');
});

test('design_reference_library keeps the original and returns a bounded derivative', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-model-reference-'));
  const cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const original = createNoiseJpeg(1_800, 1_200, 17);
  assert.ok(original.length > MODEL_REFERENCE_MAX_IMAGE_BYTES);
  const [saved] = importReferenceImage({
    cwd,
    id: 'canvas-oversized-reference',
    name: 'Oversized reference',
    category: 'inspiration',
    dataUrl: `data:image/jpeg;base64,${original.toString('base64')}`,
    baseDir,
  });

  const tool = referenceTool(cwd, baseDir);
  const result = await tool.handler({ id: saved.id });
  const content = resultContent(result);
  const metadata = JSON.parse(textContent(content).text) as {
    ok: boolean;
    item: ReferenceMetadata;
    budget: {
      perImageEncodedBytes: number;
      responseEncodedImageBytes: number;
      usedEncodedImageBytes: number;
      usedBase64Characters: number;
    };
  };
  const image = imageContent(content)[0];
  const derivative = Buffer.from(image.data, 'base64');
  const decoded = await loadImage(derivative);

  assert.equal(metadata.ok, true);
  assert.equal(metadata.budget.perImageEncodedBytes, MODEL_REFERENCE_MAX_IMAGE_BYTES);
  assert.equal(metadata.budget.responseEncodedImageBytes, MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.ok(derivative.length <= MODEL_REFERENCE_MAX_IMAGE_BYTES);
  assert.ok(image.data.length <= 4 * Math.ceil(MODEL_REFERENCE_MAX_IMAGE_BYTES / 3));
  assert.equal(metadata.item.modelImage.source.mimeType, 'image/jpeg');
  assert.equal(metadata.item.modelImage.source.declaredMimeType, 'image/jpeg');
  assert.equal(metadata.item.modelImage.imageIndex, 0);
  assert.equal(metadata.item.modelImage.source.width, 1_800);
  assert.equal(metadata.item.modelImage.source.height, 1_200);
  assert.equal(metadata.item.modelImage.source.bytes, original.length);
  assert.equal(metadata.item.modelImage.derivative.bytes, derivative.length);
  assert.equal(metadata.item.modelImage.derivative.base64Characters, image.data.length);
  assert.equal(metadata.item.modelImage.derivative.width, decoded.width);
  assert.equal(metadata.item.modelImage.derivative.height, decoded.height);
  assert.equal(metadata.budget.usedEncodedImageBytes, derivative.length);
  assert.equal(metadata.budget.usedBase64Characters, image.data.length);
  assert.ok(Math.max(decoded.width, decoded.height) <= MODEL_REFERENCE_MAX_EDGE_PX);
  assert.equal('screenshotPath' in metadata.item, false);
  assert.equal('url' in metadata.item, false);
  assert.deepEqual(readFileSync(saved.screenshotPath ?? ''), original);

  const listing = await tool.handler({});
  assert.equal(typeof listing, 'string');
  const listed = JSON.parse(String(listing)) as { items: Record<string, unknown>[] };
  assert.equal('screenshotPath' in listed.items[0], false);
  assert.equal('url' in listed.items[0], false);
});

test('design_reference_library bounds a multi-reference response', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-model-references-'));
  const cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const original = createNoiseJpeg(1_600, 1_000, 29);
  assert.ok(original.length > MODEL_REFERENCE_MAX_IMAGE_BYTES);
  const ids = Array.from(
    { length: MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE },
    (_, index) => `canvas-reference-${index + 1}`,
  );
  for (const [index, id] of ids.entries()) {
    importReferenceImage({
      cwd,
      id,
      name: `Reference ${index + 1}`,
      category: 'moodboard',
      dataUrl: `data:image/jpeg;base64,${original.toString('base64')}`,
      baseDir,
    });
  }

  const result = await referenceTool(cwd, baseDir).handler({ ids });
  const content = resultContent(result);
  const metadata = JSON.parse(textContent(content).text) as {
    ok: boolean;
    count: number;
    imageCount: number;
    budget: {
      usedEncodedImageBytes: number;
      usedBase64Characters: number;
    };
    items: ReferenceMetadata[];
  };
  const images = imageContent(content);
  const derivatives = images.map((image) => Buffer.from(image.data, 'base64'));

  assert.equal(metadata.ok, true);
  assert.equal(metadata.count, ids.length);
  assert.equal(metadata.imageCount, ids.length);
  assert.deepEqual(
    metadata.items.map((item) => item.id),
    ids,
  );
  assert.equal(images.length, ids.length);
  assert.ok(
    derivatives.reduce((total, derivative) => total + derivative.length, 0) <=
      MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES,
  );
  assert.equal(
    metadata.budget.usedEncodedImageBytes,
    derivatives.reduce((total, derivative) => total + derivative.length, 0),
  );
  assert.equal(
    metadata.budget.usedBase64Characters,
    images.reduce((total, image) => total + image.data.length, 0),
  );
  for (const [index, derivative] of derivatives.entries()) {
    const modelImage = metadata.items[index].modelImage;
    assert.equal(modelImage.imageIndex, index);
    assert.equal(images[index].mimeType, 'image/jpeg');
    assert.ok(derivative.length <= MODEL_REFERENCE_MAX_IMAGE_BYTES);
    assert.ok(derivative.length <= modelImage.maxBytes);
    assert.equal(modelImage.source.width, 1_600);
    assert.equal(modelImage.source.height, 1_000);
    assert.equal(modelImage.derivative.bytes, derivative.length);
    assert.equal(modelImage.derivative.base64Characters, images[index].data.length);
    assert.ok(
      Math.max(modelImage.derivative.width, modelImage.derivative.height) <=
        MODEL_REFERENCE_MAX_EDGE_PX,
    );
  }
});

test('design_reference_library never falls back to original bytes', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'droidex-invalid-model-reference-'));
  const cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const original = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0x03]);
  const [saved] = importReferenceImage({
    cwd,
    id: 'canvas-invalid-reference',
    name: 'Invalid reference',
    category: 'reference',
    dataUrl: `data:image/jpeg;base64,${original.toString('base64')}`,
    baseDir,
  });

  const result = await referenceTool(cwd, baseDir).handler({ id: saved.id });
  const content = resultContent(result);
  const metadata = JSON.parse(textContent(content).text) as {
    item: { modelImage: { error: string } };
  };

  assert.equal(imageContent(content).length, 0);
  assert.match(metadata.item.modelImage.error, /image|decode|format/i);
  assert.deepEqual(readFileSync(saved.screenshotPath ?? ''), original);
});

function referenceTool(cwd: string, baseDir: string) {
  const server = createDesignMcpServer(() => cwd, undefined, {
    referenceLibraryBaseDir: baseDir,
  });
  const reference = server.tools.find((candidate) => candidate.name === 'design_reference_library');
  assert.ok(reference);
  return reference;
}

function resultContent(result: unknown): Array<ToolTextContent | ToolImageContent> {
  assert.ok(result && typeof result === 'object' && 'content' in result);
  return (result as { content: Array<ToolTextContent | ToolImageContent> }).content;
}

function textContent(content: Array<ToolTextContent | ToolImageContent>): ToolTextContent {
  const text = content.find((item): item is ToolTextContent => item.type === 'text');
  assert.ok(text);
  return text;
}

function imageContent(content: Array<ToolTextContent | ToolImageContent>): ToolImageContent[] {
  return content.filter((item): item is ToolImageContent => item.type === 'image');
}

function createNoiseJpeg(width: number, height: number, seed: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(width, height);
  let state = seed >>> 0;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels.data[offset] = state & 0xff;
    pixels.data[offset + 1] = (state >>> 8) & 0xff;
    pixels.data[offset + 2] = (state >>> 16) & 0xff;
    pixels.data[offset + 3] = 0xff;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.encodeSync('jpeg', 96);
}
