import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo, useEffect, useRef, useState, memo } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Mermaid } from 'mermaid';

let mermaidPromise: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'dark',
        themeVariables: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '13px',
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let mermaidSeq = 0;

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ── JSON syntax highlighting ── */
function isJsonLang(className?: string) {
  return className?.includes('language-json') || className?.includes('lang-json');
}

function isSvgLang(className?: string) {
  return className?.includes('language-svg') || className?.includes('lang-svg');
}

function isMermaidLang(className?: string) {
  return className?.includes('language-mermaid') || className?.includes('lang-mermaid');
}

// Models frequently emit flowchart syntax mermaid rejects (unquoted special
// characters in subgraph titles, and `[/text]` which mermaid reads as a
// parallelogram shape). Quote these so common flowcharts render instead of
// falling back to a raw code block.
function sanitizeMermaid(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const sg = line.match(/^(\s*subgraph\s+)(.+?)\s*$/i);
      if (sg) {
        const title = sg[2].trim();
        const alreadySafe = title.startsWith('"') || /^[\w-]+(\[.*\]|\(.*\))?$/.test(title);
        if (!alreadySafe && /[/()\-:&.,]/.test(title)) {
          return `${sg[1]}"${title.replace(/"/g, '')}"`;
        }
        return line;
      }
      // [/register] -> ["/register"] (but keep real parallelograms [/text/]).
      return line.replace(/\[\/([^/\]\n]+)\]/g, '["/$1"]');
    })
    .join('\n');
}

/* ── Mermaid diagram renderer ── */
const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const idRef = useRef(`mmd-${++mermaidSeq}`);

  useEffect(() => {
    let cancelled = false;
    const raw = code.trim();
    loadMermaid()
      .then(async (mermaid) => {
        try {
          return await mermaid.render(idRef.current, raw);
        } catch {
          // Retry once with a sanitized version of common bad flowchart syntax.
          return mermaid.render(`${idRef.current}-s`, sanitizeMermaid(raw));
        }
      })
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="rounded-2xl border border-droid-border bg-droid-elevated/20 overflow-hidden my-5">
        <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
          <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
            Diagram source
          </span>
          <span className="text-[10px] font-mono text-droid-text-muted/40">Mermaid</span>
        </div>
        <pre className="overflow-x-auto p-4">
          <code className="font-mono text-[12px] text-droid-text-secondary whitespace-pre">
            {code}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-droid-border bg-droid-elevated/20 overflow-hidden my-5">
      <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
        <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
          Diagram
        </span>
        <span className="text-[10px] font-mono text-droid-text-muted/40">Mermaid</span>
      </div>
      <div
        className="p-4 flex items-center justify-center [&_svg]:max-w-full [&_svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
});

function HighlightJson({ code }: { code: string }) {
  const nodes = useMemo(() => {
    const tokens = code.split(
      /("(?:\\.|[^"\\])*"|:|true|false|null|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\[\]{}!,])/g,
    );
    return tokens.map((token, i) => {
      if (token.match(/^"(?:\\.|[^"\\])*"$/)) {
        const next = tokens[i + 1]?.trimStart();
        if (next?.startsWith(':')) {
          return (
            <span key={i} style={{ color: 'var(--droid-accent)' }}>
              {token}
            </span>
          );
        }
        return (
          <span key={i} style={{ color: 'var(--droid-green)' }}>
            {token}
          </span>
        );
      }
      if (token === 'true' || token === 'false')
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (token === 'null')
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      if (token.match(/^\d/))
        return (
          <span key={i} style={{ color: 'var(--droid-orange)' }}>
            {token}
          </span>
        );
      if (/^[{}\[\],:!]$/.test(token))
        return (
          <span key={i} style={{ color: 'var(--droid-text-muted)' }}>
            {token}
          </span>
        );
      return <span key={i}>{token}</span>;
    });
  }, [code]);

  return <>{nodes}</>;
}

/* ── SVG code block renderer ── */
function SvgCodeBlock({ content }: { content: string }) {
  const safeSvg = useMemo(() => {
    let raw = content.trim();
    if (!raw.startsWith('<svg')) {
      raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="100%">${raw}</svg>`;
    }
    raw = raw.replace(/width="\d+(?:px)?"/gi, 'width="100%"');
    raw = raw.replace(/height="\d+(?:px)?"/gi, '');
    if (!raw.includes('xmlns=')) {
      raw = raw.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return raw;
  }, [content]);

  return (
    <div className="rounded-2xl border border-droid-border bg-droid-elevated/30 overflow-hidden my-4">
      <div className="flex items-center justify-between px-3.5 h-7 bg-droid-surface/30 border-b border-droid-border">
        <span className="text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60">
          Diagram
        </span>
        <span className="text-[10px] font-mono text-droid-text-muted/40">SVG</span>
      </div>
      <div className="p-4 flex items-center justify-center min-h-[100px]">
        <div
          className="w-full flex items-center justify-center [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:block"
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
      </div>
    </div>
  );
}

const LANG_LABEL: Record<string, string> = {
  sh: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  zsh: 'Bash',
  console: 'Bash',
  shellsession: 'Bash',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  yml: 'YAML',
  yaml: 'YAML',
  md: 'Markdown',
};

function langLabel(className?: string): string {
  const m = className?.match(/lang(?:uage)?-([\w+#.-]+)/i);
  if (!m) return 'Code';
  const l = m[1].toLowerCase();
  return LANG_LABEL[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
}

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex items-center gap-1 text-[10.5px] text-droid-text-muted hover:text-droid-text transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// Fenced code block in a clean, theme-adaptive card: a grey header with the
// language label and a copy action, then the code (syntax-highlighted for JSON).
function CodeCard({
  code,
  className,
  specMode,
  highlighted,
}: {
  code: string;
  className?: string;
  specMode?: boolean;
  highlighted?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-droid-border overflow-hidden bg-droid-elevated/40 ${specMode ? 'my-4' : 'my-2.5'}`}
    >
      <div className="flex items-center justify-between h-7 px-3 bg-droid-surface/60 border-b border-droid-border">
        <span className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
          {langLabel(className)}
        </span>
        <CodeCopyButton text={code} />
      </div>
      <pre className={`overflow-x-auto ${specMode ? 'p-4' : 'p-3.5'}`}>
        <code
          className={`font-mono leading-[1.65] text-droid-text-secondary whitespace-pre ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
        >
          {highlighted ?? code}
        </code>
      </pre>
    </div>
  );
}

function MarkdownImpl({ children, specMode }: { children: string; specMode?: boolean }) {
  return (
    <div
      className={`text-droid-text break-words ${specMode ? 'text-[15px] leading-[1.8] space-y-5' : 'text-[13.5px] leading-[1.7] space-y-3'}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => {
            const text = String(children ?? '');
            const id = slugify(text);
            return specMode ? (
              <h1
                id={id}
                className="text-[24px] font-semibold tracking-tight text-droid-text mt-10 first:mt-0 mb-4 scroll-mt-8"
              >
                {children}
              </h1>
            ) : (
              <h1 className="text-[17px] font-semibold text-droid-text mt-4 first:mt-0 mb-1">
                {children}
              </h1>
            );
          },
          h2: ({ children }) => {
            const text = String(children ?? '');
            const id = slugify(text);
            return specMode ? (
              <h2
                id={id}
                className="text-[18px] font-semibold text-droid-text mt-7 first:mt-0 mb-2.5 scroll-mt-8"
              >
                {children}
              </h2>
            ) : (
              <h2 className="text-[15px] font-semibold text-droid-text mt-4 first:mt-0 mb-1">
                {children}
              </h2>
            );
          },
          h3: ({ children }) => {
            const text = String(children ?? '');
            const id = slugify(text);
            return specMode ? (
              <h3
                id={id}
                className="text-[15px] font-semibold text-droid-text-secondary mt-5 first:mt-0 mb-2 scroll-mt-8"
              >
                {children}
              </h3>
            ) : (
              <h3 className="text-[14px] font-semibold text-droid-text mt-3 first:mt-0 mb-1">
                {children}
              </h3>
            );
          },
          p: ({ children }) => (
            <p className={specMode ? 'leading-[1.8]' : 'leading-[1.7]'}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul
              className={`marker:text-droid-text-muted ${specMode ? 'list-disc pl-6 space-y-2' : 'list-disc pl-5 space-y-1.5'}`}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={`marker:text-droid-text-muted ${specMode ? 'list-decimal pl-6 space-y-2' : 'list-decimal pl-5 space-y-1.5'}`}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className={`${specMode ? 'leading-[1.75] pl-1' : 'leading-[1.65] pl-0.5'}`}>
              {children}
            </li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-droid-text">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:opacity-80 transition-opacity"
              style={{ color: 'var(--droid-accent)' }}
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className={`italic text-droid-text-secondary ${specMode ? 'border-l border-droid-border pl-4 py-0.5 my-4' : 'border-l-2 border-droid-border-hover pl-3.5'}`}
            >
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr className={`border-0 h-px bg-droid-border/25 ${specMode ? 'my-8' : 'my-4'}`} />
          ),
          code: ({ className, children }) => {
            const inline = !className;
            if (inline)
              return (
                <code
                  className={`font-mono px-1.5 py-0.5 rounded-md bg-droid-elevated/70 text-droid-text break-words ${specMode ? 'text-[13px]' : 'text-[12px]'}`}
                >
                  {children}
                </code>
              );

            const codeText = String(children ?? '');

            if (isMermaidLang(className)) {
              return <MermaidBlock code={codeText} />;
            }

            if (isSvgLang(className)) {
              return <SvgCodeBlock content={codeText} />;
            }

            return (
              <CodeCard
                code={codeText}
                className={className}
                specMode={specMode}
                highlighted={isJsonLang(className) ? <HighlightJson code={codeText} /> : undefined}
              />
            );
          },
          table: ({ children }) => (
            <div
              className={`overflow-x-auto rounded-xl border border-droid-border ${specMode ? 'my-6' : 'my-2.5'}`}
            >
              <table
                className={`w-full border-collapse ${specMode ? 'text-[13.5px]' : 'text-[12.5px]'}`}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-droid-elevated/25">{children}</thead>,
          th: ({ children }) => (
            <th
              className={`border-b border-droid-border text-left align-top font-medium whitespace-nowrap text-droid-text ${specMode ? 'px-3.5 py-2.5' : 'px-2.5 py-1.5'}`}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className={`border-t border-droid-border align-top text-droid-text-secondary first:whitespace-nowrap first:pr-4 first:font-medium first:text-droid-text ${specMode ? 'px-3.5 py-2.5' : 'px-2.5 py-1.5'}`}
            >
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
