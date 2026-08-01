import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';

export const MODEL_REFERENCE_MAX_EDGE_PX = 1_600;
export const MODEL_REFERENCE_MAX_IMAGE_BYTES = 384 * 1024;
export const MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES = 1024 * 1024;
export const MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE = 4;
const MODEL_REFERENCE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MODEL_REFERENCE_MAX_SOURCE_EDGE_PX = 12_000;
export const MODEL_REFERENCE_MAX_SOURCE_PIXELS = 50_000_000;

const MIN_EDGE_PX = 64;
const JPEG_QUALITIES = [82, 70, 58, 46] as const;
const MAX_RESIZE_ATTEMPTS = 8;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

type SourceMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type LoadedImage = Awaited<ReturnType<typeof loadImage>>;
interface ImageHeader {
  mimeType: SourceMimeType;
  width: number;
  height: number;
}

export interface ModelReferenceDerivative {
  data: Buffer;
  mimeType: 'image/jpeg';
  source: {
    mimeType: SourceMimeType;
    width: number;
    height: number;
    bytes: number;
  };
  derivative: {
    width: number;
    height: number;
    bytes: number;
  };
}

export async function createModelReferenceDerivative(input: {
  path: string;
  maxBytes?: number;
}): Promise<ModelReferenceDerivative> {
  const maxBytes = input.maxBytes ?? MODEL_REFERENCE_MAX_IMAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Model reference image budget must be a positive integer.');
  }

  const source = await loadModelReferenceSource(input.path);
  return encodeModelReferenceDerivative(source, maxBytes);
}

async function loadModelReferenceSource(path: string): Promise<{
  image: LoadedImage;
  mimeType: SourceMimeType;
  width: number;
  height: number;
  bytes: number;
}> {
  const sourceBytes = await readFile(path);
  if (sourceBytes.length === 0 || sourceBytes.length > MODEL_REFERENCE_MAX_SOURCE_BYTES) {
    throw new Error(
      `Reference image must be between 1 byte and ${String(MODEL_REFERENCE_MAX_SOURCE_BYTES)} bytes.`,
    );
  }
  const header = inspectImageHeader(sourceBytes);
  if (!header) {
    throw new Error('Reference image has an invalid PNG, JPEG, WebP, or GIF header.');
  }
  assertSafeSourceDimensions(header.width, header.height);

  const sourceImage = await loadImage(sourceBytes);
  const sourceWidth = sourceImage.width;
  const sourceHeight = sourceImage.height;
  assertSafeSourceDimensions(sourceWidth, sourceHeight);
  return {
    image: sourceImage,
    mimeType: header.mimeType,
    width: sourceWidth,
    height: sourceHeight,
    bytes: sourceBytes.length,
  };
}

async function encodeModelReferenceDerivative(
  source: {
    image: LoadedImage;
    mimeType: SourceMimeType;
    width: number;
    height: number;
    bytes: number;
  },
  maxBytes: number,
): Promise<ModelReferenceDerivative> {
  let dimensions = fitWithinEdge(source.width, source.height, MODEL_REFERENCE_MAX_EDGE_PX);
  for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt += 1) {
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source.image, 0, 0, dimensions.width, dimensions.height);

    let smallest: Buffer | undefined;
    for (const quality of JPEG_QUALITIES) {
      const encoded = await canvas.encode('jpeg', quality);
      if (!smallest || encoded.length < smallest.length) smallest = encoded;
      if (encoded.length <= maxBytes) {
        return {
          data: encoded,
          mimeType: 'image/jpeg',
          source: {
            mimeType: source.mimeType,
            width: source.width,
            height: source.height,
            bytes: source.bytes,
          },
          derivative: {
            width: dimensions.width,
            height: dimensions.height,
            bytes: encoded.length,
          },
        };
      }
    }

    if (!smallest) break;
    const next = shrinkDimensions(dimensions, maxBytes, smallest.length);
    if (next.width === dimensions.width && next.height === dimensions.height) break;
    dimensions = next;
  }

  throw new Error(
    `Reference image could not fit within the ${String(maxBytes)}-byte model budget.`,
  );
}

function fitWithinEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function shrinkDimensions(
  dimensions: { width: number; height: number },
  maxBytes: number,
  currentBytes: number,
): { width: number; height: number } {
  const estimatedScale = Math.sqrt(maxBytes / currentBytes) * 0.9;
  const scale = Math.min(0.85, Math.max(0.35, estimatedScale));
  const nextWidth = Math.max(MIN_EDGE_PX, Math.floor(dimensions.width * scale));
  const nextHeight = Math.max(MIN_EDGE_PX, Math.floor(dimensions.height * scale));
  return {
    width: Math.min(dimensions.width, nextWidth),
    height: Math.min(dimensions.height, nextHeight),
  };
}

function isUsefulDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function inspectImageHeader(bytes: Buffer): ImageHeader | undefined {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectGif(bytes) ?? inspectWebp(bytes);
}

function inspectPng(bytes: Buffer): ImageHeader | undefined {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    !bytes.subarray(-PNG_END.length).equals(PNG_END)
  ) {
    return undefined;
  }
  return {
    mimeType: 'image/png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function inspectJpeg(bytes: Buffer): ImageHeader | undefined {
  if (!hasJpegEnvelope(bytes)) return undefined;
  let offset = 2;
  while (offset < bytes.length - 1) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return undefined;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return undefined;
      return {
        mimeType: 'image/jpeg',
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function hasJpegEnvelope(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function inspectGif(bytes: Buffer): ImageHeader | undefined {
  const header = bytes.subarray(0, 6).toString('ascii');
  if (
    bytes.length < 14 ||
    (header !== 'GIF87a' && header !== 'GIF89a') ||
    bytes[bytes.length - 1] !== 0x3b
  ) {
    return undefined;
  }
  let width = bytes.readUInt16LE(6);
  let height = bytes.readUInt16LE(8);
  let offset = 13 + colorTableBytes(bytes[10]);
  while (offset < bytes.length) {
    const block = bytes[offset];
    offset += 1;
    if (block === 0x3b) return { mimeType: 'image/gif', width, height };
    if (block === 0x21) {
      offset = skipGifSubBlocks(bytes, offset + 1);
    } else if (block === 0x2c) {
      if (offset + 9 > bytes.length) return undefined;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const frameWidth = bytes.readUInt16LE(offset + 4);
      const frameHeight = bytes.readUInt16LE(offset + 6);
      width = Math.max(width, left + frameWidth, frameWidth);
      height = Math.max(height, top + frameHeight, frameHeight);
      offset += 9 + colorTableBytes(bytes[offset + 8]);
      if (offset >= bytes.length) return undefined;
      offset = skipGifSubBlocks(bytes, offset + 1);
    } else {
      return undefined;
    }
    if (offset < 0) return undefined;
  }
  return undefined;
}

function colorTableBytes(packed: number): number {
  return packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
}

function skipGifSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) return -1;
  }
  return -1;
}

function inspectWebp(bytes: Buffer): ImageHeader | undefined {
  if (!hasWebpEnvelope(bytes)) return undefined;
  const chunkType = bytes.subarray(12, 16).toString('ascii');
  const chunkBytes = bytes.readUInt32LE(16);
  if (chunkBytes < 5 || 20 + chunkBytes > bytes.length) return undefined;
  switch (chunkType) {
    case 'VP8X':
      return inspectExtendedWebp(bytes, chunkBytes);
    case 'VP8 ':
      return inspectLossyWebp(bytes, chunkBytes);
    case 'VP8L':
      return inspectLosslessWebp(bytes);
    default:
      return undefined;
  }
}

function hasWebpEnvelope(bytes: Buffer): boolean {
  return (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  );
}

function inspectExtendedWebp(bytes: Buffer, chunkBytes: number): ImageHeader | undefined {
  if (chunkBytes < 10) return undefined;
  return {
    mimeType: 'image/webp',
    width: readUInt24LE(bytes, 24) + 1,
    height: readUInt24LE(bytes, 27) + 1,
  };
}

function inspectLossyWebp(bytes: Buffer, chunkBytes: number): ImageHeader | undefined {
  if (chunkBytes >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      mimeType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return undefined;
}

function inspectLosslessWebp(bytes: Buffer): ImageHeader | undefined {
  if (bytes[20] !== 0x2f) return undefined;
  const dimensions = bytes.readUInt32LE(21);
  return {
    mimeType: 'image/webp',
    width: (dimensions & 0x3fff) + 1,
    height: ((dimensions >>> 14) & 0x3fff) + 1,
  };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function assertSafeSourceDimensions(width: number, height: number): void {
  if (!isUsefulDimension(width) || !isUsefulDimension(height)) {
    throw new Error('Reference image has invalid dimensions.');
  }
  if (
    width > MODEL_REFERENCE_MAX_SOURCE_EDGE_PX ||
    height > MODEL_REFERENCE_MAX_SOURCE_EDGE_PX ||
    width * height > MODEL_REFERENCE_MAX_SOURCE_PIXELS
  ) {
    throw new Error(
      `Reference image dimensions ${String(width)}x${String(height)} exceed the ${String(MODEL_REFERENCE_MAX_SOURCE_EDGE_PX)}px edge or ${String(MODEL_REFERENCE_MAX_SOURCE_PIXELS)}-pixel preparation limit.`,
    );
  }
}
