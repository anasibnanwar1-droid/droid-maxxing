import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderSearch,
  Loader2,
  X,
} from 'lucide-react';
import {
  openFileDefault,
  readFilePreview,
  revealFile,
  type FilePreviewPayload,
} from '../../lib/desktop';
import { Markdown } from '../Markdown';
import { toast } from '../../lib/toast';

const TEXT_CHAR_LIMIT = 250_000;
const TABLE_ROW_LIMIT = 500;
const TABLE_COL_LIMIT = 50;
const PDF_RENDER_SCALE = 1.4;

interface FilePreviewPaneProps {
  root: string;
  relative: string;
  onClear?: () => void;
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: FilePreviewPayload };

function normalizeBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && typeof data === 'object') {
    const obj = data as { data?: unknown };
    if (Array.isArray(obj.data)) return new Uint8Array(obj.data as number[]);
  }
  return new Uint8Array(0);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const TABULAR_EXTENSIONS = new Set(['csv', 'tsv']);

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter && row.length < TABLE_COL_LIMIT - 1) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= TABLE_ROW_LIMIT) break;
    } else if (ch === '\r') {
      continue;
    } else {
      field += ch;
    }
  }
  if (rows.length < TABLE_ROW_LIMIT && (field || row.length)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
    >
      {children}
    </button>
  );
}

export function FilePreviewPane({ root, relative, onClear }: FilePreviewPaneProps) {
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });

  useEffect(() => {
    if (!relative) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    readFilePreview(root, relative)
      .then((payload) => {
        if (!cancelled) setState({ kind: 'ready', payload });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root, relative]);

  const handleOpenExternal = useCallback(() => {
    if (!relative) return;
    void openFileDefault(root, relative).catch((reason: unknown) =>
      toast.error(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [root, relative]);

  const handleReveal = useCallback(() => {
    if (!relative) return;
    void revealFile(root, relative).catch((reason: unknown) =>
      toast.error(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [root, relative]);

  const fileName = useMemo(() => relative.split(/[\\/]/).pop() ?? relative, [relative]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-droid-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-droid-border px-3">
        <FileText className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
        <span
          className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-secondary"
          title={relative}
        >
          {relative || 'Preview'}
        </span>
        {relative && (
          <div className="flex shrink-0 items-center gap-0.5">
            <ToolbarButton title="Open externally" onClick={handleOpenExternal}>
              <ExternalLink className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton title="Reveal in Finder / Explorer" onClick={handleReveal}>
              <FolderSearch className="h-3.5 w-3.5" />
            </ToolbarButton>
            {onClear && (
              <ToolbarButton title="Clear selection" onClick={onClear}>
                <X className="h-3.5 w-3.5" />
              </ToolbarButton>
            )}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {state.kind === 'idle' && (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-droid-text-muted">
            Select a file to preview.
          </div>
        )}
        {state.kind === 'loading' && (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-droid-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading preview…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            <p className="max-w-sm text-[12px] leading-relaxed text-droid-text-secondary">
              {state.message}
            </p>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="mt-1 flex items-center gap-1.5 rounded-md border border-droid-border px-2.5 py-1 text-[11px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
            >
              <ExternalLink className="h-3 w-3" />
              Open externally
            </button>
          </div>
        )}
        {state.kind === 'ready' && (
          <PreviewBody
            payload={state.payload}
            fileName={fileName}
            onOpenExternal={handleOpenExternal}
            onReveal={handleReveal}
          />
        )}
      </div>
    </section>
  );
}

function PreviewBody({
  payload,
  fileName,
  onOpenExternal,
  onReveal,
}: {
  payload: FilePreviewPayload;
  fileName: string;
  onOpenExternal: () => void;
  onReveal: () => void;
}) {
  if (payload.oversize || !payload.previewable) {
    return <FallbackNotice payload={payload} onOpenExternal={onOpenExternal} onReveal={onReveal} />;
  }

  switch (payload.category) {
    case 'text':
      return <TextPreview text={payload.text ?? ''} fileName={fileName} />;
    case 'image':
      return <ImagePreview data={payload.data} fileName={fileName} />;
    case 'pdf':
      return <PdfPreview data={payload.data} />;
    case 'docx':
      return <DocxPreview data={payload.data} />;
    case 'xlsx':
      return <XlsxPreview data={payload.data} />;
    default:
      return (
        <FallbackNotice payload={payload} onOpenExternal={onOpenExternal} onReveal={onReveal} />
      );
  }
}

function FallbackNotice({
  payload,
  onOpenExternal,
  onReveal,
}: {
  payload: FilePreviewPayload;
  onOpenExternal: () => void;
  onReveal: () => void;
}) {
  const oversize = payload.oversize;
  const reason = payload.reason ?? (oversize ? 'File exceeds the inline preview size cap.' : null);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle
        className={`h-6 w-6 ${oversize ? 'text-amber-400' : 'text-droid-text-muted'}`}
      />
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-droid-text">
          {oversize ? 'File too large to preview inline' : 'No inline preview available'}
        </p>
        {reason && (
          <p className="max-w-sm text-[11.5px] leading-relaxed text-droid-text-muted">{reason}</p>
        )}
        {payload.totalSize > 0 && (
          <p className="font-mono text-[10.5px] text-droid-text-muted">
            {formatBytes(payload.totalSize)} · cap {formatBytes(payload.sizeCapBytes)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenExternal}
          className="flex items-center gap-1.5 rounded-md border border-droid-border bg-droid-elevated px-3 py-1.5 text-[11.5px] text-droid-text transition-colors hover:border-droid-border-hover"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open externally
        </button>
        <button
          type="button"
          onClick={onReveal}
          className="flex items-center gap-1.5 rounded-md border border-droid-border px-3 py-1.5 text-[11.5px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
        >
          <FolderSearch className="h-3.5 w-3.5" />
          Reveal
        </button>
      </div>
    </div>
  );
}

function TextPreview({ text, fileName }: { text: string; fileName: string }) {
  const ext = extensionOf(fileName);
  const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
  const isTabular = TABULAR_EXTENSIONS.has(ext);

  const truncated = text.length > TEXT_CHAR_LIMIT;
  const visibleText = truncated ? text.slice(0, TEXT_CHAR_LIMIT) : text;

  if (isTabular) {
    return (
      <CsvPreview
        text={visibleText}
        delimiter={ext === 'tsv' ? '\t' : ','}
        truncated={truncated}
        originalLength={text.length}
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      {truncated && (
        <div className="sticky top-0 z-10 border-b border-droid-border bg-droid-surface/80 px-3 py-1.5 text-[10.5px] text-amber-300 backdrop-blur">
          Showing first {formatBytes(visibleText.length)} of {formatBytes(text.length)} (truncated
          for performance).
        </div>
      )}
      {isMarkdown ? (
        <div className="px-4 py-3">
          <Markdown>{visibleText}</Markdown>
        </div>
      ) : (
        <pre className="px-4 py-3 font-mono text-[11.5px] leading-[1.6] text-droid-text-secondary [overflow-wrap:anywhere]">
          <code className="whitespace-pre">{visibleText}</code>
        </pre>
      )}
    </div>
  );
}

function CsvPreview({
  text,
  delimiter,
  truncated,
  originalLength,
}: {
  text: string;
  delimiter: string;
  truncated: boolean;
  originalLength: number;
}) {
  const rows = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {truncated && (
        <div className="shrink-0 border-b border-droid-border bg-droid-surface/80 px-3 py-1.5 text-[10.5px] text-amber-300">
          Showing first {formatBytes(text.length)} of {formatBytes(originalLength)} (truncated for
          performance).
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={rIdx} className={rIdx === 0 ? 'bg-droid-elevated/40 font-medium' : ''}>
                {row.map((cell, cIdx) => (
                  <td
                    key={cIdx}
                    className="border-t border-droid-border px-2 py-1 text-droid-text-secondary [overflow-wrap:anywhere]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(rows.length >= TABLE_ROW_LIMIT ||
        (rows[rows.length - 1]?.length ?? 0) >= TABLE_COL_LIMIT) && (
        <div className="shrink-0 border-t border-droid-border bg-droid-surface/60 px-3 py-1 text-[10px] text-droid-text-muted">
          Limited to {TABLE_ROW_LIMIT} rows × {TABLE_COL_LIMIT} columns.
        </div>
      )}
    </div>
  );
}

function ImagePreview({ data, fileName }: { data?: Uint8Array; fileName: string }) {
  const bytes = useMemo(() => normalizeBytes(data), [data]);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!bytes.length) return;
    const blobUrl = URL.createObjectURL(
      new Blob([bytes as unknown as BlobPart], { type: imageMimeType(fileName) }),
    );
    setUrl(blobUrl);
    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [bytes, fileName]);
  if (!url) return null;
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img src={url} alt="Preview" className="max-h-full max-w-full object-contain" />
    </div>
  );
}

function imageMimeType(fileName: string): string {
  switch (extensionOf(fileName)) {
    case 'svg':
      return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'ico':
      return 'image/x-icon';
    default:
      return 'image/png';
  }
}

async function loadPdfjsImpl() {
  const pdfjsLib = await import('pdfjs-dist');
  // Vite resolves the worker bundle inline; the ?worker&inline suffix is
  // not in the project's TS ambient declarations, so suppress the error.
  // @ts-expect-error -- Vite virtual module handled at build time
  const workerModule = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline')) as {
    default: new () => Worker;
  };
  pdfjsLib.GlobalWorkerOptions.workerPort = new workerModule.default();
  return pdfjsLib;
}

let pdfjsModulePromise: ReturnType<typeof loadPdfjsImpl> | null = null;
function loadPdfjs(): ReturnType<typeof loadPdfjsImpl> {
  pdfjsModulePromise ??= loadPdfjsImpl();
  return pdfjsModulePromise;
}

function PdfPreview({ data }: { data?: Uint8Array }) {
  const bytes = useMemo(() => normalizeBytes(data), [data]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    setPage(1);
    setNumPages(0);
    setError('');
    setRendering(true);
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    loadPdfjs()
      .then(async (pdfjsLib) => {
        loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        documentRef.current = doc;
        setNumPages(doc.numPages);
        setRendering(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      documentRef.current = null;
      void loadingTask?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || !numPages || !canvasRef.current) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    let renderTask: RenderTask | null = null;
    setRendering(true);
    Promise.resolve()
      .then(async () => {
        const pdfPage = await doc.getPage(page);
        if (isCancelled()) return;
        const viewport = pdfPage.getViewport({ scale: PDF_RENDER_SCALE });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = pdfPage.render({ canvas, canvasContext: ctx, viewport });
        await renderTask.promise;
        if (!isCancelled()) setRendering(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [page, numPages]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400" />
        <p className="text-[12px] text-droid-text-secondary">Failed to render PDF.</p>
        <p className="max-w-sm text-[10.5px] text-droid-text-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center overflow-auto bg-droid-surface/20 p-4">
      <canvas
        ref={canvasRef}
        className="max-h-full rounded-md shadow-lg"
        style={{ maxHeight: 'calc(100% - 32px)' }}
      />
      {numPages > 1 && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-droid-border bg-droid-elevated px-2 py-1">
          <button
            type="button"
            disabled={page <= 1 || rendering}
            onClick={() => {
              setPage((p) => Math.max(1, p - 1));
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-droid-text-muted transition-colors enabled:hover:text-droid-text disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="font-mono text-[10.5px] text-droid-text-secondary">
            {page} / {numPages}
          </span>
          <button
            type="button"
            disabled={page >= numPages || rendering}
            onClick={() => {
              setPage((p) => Math.min(numPages, p + 1));
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-droid-text-muted transition-colors enabled:hover:text-droid-text disabled:opacity-30"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function DocxPreview({ data }: { data?: Uint8Array }) {
  const bytes = useMemo(() => normalizeBytes(data), [data]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!containerRef.current || !bytes.length) return;
    let cancelled = false;
    const container = containerRef.current;
    container.innerHTML = '';
    setLoading(true);
    setError('');
    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(new Blob([bytes as unknown as BlobPart]), container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          experimental: false,
          className: 'docx-preview',
        }),
      )
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [bytes]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400" />
        <p className="text-[12px] text-droid-text-secondary">Failed to render document.</p>
        <p className="max-w-sm text-[10.5px] text-droid-text-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-auto bg-droid-surface/20 p-4">
      {loading && (
        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-droid-border bg-droid-elevated px-2 py-1 text-[10px] text-droid-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Rendering…
        </div>
      )}
      <div
        ref={containerRef}
        className="mx-auto max-w-[800px] rounded-md bg-white p-6 text-black shadow-lg"
      />
    </div>
  );
}

type XlsxRow = string[];
interface XlsxSheet {
  sheet: string;
  data: XlsxRow[];
}

function XlsxPreview({ data }: { data?: Uint8Array }) {
  const bytes = useMemo(() => normalizeBytes(data), [data]);
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!bytes.length) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    import('read-excel-file/browser')
      .then(({ default: readXlsx }) => readXlsx(new Blob([bytes as unknown as BlobPart])))
      .then((allSheets) => {
        if (cancelled) return;
        const trimmed: XlsxSheet[] = allSheets.map((sheet) => {
          const rows: XlsxRow[] = sheet.data.slice(0, TABLE_ROW_LIMIT).map((row) =>
            row.slice(0, TABLE_COL_LIMIT).map((cell): string => {
              if (cell === null) return '';
              if (cell instanceof Date) return cell.toISOString();
              if (typeof cell === 'boolean' || typeof cell === 'number') {
                return String(cell);
              }
              return String(cell);
            }),
          );
          return { sheet: sheet.sheet || 'Sheet', data: rows };
        });
        setSheets(trimmed);
        setActiveSheet(0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-droid-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Parsing spreadsheet…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400" />
        <p className="text-[12px] text-droid-text-secondary">Failed to parse spreadsheet.</p>
        <p className="max-w-sm text-[10.5px] text-droid-text-muted">{error}</p>
      </div>
    );
  }

  if (!sheets.length) return null;
  const sheet = sheets[activeSheet];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-droid-border bg-droid-surface/40 px-2 py-1.5">
          {sheets.map((s, idx) => (
            <button
              key={s.sheet}
              type="button"
              onClick={() => {
                setActiveSheet(idx);
              }}
              className={`shrink-0 rounded px-2 py-0.5 text-[10.5px] transition-colors ${
                idx === activeSheet
                  ? 'bg-droid-accent/15 text-droid-text'
                  : 'text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
              }`}
            >
              {s.sheet}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {sheet.data.map((row, rIdx) => (
              <tr key={rIdx} className={rIdx === 0 ? 'bg-droid-elevated/40 font-medium' : ''}>
                {row.map((cell, cIdx) => (
                  <td
                    key={cIdx}
                    className="border-t border-droid-border px-2 py-1 text-droid-text-secondary [overflow-wrap:anywhere]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-droid-border bg-droid-surface/60 px-3 py-1 text-[10px] text-droid-text-muted">
        Limited to {TABLE_ROW_LIMIT} rows × {TABLE_COL_LIMIT} columns per sheet.
      </div>
    </div>
  );
}
