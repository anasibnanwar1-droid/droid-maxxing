import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { jsonResult, safeTool } from '../mcpToolUtils.js';
import { readDnaState } from './dnaFiles.js';
import { listPrototypes, prototypePromptGuidance } from './prototypes.js';
import { getLibraryItem, listLibraryItems } from './referenceLibrary.js';
import { scanComponentRegistry } from './registryScan.js';
import { nearestPaletteColor } from './tokens.js';
import { DESIGN_GUIDELINES } from './guidelines.js';

export function createDesignMcpServer(cwdForTool: () => string | undefined) {
  const cwd = () => {
    const value = cwdForTool();
    if (!value) throw new Error('Design tools need a mission with a workspace folder.');
    return value;
  };

  return createSdkMcpServer({
    name: 'droidmaxx-design',
    version: '0.1.0',
    tools: [
      tool(
        'design_dna',
        [
          'Read this project design DNA: DESIGN.md (visual system, tokens, rules) and MOTION.md (animation rules).',
          'Call this before any UI change so colors, type, spacing, radii, and motion match the project system.',
          'Returns file contents plus the parsed design-tokens block when present.',
        ].join(' '),
        {},
        safeTool(async () => {
          const state = readDnaState(cwd());
          return jsonResult({
            ok: true,
            cwd: state.cwd,
            design: state.design,
            motion: state.motion,
            tokens: state.tokens,
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
        safeTool(async () => jsonResult({ ok: true, guidelines: DESIGN_GUIDELINES })),
      ),
      tool(
        'design_system',
        [
          'Look up exact Design DNA token values on demand — the context-lean way to stay on-system without loading all of DESIGN.md into context.',
          'Returns the token summary: color roles and values, font roles, type scale, spacing, and radii.',
          'Pass a color (e.g. "#6b7280" or "rgb(107,114,128)") to find the nearest palette token and whether it is an on-palette match — use it to answer "is this the muted token?" before hardcoding a value.',
        ].join(' '),
        {
          color: z
            .string()
            .optional()
            .describe('A CSS color to match against the palette, e.g. "#6b7280".'),
        },
        safeTool(async (input) => {
          const tokens = readDnaState(cwd()).tokens;
          if (!tokens) {
            return jsonResult({
              ok: false,
              error: 'No design-tokens block in DESIGN.md yet. Run the DNA intake first.',
            });
          }
          const summary = {
            colors: tokens.colors,
            fonts: tokens.fonts,
            typeScale: tokens.typeScale,
            spacing: tokens.spacing,
            radii: tokens.radii,
          };
          const color = input.color?.trim();
          if (!color) return jsonResult({ ok: true, tokens: summary });
          const near = nearestPaletteColor(color, tokens.colors);
          const match = near
            ? {
                input: color,
                nearest: near.name,
                value: near.value,
                distance: Math.round(near.distance),
                onPalette: near.distance <= 6,
              }
            : { input: color, error: 'Could not parse that color.' };
          return jsonResult({ ok: true, tokens: summary, match });
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
        safeTool(async (input) => {
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
        safeTool(async (input) => {
          const prototypes = listPrototypes(cwd());
          if (input.id) {
            const match = prototypes.find((proto) => proto.id === input.id);
            if (!match) return jsonResult({ ok: false, error: `No prototype ${input.id}.` });
            return jsonResult({ ok: true, prototype: match });
          }
          return jsonResult({
            ok: true,
            guidance: prototypePromptGuidance(cwd()),
            prototypes: prototypes.map(({ html: _html, ...info }) => info),
          });
        }),
      ),
      tool(
        'design_reference_library',
        [
          'List design references the user saved from the live browser (name, source URL, note, captured styles).',
          'Pass an id to get one item with its captured computed styles, markup excerpt, and screenshot.',
          'Use these as visual targets when the user asks to make something look like a saved reference.',
        ].join(' '),
        {
          id: z.string().optional().describe('Library item id to fetch in full.'),
        },
        safeTool(async (input) => {
          if (input.id) {
            const item = getLibraryItem(cwd(), input.id);
            if (!item) return jsonResult({ ok: false, error: `No library item ${input.id}.` });
            const text = jsonResult({ ok: true, item });
            if (item.screenshotPath) {
              try {
                const data = await readFile(item.screenshotPath, 'base64');
                return {
                  content: [
                    { type: 'text' as const, text },
                    { type: 'image' as const, data, mimeType: 'image/png' as const },
                  ],
                };
              } catch {
                return text;
              }
            }
            return text;
          }
          const items = listLibraryItems(cwd()).map(
            ({ html: _html, styles: _styles, ...item }) => item,
          );
          return jsonResult({ ok: true, count: items.length, items });
        }),
      ),
    ],
  });
}
