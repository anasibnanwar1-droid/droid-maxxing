// Browser-side image encoding for composer attachments: blobs to data URLs,
// canvas re-encoding for the fidelity tiers, and crop extraction. The pure
// geometry/policy lives in images.ts; this module needs the DOM.

import {
  IMAGE_QUALITY_TIERS,
  clampCropRect,
  fitWithin,
  isFullImageRect,
  type CropRect,
  type ImagePasteQuality,
  type Size,
} from './images';

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(new Error('Could not read the image'));
    };
    reader.readAsDataURL(blob);
  });
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error('Could not decode the image'));
    };
    img.src = dataUrl;
  });
}

function encode(img: HTMLImageElement, target: Size, source?: CropRect): string {
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  const sx = source?.x ?? 0;
  const sy = source?.y ?? 0;
  const sw = source?.width ?? img.naturalWidth;
  const sh = source?.height ?? img.naturalHeight;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, target.width, target.height);
  return canvas.toDataURL('image/png');
}

function encodeTier(
  img: HTMLImageElement,
  source: CropRect,
  quality: Exclude<ImagePasteQuality, 'original'>,
): string {
  const tier = IMAGE_QUALITY_TIERS[quality];
  const target = fitWithin({ width: source.width, height: source.height }, tier.maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  if (tier.mime === 'image/jpeg') {
    // JPEG has no alpha; composite onto white so transparent pastes stay legible.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
  }
  ctx.drawImage(
    img,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    target.width,
    target.height,
  );
  return canvas.toDataURL(tier.mime, tier.jpegQuality);
}

/**
 * Encodes a pasted/dropped image according to the fidelity tier. Original
 * returns the pasted bytes untouched; the other tiers re-encode via canvas.
 */
export async function processImage(dataUrl: string, quality: ImagePasteQuality): Promise<string> {
  if (quality === 'original') return dataUrl;
  const img = await loadImage(dataUrl);
  const full = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  return encodeTier(img, full, quality);
}

/**
 * Extracts a crop (in natural pixels) and re-encodes it per the fidelity tier.
 * A rect covering the whole image is a no-op that just applies the tier.
 */
export async function cropImage(
  dataUrl: string,
  rect: CropRect,
  quality: ImagePasteQuality,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const natural = { width: img.naturalWidth, height: img.naturalHeight };
  if (quality === 'original' && isFullImageRect(rect, natural)) return dataUrl;
  const clamped = clampCropRect(rect, natural);
  if (quality === 'original')
    return encode(img, { width: clamped.width, height: clamped.height }, clamped);
  return encodeTier(img, clamped, quality);
}
