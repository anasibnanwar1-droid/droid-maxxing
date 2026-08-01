import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Live component preview: bundle ONE exported component from the user's repo —
 * with the project's own react/react-dom and any CSS its import graph pulls in —
 * into a standalone stage page. The result is the real component as it ships,
 * not a screenshot or an agent-written imitation.
 */
export interface ComponentPreviewInput {
  cwd: string;
  file: string; // repo-relative path to the component module
  name: string; // exported identifier
  exportKind: 'default' | 'named';
}

export interface ComponentPreviewResult {
  dir: string;
  id: string;
  assets?: string[];
  error?: string;
}

// Global stylesheets worth pulling onto the stage so tokens/base styles apply.
const GLOBAL_CSS_CANDIDATES = [
  'src/index.css',
  'src/main.css',
  'src/globals.css',
  'src/styles/globals.css',
  'app/globals.css',
  'styles/globals.css',
];

export async function buildComponentPreview(
  input: ComponentPreviewInput,
): Promise<ComponentPreviewResult> {
  const abs = resolve(input.cwd, input.file);
  if (abs !== input.cwd && !abs.startsWith(input.cwd + sep)) {
    return { dir: '', id: '', error: 'Component path is outside the workspace.' };
  }
  if (!existsSync(abs)) {
    return { dir: '', id: '', error: `No such file: ${input.file}` };
  }
  const id = `component-${createHash('sha1')
    .update(`${input.cwd} ${input.file} ${input.name}`)
    .digest('hex')
    .slice(0, 12)}`;
  const dir = await componentPreviewDirectory(id);

  const entry = join(dir, 'entry.tsx');
  await writeFile(entry, entrySource(abs, input));

  try {
    const esbuild = await loadEsbuild(input.cwd);
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: join(dir, 'bundle.js'),
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      minify: false,
      logLevel: 'silent',
      // Resolve react/deps from the PROJECT so the preview uses its versions.
      nodePaths: [join(input.cwd, 'node_modules')],
      loader: {
        '.woff': 'file',
        '.woff2': 'file',
        '.png': 'dataurl',
        '.svg': 'dataurl',
        '.jpg': 'dataurl',
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  } catch (error) {
    return { dir, id, error: firstBuildError(error) };
  }

  await writeFile(join(dir, 'index.html'), stageHtml(input.name));
  const assets = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== 'entry.tsx')
    .map((entry) => entry.name);
  return { dir, id, assets };
}

function entrySource(absComponentPath: string, input: ComponentPreviewInput): string {
  const importLine =
    input.exportKind === 'default'
      ? `import Component from ${JSON.stringify(absComponentPath)};`
      : `import { ${input.name} as Component } from ${JSON.stringify(absComponentPath)};`;
  const globalCss = GLOBAL_CSS_CANDIDATES.map((rel) => join(input.cwd, rel)).filter((p) => {
    try {
      // Tailwind directives need the project's own build pipeline; skip raw files.
      return !readFileSync(p, 'utf8').includes('@tailwind');
    } catch {
      return false;
    }
  });
  return [
    ...globalCss.map((p) => `import ${JSON.stringify(p)};`),
    importLine,
    `import { createRoot } from 'react-dom/client';`,
    `import { createElement } from 'react';`,
    `const mount = document.getElementById('stage-root');`,
    `try {`,
    `  createRoot(mount).render(createElement(Component));`,
    `} catch (err) {`,
    `  mount.innerHTML = '<pre class="stage-error">' + String(err) + '</pre>';`,
    `}`,
    `window.addEventListener('error', (e) => {`,
    `  const note = document.getElementById('stage-note');`,
    `  if (note) note.textContent = 'Runtime error: ' + e.message + ' (component may need props)';`,
    `});`,
  ].join('\n');
}

// Neutral stage: the component on a clean production-like background, centered,
// with a light/dark toggle so both themes are inspectable.
function stageHtml(name: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(name)}</title>
<link rel="stylesheet" href="bundle.css" onerror="this.remove()" />
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font-family: system-ui, sans-serif; background: #f5f5f3; transition: background .2s; }
  body.dark { background: #131316; }
  .stage-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; font-size: 12px; color: #888; }
  .stage-bar button { border: 1px solid #d5d5d0; background: transparent; border-radius: 6px; padding: 3px 10px; font-size: 11px; color: inherit; cursor: pointer; }
  body.dark .stage-bar button { border-color: #333; }
  .stage-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px; }
  .stage-error { color: #c0563a; font-size: 12px; white-space: pre-wrap; max-width: 640px; }
</style>
</head>
<body>
  <div class="stage-bar">
    <span>${escapeHtml(name)} · live</span>
    <span id="stage-note"></span>
    <button onclick="document.body.classList.toggle('dark')">theme</button>
  </div>
  <div class="stage-center"><div id="stage-root"></div></div>
  <script src="bundle.js"></script>
</body>
</html>`;
}

interface EsbuildLike {
  build: (options: Record<string, unknown>) => Promise<unknown>;
}

// Prefer the project's own esbuild (matches its ecosystem); fall back to ours.
async function loadEsbuild(cwd: string): Promise<EsbuildLike> {
  try {
    const req = createRequire(join(cwd, 'package.json'));
    return (await import(req.resolve('esbuild'))) as EsbuildLike;
  } catch {
    return (await import('esbuild')) as EsbuildLike;
  }
}

function firstBuildError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n').find((l) => l.trim().length > 0) ?? 'Bundle failed.';
  return line.slice(0, 300);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

export function componentPreviewLabel(name: string): string {
  return `${name} · component`;
}

let componentPreviewRoot: Promise<string> | undefined;

async function componentPreviewDirectory(id: string): Promise<string> {
  componentPreviewRoot ??= mkdtemp(join(tmpdir(), 'droidex-component-preview-'));
  const dir = join(await componentPreviewRoot, id);
  await mkdir(dir, { recursive: true });
  return dir;
}
