import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { z } from 'zod';
import { jsonResult, safeTool } from '../mcpToolUtils.js';
import { readDnaState } from './dnaFiles.js';
import {
  createModelReferenceDerivative,
  MODEL_REFERENCE_MAX_IMAGE_BYTES,
  MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE,
  MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES,
} from './modelReferenceImage.js';
import { listPrototypes, prototypePromptGuidance } from './prototypes.js';
import { getLibraryItem, listLibraryItems, resolveReferenceImagePath } from './referenceLibrary.js';
import { scanComponentRegistry } from './registryScan.js';
import { nearestPaletteColor } from './tokens.js';
import { DESIGN_GUIDELINES } from './guidelines.js';
import type { DesignLibraryItem, MotionDuration, MotionTokens } from './types.js';

export type DesignPreviewFn = (input: {
  cwd: string;
  path?: string;
  prototypeId?: string;
  name?: string;
}) => Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }>;

interface DesignMcpServerOptions {
  referenceLibraryBaseDir?: string;
}

export function createDesignMcpServer(
  cwdForTool: () => string | undefined,
  preview?: DesignPreviewFn,
  options: DesignMcpServerOptions = {},
) {
  const cwd = () => {
    const value = cwdForTool();
    if (!value) throw new Error('Design tools need a mission with a workspace folder.');
    return value;
  };

  return createSdkMcpServer({
    name: 'droidex-design',
    version: '0.1.0',
    tools: [
      tool(
        'design_dna',
        [
          'Read this project design DNA: DESIGN.md (visual system, tokens, rules) and MOTION.md (animation rules).',
          'Call this before any UI change so colors, type, spacing, radii, and motion match the project system.',
          'Returns file contents plus parsed design-tokens and motion-tokens blocks when present.',
        ].join(' '),
        {},
        safeTool(() => {
          const state = readDnaState(cwd());
          return jsonResult({
            ok: true,
            cwd: state.cwd,
            design: state.design,
            motion: state.motion,
            tokens: state.tokens,
            motionTokens: state.motionTokens,
          });
        }),
      ),
      tool(
        'design_guidelines',
        [
          'How to work in Design Mode for this project: operating scope, design-system enforcement, the light/dark theme policy, anti-slop craft rules, and code-quality expectations.',
          'Read this at the start of a design turn and follow it; pair it with design_dna / design_system for the actual token values.',
        ].join(' '),
        {},
        safeTool(() => jsonResult({ ok: true, guidelines: DESIGN_GUIDELINES })),
      ),
      tool(
        'design_system',
        [
          'Look up exact Design DNA token values on demand — the context-lean way to stay on-system without loading all of DESIGN.md into context.',
          'Returns color, font, type, spacing, radius, duration, and easing tokens.',
          'Pass a color (e.g. "#6b7280" or "rgb(107,114,128)") to find the nearest palette token and whether it is an on-palette match — use it to answer "is this the muted token?" before hardcoding a value.',
        ].join(' '),
        {
          color: z
            .string()
            .optional()
            .describe('A CSS color to match against the palette, e.g. "#6b7280".'),
          duration: z
            .number()
            .min(0)
            .max(10_000)
            .optional()
            .describe('A duration in milliseconds to match against the project motion scale.'),
          easing: z
            .string()
            .optional()
            .describe('An easing role or exact CSS easing value to resolve from MOTION.md.'),
        },
        safeTool((input) => {
          const state = readDnaState(cwd());
          const tokens = state.tokens;
          if (!tokens && input.color?.trim()) {
            return jsonResult({
              ok: false,
              error: 'Color lookup needs a design-tokens block in DESIGN.md.',
            });
          }
          if (!tokens && !state.motionTokens) {
            return jsonResult({
              ok: false,
              error: 'No executable design or motion tokens exist yet. Run the DNA intake first.',
            });
          }
          const summary = tokens
            ? {
                colors: tokens.colors,
                fonts: tokens.fonts,
                typeScale: tokens.typeScale,
                spacing: tokens.spacing,
                radii: tokens.radii,
              }
            : undefined;
          const color = input.color?.trim();
          const near = color && tokens ? nearestPaletteColor(color, tokens.colors) : undefined;
          const colorMatch = !color
            ? undefined
            : near
              ? {
                  input: color,
                  nearest: near.name,
                  value: near.value,
                  distance: Math.round(near.distance),
                  onPalette: near.distance <= 6,
                }
              : { input: color, error: 'Could not parse that color.' };
          return jsonResult({
            ok: true,
            tokens: summary,
            motion: state.motionTokens,
            matches: {
              ...(colorMatch ? { color: colorMatch } : {}),
              ...(input.duration === undefined || !state.motionTokens
                ? {}
                : { duration: nearestMotionDuration(input.duration, state.motionTokens) }),
              ...(input.easing?.trim() && state.motionTokens
                ? { easing: resolveMotionEasing(input.easing, state.motionTokens) }
                : {}),
            },
          });
        }),
      ),
      tool(
        'design_component_registry',
        [
          'List reusable UI components exported from this project (name, file, line, props signature).',
          'Use this to reuse an existing component instead of writing a new one, and to find the source of a component named by the user.',
        ].join(' '),
        {
          query: z
            .string()
            .optional()
            .describe('Optional case-insensitive filter on component name or file path.'),
        },
        safeTool((input) => {
          let components = scanComponentRegistry(cwd());
          const query = input.query?.trim().toLowerCase();
          if (query) {
            components = components.filter(
              (entry) =>
                entry.name.toLowerCase().includes(query) ||
                entry.file.toLowerCase().includes(query),
            );
          }
          return jsonResult({ ok: true, count: components.length, components });
        }),
      ),
      tool(
        'design_prototypes',
        [
          'List standalone HTML prototypes saved under .droidex/prototypes in this project.',
          'Prototypes are approved visual targets: when implementing one, match its look with project components and tokens.',
          'Pass an id to get the full prototype HTML.',
        ].join(' '),
        {
          id: z.string().optional().describe('Prototype id to fetch full HTML for.'),
        },
        safeTool((input) => {
          const prototypes = listPrototypes(cwd());
          if (input.id) {
            const match = prototypes.find((proto) => proto.id === input.id);
            if (!match) return jsonResult({ ok: false, error: `No prototype ${input.id}.` });
            return jsonResult({ ok: true, prototype: match });
          }
          return jsonResult({
            ok: true,
            guidance: prototypePromptGuidance(cwd()),
            prototypes: prototypes.map(({ id, name, path, updatedAt }) => ({
              id,
              name,
              path,
              updatedAt,
            })),
          });
        }),
      ),
      tool(
        'design_preview',
        [
          'Show an HTML page you wrote on the Studio canvas — this is how you present design work to the user.',
          'Do NOT open a native/system browser (browser_open) for design previews; the user is watching the canvas.',
          'Pass the path to a self-contained .html file in the workspace, or the id of a saved prototype (see design_prototypes). It renders as a live canvas frame and reloads in place when you preview the same target again.',
        ].join(' '),
        {
          path: z
            .string()
            .optional()
            .describe(
              'Path to a self-contained .html file in the workspace to render on the canvas.',
            ),
          prototypeId: z
            .string()
            .optional()
            .describe('Id of a saved prototype (from design_prototypes) to render on the canvas.'),
          name: z.string().optional().describe('Optional label for the canvas frame.'),
        },
        safeTool(async (input) => {
          if (!preview) {
            return jsonResult({
              ok: false,
              error: 'Canvas preview is not available in this session.',
            });
          }
          return jsonResult(
            await preview({
              cwd: cwd(),
              path: input.path,
              prototypeId: input.prototypeId,
              name: input.name,
            }),
          );
        }),
      ),
      tool(
        'design_reference_library',
        [
          'List visual references saved from the live browser or pasted onto the DROIDEX canvas as moodboard, inspiration, or reference images.',
          `Pass an id or up to ${String(MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE)} ids to receive bounded model-safe image derivatives plus source and derivative dimensions.`,
          `Each derivative is at most ${String(MODEL_REFERENCE_MAX_IMAGE_BYTES)} encoded bytes and all images in one response total at most ${String(MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES)} encoded bytes; the durable originals remain unchanged on disk.`,
          'Use these as visual targets when the user asks to match a moodboard or saved reference.',
        ].join(' '),
        {
          id: z.string().optional().describe('Library item id to fetch in full.'),
          ids: z
            .array(z.string())
            .min(1)
            .max(MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE)
            .optional()
            .describe('Library item ids to fetch together as bounded model-safe derivatives.'),
        },
        safeTool(async (input) => {
          if (input.id && input.ids) {
            throw new Error('Pass either id or ids, not both.');
          }
          const requestedIds = input.ids ?? (input.id ? [input.id] : undefined);
          if (requestedIds) {
            if (
              requestedIds.length === 0 ||
              requestedIds.length > MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE
            ) {
              throw new Error(
                `Request between 1 and ${String(MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE)} reference images.`,
              );
            }
            const ids = [...new Set(requestedIds)];
            const items = ids.map((id) =>
              getLibraryItem(cwd(), id, options.referenceLibraryBaseDir),
            );
            const missingIndex = items.findIndex((item) => !item);
            if (missingIndex >= 0) {
              return jsonResult({ ok: false, error: `No library item ${ids[missingIndex]}.` });
            }

            let remainingBytes = MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES;
            let remainingImages = items.filter((item) => item?.screenshotPath).length;
            const imageContent: {
              type: 'image';
              data: string;
              mimeType: string;
            }[] = [];
            const responseItems = [];
            for (const item of items) {
              if (!item) continue;
              const metadata = modelReferenceMetadata(item, true);
              if (!item.screenshotPath) {
                responseItems.push({ ...metadata, modelImage: { error: 'No image is stored.' } });
                continue;
              }
              const maxBytes = Math.min(
                MODEL_REFERENCE_MAX_IMAGE_BYTES,
                Math.floor(remainingBytes / remainingImages),
              );
              remainingImages -= 1;
              try {
                const imagePath = await resolveReferenceImagePath(
                  cwd(),
                  item.screenshotPath,
                  options.referenceLibraryBaseDir,
                );
                if (!imagePath) {
                  throw new Error('The stored image is outside this project’s reference library.');
                }
                const derivative = await createModelReferenceDerivative({
                  path: imagePath,
                  maxBytes,
                });
                const base64 = derivative.data.toString('base64');
                remainingBytes -= derivative.data.length;
                responseItems.push({
                  ...metadata,
                  modelImage: {
                    imageIndex: imageContent.length,
                    mimeType: derivative.mimeType,
                    source: {
                      ...derivative.source,
                      declaredMimeType: item.mimeType,
                    },
                    derivative: {
                      ...derivative.derivative,
                      base64Characters: base64.length,
                    },
                    maxBytes,
                  },
                });
                imageContent.push({
                  type: 'image',
                  data: base64,
                  mimeType: derivative.mimeType,
                });
              } catch (error) {
                responseItems.push({
                  ...metadata,
                  modelImage: {
                    error:
                      error instanceof Error
                        ? error.message
                        : 'Reference image could not be prepared.',
                  },
                });
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: jsonResult({
                    ok: true,
                    imageCount: imageContent.length,
                    budget: {
                      maxImages: MODEL_REFERENCE_MAX_IMAGES_PER_RESPONSE,
                      perImageEncodedBytes: MODEL_REFERENCE_MAX_IMAGE_BYTES,
                      responseEncodedImageBytes: MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES,
                      usedEncodedImageBytes:
                        MODEL_REFERENCE_MAX_RESPONSE_IMAGE_BYTES - remainingBytes,
                      usedBase64Characters: imageContent.reduce(
                        (total, image) => total + image.data.length,
                        0,
                      ),
                      note: 'Byte limits apply to JPEG payloads before base64 transport; actual base64 character counts are reported separately.',
                    },
                    ...(input.id
                      ? { item: responseItems[0] }
                      : { count: responseItems.length, items: responseItems }),
                  }),
                },
                ...imageContent,
              ],
            };
          }
          const items = listLibraryItems(cwd(), options.referenceLibraryBaseDir).map((item) =>
            modelReferenceMetadata(item, false),
          );
          return jsonResult({ ok: true, count: items.length, items });
        }),
      ),
    ],
  });
}

function nearestMotionDuration(input: number, tokens: MotionTokens) {
  const candidates = Object.entries(tokens.durations).map(([name, value]) => ({
    name,
    value,
    distanceMs: distanceFromDuration(input, value),
  }));
  candidates.sort((a, b) => a.distanceMs - b.distanceMs || a.name.localeCompare(b.name));
  const nearest = candidates[0];
  return { input, ...nearest, onScale: nearest.distanceMs === 0 };
}

function distanceFromDuration(input: number, duration: MotionDuration): number {
  if (!Array.isArray(duration)) return Math.abs(input - duration);
  if (input < duration[0]) return duration[0] - input;
  if (input > duration[1]) return input - duration[1];
  return 0;
}

function resolveMotionEasing(input: string, tokens: MotionTokens) {
  const normalized = input.trim().toLowerCase();
  const match = Object.entries(tokens.easings).find(
    ([name, value]) => name.toLowerCase() === normalized || value.toLowerCase() === normalized,
  );
  return match
    ? { input: input.trim(), role: match[0], value: match[1] }
    : { input: input.trim(), error: 'No matching project easing.', available: tokens.easings };
}

function modelReferenceMetadata(item: DesignLibraryItem, includeDetail: boolean) {
  const sourceUrl = /^https?:\/\//.test(item.url) ? item.url : undefined;
  return {
    id: item.id,
    name: item.name,
    note: item.note,
    category: item.category,
    createdAt: item.createdAt,
    sourceUrl,
    selector: item.selector,
    sourceComponent: item.source?.component,
    hasImage: item.screenshotPath !== undefined,
    ...(includeDetail ? { styles: item.styles, html: item.html } : {}),
  };
}
