import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const MAX_CANVAS_FRAMES = 24;
export const MAX_CANVAS_ANNOTATIONS = 128;
export const MAX_CANVAS_IMAGES = 24;
export const MAX_ANNOTATION_POINTS = 2_048;
export const MAX_TOTAL_ANNOTATION_POINTS = 8_192;

const projectIdSchema = z.string().regex(/^project-[a-f0-9]{24}$/);
export const canvasEntityIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const labelSchema = z.string().trim().min(1).max(200);
const coordinateSchema = z.number().finite().min(-10_000_000).max(10_000_000);
const sizeSchema = z.number().finite().positive().max(100_000);
const workspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isSafeWorkspacePath, 'must be a normalized workspace-relative path');
const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isSupportedUrl, 'must be an http(s) URL or about:blank');

const frameSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: httpUrlSchema }).strict(),
  z
    .object({
      type: z.literal('workspace-html'),
      relativePath: workspacePathSchema.refine(
        (value) => /\.html?$/i.test(value),
        'must point to an HTML file',
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('prototype'),
      prototypeId: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    })
    .strict(),
  z.object({ type: z.literal('brand-book') }).strict(),
  z
    .object({
      type: z.literal('component'),
      file: workspacePathSchema,
      name: labelSchema,
      exportKind: z.enum(['default', 'named']),
    })
    .strict(),
]);

const pointSchema = z.object({ x: coordinateSchema, y: coordinateSchema }).strict();
const annotationKindSchema = z.enum([
  'pencil',
  'line',
  'arrow',
  'rectangle',
  'square',
  'ellipse',
  'measure',
]);
const annotationColorSchema = z.enum(['blue', 'red', 'green', 'amber']);

const frameSchema = z
  .object({
    id: canvasEntityIdSchema,
    name: labelSchema,
    source: frameSourceSchema,
    kind: z.enum(['route', 'generated', 'showcase', 'prototype']),
    viewport: z
      .object({
        mode: z.enum(['fit', 'desktop', 'laptop', 'tablet', 'mobile', 'custom']),
        width: sizeSchema.optional(),
        height: sizeSchema.optional(),
      })
      .strict()
      .refine(
        (viewport) =>
          (viewport.width === undefined && viewport.height === undefined) ||
          (viewport.width !== undefined && viewport.height !== undefined),
        'width and height must be provided together',
      ),
    x: coordinateSchema,
    y: coordinateSchema,
  })
  .strict();

const annotationSchema = z
  .object({
    id: canvasEntityIdSchema,
    kind: annotationKindSchema,
    points: z.array(pointSchema).min(2).max(MAX_ANNOTATION_POINTS),
    color: annotationColorSchema,
    fill: z.union([z.literal('none'), annotationColorSchema]),
    strokeWidth: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    frameId: canvasEntityIdSchema.optional(),
  })
  .strict()
  .superRefine((annotation, context) => {
    if (annotation.kind !== 'pencil' && annotation.points.length !== 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: `${annotation.kind} annotations require exactly two points`,
      });
    }
  });

const imagePlacementSchema = z
  .object({
    id: canvasEntityIdSchema,
    libraryId: canvasEntityIdSchema,
    tag: z.enum(['moodboard', 'inspiration', 'reference']),
    x: coordinateSchema,
    y: coordinateSchema,
    width: sizeSchema,
    height: sizeSchema,
  })
  .strict();

const canvasContentShape = {
  view: z
    .object({
      pan: pointSchema,
      zoom: z.number().finite().min(0.05).max(8),
    })
    .strict(),
  frames: z.array(frameSchema).max(MAX_CANVAS_FRAMES),
  annotations: z.array(annotationSchema).max(MAX_CANVAS_ANNOTATIONS),
  images: z.array(imagePlacementSchema).max(MAX_CANVAS_IMAGES),
};
const canvasContentObjectSchema = z.object(canvasContentShape).strict();
type CanvasContentValue = z.infer<typeof canvasContentObjectSchema>;

export const canvasContentSchema = canvasContentObjectSchema.superRefine(refineCanvasContent);

export const canvasDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    threadId: canvasEntityIdSchema,
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
    ...canvasContentShape,
  })
  .strict()
  .superRefine(refineCanvasContent);

export type CanvasDocumentContent = z.infer<typeof canvasContentSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

export function formatCanvasSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`)
    .join('; ');
}

function addDuplicateIssues(
  entries: { id: string }[],
  path: 'frames' | 'annotations' | 'images',
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, 'id'],
        message: `duplicates id ${entry.id}`,
      });
    }
    seen.add(entry.id);
  });
}

function refineCanvasContent(content: CanvasContentValue, context: z.RefinementCtx): void {
  addDuplicateIssues(content.frames, 'frames', context);
  addDuplicateIssues(content.annotations, 'annotations', context);
  addDuplicateIssues(content.images, 'images', context);
  const frameIds = new Set(content.frames.map((frame) => frame.id));
  content.annotations.forEach((annotation, index) => {
    if (annotation.frameId && !frameIds.has(annotation.frameId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['annotations', index, 'frameId'],
        message: `references missing frame ${annotation.frameId}`,
      });
    }
  });
  const pointCount = content.annotations.reduce(
    (total, annotation) => total + annotation.points.length,
    0,
  );
  if (pointCount > MAX_TOTAL_ANNOTATION_POINTS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['annotations'],
      message: `contains ${String(pointCount)} points; maximum is ${String(MAX_TOTAL_ANNOTATION_POINTS)}`,
    });
  }
}

function isSafeWorkspacePath(value: string): boolean {
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isSupportedUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
