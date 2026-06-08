import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Markdown } from './Markdown';
import { LayoutTemplate } from 'lucide-react';

type Segment =
  | { type: 'text'; content: string }
  | { type: 'svg'; content: string; source: 'code' | 'inline' };

const EASE = [0.16, 1, 0.3, 1] as const;

function parseSpecSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const matches: Array<{ start: number; end: number; content: string; kind: 'svg' | 'mermaid' | 'inline' }> = [];

  // Pattern 1: fenced code blocks ```svg or ```mermaid
  const codeRegex = /```(?:svg|mermaid)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = codeRegex.exec(markdown)) !== null) {
    const isMermaid = markdown.slice(m.index, m.index + 12).includes('mermaid');
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      content: m[1].trim(),
      kind: isMermaid ? 'mermaid' : 'svg',
    });
  }

  // Pattern 2: inline <svg>...</svg> (skip overlaps with code blocks)
  const inlineRegex = /(<svg\b[\s\S]*?<\/svg>)/g;
  while ((m = inlineRegex.exec(markdown)) !== null) {
    const overlaps = matches.some((cb) => m!.index < cb.end && m!.index + m![0].length > cb.start);
    if (!overlaps) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        content: m[0],
        kind: 'inline',
      });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  let last = 0;
  for (const match of matches) {
    if (match.start > last) {
      segments.push({ type: 'text', content: markdown.slice(last, match.start) });
    }
    if (match.kind === 'mermaid') {
      // Render mermaid as a styled code block until mermaid.js is added
      segments.push({ type: 'text', content: '```mermaid\n' + match.content + '\n```' });
    } else {
      segments.push({ type: 'svg', content: match.content, source: match.kind === 'inline' ? 'inline' : 'code' });
    }
    last = match.end;
  }
  if (last < markdown.length) {
    segments.push({ type: 'text', content: markdown.slice(last) });
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', content: markdown });
  }
  return segments;
}

function SvgVisualCard({ svgContent, index }: { svgContent: string; index: number }) {
  const safeSvg = useMemo(() => {
    let raw = svgContent.trim();

    // If the extracted content from a code block is just inner SVG markup,
    // wrap it in a proper <svg> root so it renders.
    if (!raw.startsWith('<svg')) {
      raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="100%">${raw}</svg>`;
    }

    // Strip any fixed pixel widths so the SVG scales to its container.
    raw = raw.replace(/width="\d+(?:px)?"/gi, 'width="100%"');
    raw = raw.replace(/height="\d+(?:px)?"/gi, '');

    // Ensure xmlns is present.
    if (!raw.includes('xmlns=')) {
      raw = raw.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    return raw;
  }, [svgContent]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: EASE, delay: Math.min(index * 0.06, 0.3) }}
      className="group relative rounded-2xl border border-droid-border bg-droid-elevated/30 overflow-hidden hover:border-droid-accent/20 transition-colors duration-300"
    >
      {/* Subtle top bar */}
      <div className="absolute top-0 inset-x-0 h-7 flex items-center justify-between px-3.5 bg-droid-surface/30 border-b border-droid-border">
        <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
          <LayoutTemplate className="w-3 h-3" />
          Diagram
        </span>
        <span className="text-[10px] font-mono text-droid-text-muted/40">SVG</span>
      </div>

      {/* Rendered SVG */}
      <div className="pt-9 pb-5 px-5 flex items-center justify-center min-h-[100px]">
        <div
          className="w-full flex items-center justify-center [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:block"
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
      </div>
    </motion.div>
  );
}

export function SpecRenderer({ content }: { content: string }) {
  const segments = useMemo(() => parseSpecSegments(content), [content]);

  return (
    <div className="space-y-5">
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <div key={i} className="spec-text">
            <Markdown specMode>{seg.content}</Markdown>
          </div>
        ) : (
          <SvgVisualCard key={i} svgContent={seg.content} index={i} />
        )
      )}
    </div>
  );
}
