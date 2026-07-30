// Pure image-attachment geometry and fidelity policy. Canvas/DOM work lives in
// imageFiles.ts; everything here is plain math so it can be unit-tested in Node.

export type ImagePasteQuality = 'original' | 'high' | 'compact';

export interface ImageQualityTier {
  /** Longest-side cap in pixels; 0 means never resize. */
  maxSide: number;
  mime: 'image/png' | 'image/jpeg';
  /** JPEG quality 0..1; ignored for PNG. */
  jpegQuality?: number;
}

// Original keeps the exact pasted bytes. High mirrors a retina-friendly cap
// with lossless PNG. Compact approximates what Droid's own paste pipeline does.
export const IMAGE_QUALITY_TIERS: Record<ImagePasteQuality, ImageQualityTier> = {
  original: { maxSide: 0, mime: 'image/png' },
  high: { maxSide: 2048, mime: 'image/png' },
  compact: { maxSide: 1568, mime: 'image/jpeg', jpegQuality: 0.8 },
};

// Must mirror EXTENSION_BY_MIME in electron/attachments.cjs: at Original
// fidelity the pasted bytes are persisted untouched, so anything outside this
// list would be rejected at save time. Module-private: the public check is
// isPersistableMime below.
const PERSISTABLE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Reads the MIME type of a data URL, or undefined when it is not one. */
export function dataUrlMime(dataUrl: string): string | undefined {
  return /^data:([^;,]+)/.exec(dataUrl)?.[1];
}

/** True when the desktop attachment store can persist this MIME type as-is. */
export function isPersistableMime(mime: string | undefined): boolean {
  return mime !== undefined && PERSISTABLE_IMAGE_MIMES.includes(mime);
}

export interface Size {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Scales `size` down to fit within maxSide on the longest edge. Never upscales. */
export function fitWithin(size: Size, maxSide: number): Size {
  const longest = Math.max(size.width, size.height);
  if (maxSide <= 0 || longest <= maxSide) return { ...size };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export const MIN_CROP_SIDE = 8;

/** Keeps a crop rect inside the image and at least MIN_CROP_SIDE on each edge. */
export function clampCropRect(rect: CropRect, image: Size): CropRect {
  const width = Math.min(Math.max(rect.width, MIN_CROP_SIDE), image.width);
  const height = Math.min(Math.max(rect.height, MIN_CROP_SIDE), image.height);
  return {
    x: Math.min(Math.max(rect.x, 0), image.width - width),
    y: Math.min(Math.max(rect.y, 0), image.height - height),
    width,
    height,
  };
}

/** Maps a rect drawn over the on-screen (fit) image back to natural pixels. */
export function displayedToNaturalRect(rect: CropRect, displayed: Size, natural: Size): CropRect {
  if (displayed.width <= 0 || displayed.height <= 0) return { x: 0, y: 0, ...natural };
  const scale = natural.width / displayed.width;
  return clampCropRect(
    {
      x: rect.x * scale,
      y: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    },
    natural,
  );
}

/** True when the rect covers the whole image, i.e. cropping would be a no-op. */
export function isFullImageRect(rect: CropRect, image: Size): boolean {
  return rect.x <= 0 && rect.y <= 0 && rect.width >= image.width && rect.height >= image.height;
}
