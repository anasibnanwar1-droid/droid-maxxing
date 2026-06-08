import type { ElementSource } from '../types/bridge';

const MAX_CHAIN = 6;

export function resolveElementSource(el: Element): ElementSource {
  const react = resolveReact(el);
  if (react && react.file) return react;
  const attr = resolveAttributes(el);
  if (attr && attr.file) return mergeChain(attr, react);
  const vue = resolveVue(el);
  if (vue && vue.file) return vue;
  const svelte = resolveSvelte(el);
  if (svelte && svelte.file) return svelte;
  return react ?? vue ?? svelte ?? attr ?? { confidence: 'none' };
}

function mergeChain(primary: ElementSource, fallback: ElementSource | undefined): ElementSource {
  if (!fallback) return primary;
  return {
    ...primary,
    component: primary.component ?? fallback.component,
    componentChain: primary.componentChain ?? fallback.componentChain,
    framework: primary.framework ?? fallback.framework,
  };
}

function resolveReact(el: Element): ElementSource | undefined {
  const key = Object.keys(el).find(
    (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
  );
  if (!key) return undefined;
  let fiber: ReactFiber | null = (el as unknown as Record<string, ReactFiber>)[key] ?? null;
  let file: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  const chain: string[] = [];
  let guard = 0;
  while (fiber && guard < 200) {
    guard += 1;
    if (!file && fiber._debugSource && typeof fiber._debugSource.fileName === 'string') {
      file = normalizeFile(fiber._debugSource.fileName);
      line = numberOr(fiber._debugSource.lineNumber);
      column = numberOr(fiber._debugSource.columnNumber);
    }
    const name = componentName(fiber.type);
    if (name && chain[chain.length - 1] !== name && chain.length < MAX_CHAIN) chain.push(name);
    fiber = fiber._debugOwner ?? fiber.return ?? null;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'react',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    line,
    column,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveVue(el: Element): ElementSource | undefined {
  const anyEl = el as unknown as Record<string, unknown>;
  let instance =
    (anyEl.__vueParentComponent as VueInstance | undefined) ??
    ((anyEl.__vnode as { component?: VueInstance } | undefined)?.component) ??
    (anyEl.__vue__ as VueInstance | undefined);
  if (!instance) return undefined;
  let file: string | undefined;
  const chain: string[] = [];
  let guard = 0;
  while (instance && guard < 200) {
    guard += 1;
    const type = (instance.type ?? instance.$options) as VueComponentType | undefined;
    if (!file && type && typeof type.__file === 'string') file = normalizeFile(type.__file);
    const name = type?.name ?? type?.__name;
    if (name && chain[chain.length - 1] !== name && chain.length < MAX_CHAIN) chain.push(name);
    instance = instance.parent ?? instance.$parent;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'vue',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveSvelte(el: Element): ElementSource | undefined {
  let node: Element | null = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const meta = (node as unknown as { __svelte_meta?: { loc?: SvelteLoc } }).__svelte_meta;
    if (meta?.loc && typeof meta.loc.file === 'string') {
      return {
        framework: 'svelte',
        file: normalizeFile(meta.loc.file),
        line: numberOr(meta.loc.line),
        column: numberOr(meta.loc.column),
        confidence: 'exact',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function resolveAttributes(el: Element): ElementSource | undefined {
  let node: Element | null = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const path =
      node.getAttribute('data-inspector-relative-path') ??
      node.getAttribute('data-source-file') ??
      node.getAttribute('data-sourcefile') ??
      node.getAttribute('data-source');
    if (path) {
      return {
        component: node.getAttribute('data-component') ?? node.getAttribute('data-testid') ?? undefined,
        file: normalizeFile(path),
        line: numberOr(node.getAttribute('data-inspector-line') ?? node.getAttribute('data-source-line')),
        column: numberOr(node.getAttribute('data-inspector-column') ?? node.getAttribute('data-source-column')),
        confidence: 'attribute',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function componentName(type: unknown): string | undefined {
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string };
    const name = fn.displayName || fn.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  if (type && typeof type === 'object') {
    const obj = type as { displayName?: string; name?: string };
    const name = obj.displayName || obj.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  return undefined;
}

export function normalizeFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  let normalized = file.replace(/[?#].*$/, '');
  const fsIndex = normalized.indexOf('/@fs/');
  if (fsIndex >= 0) normalized = normalized.slice(fsIndex + 4);
  normalized = normalized.replace(/^https?:\/\/[^/]+/, '');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  return normalized.replace(/^\//, '');
}

function numberOr(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(num) ? num : undefined;
}

interface ReactFiber {
  type?: unknown;
  return?: ReactFiber | null;
  _debugOwner?: ReactFiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
}

interface VueComponentType {
  __file?: string;
  name?: string;
  __name?: string;
}

interface VueInstance {
  type?: VueComponentType;
  $options?: VueComponentType;
  parent?: VueInstance;
  $parent?: VueInstance;
}

interface SvelteLoc {
  file?: string;
  line?: number;
  column?: number;
}
