import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { Copy, RotateCcw, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import {
  onTerminalEvent,
  resizeTerminal,
  subscribeTerminal,
  unsubscribeTerminal,
  writeTerminal,
} from '../../lib/desktop';
import { ensureTerminalForTab } from '../../lib/terminal';

export function TerminalWorkspace({
  tabId,
  terminalId,
  missionId,
  cwd,
  onCreated,
}: {
  tabId: string;
  terminalId?: string;
  missionId: string;
  cwd: string;
  onCreated: (terminalId: string, label: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef(terminalId);
  const onCreatedRef = useRef(onCreated);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const disposedRef = useRef(false);
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>(
    terminalId ? 'running' : 'starting',
  );
  const [error, setError] = useState('');

  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    disposedRef.current = false;
    const isDisposed = () => disposedRef.current;
    let resizeFrame = 0;
    let unlisten: () => void = () => {
      /* no-op */
    };
    let observer: ResizeObserver | null = null;

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(async ([xterm, fit]) => {
        if (isDisposed() || !hostRef.current) return;
        const instance = new xterm.Terminal({
          cursorBlink: true,
          cursorStyle: 'bar',
          fontFamily:
            '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 5_000,
          smoothScrollDuration: 90,
          allowProposedApi: false,
          theme: {
            background: '#070707',
            foreground: '#e7e7e7',
            cursor: '#ee6018',
            cursorAccent: '#070707',
            selectionBackground: '#ee601833',
            black: '#171717',
            brightBlack: '#777777',
          },
        });
        const fitAddon = new fit.FitAddon();
        instance.loadAddon(fitAddon);
        instance.open(hostRef.current);
        terminalRef.current = instance;
        fitRef.current = fitAddon;

        const applyFit = () => {
          resizeFrame = 0;
          if (isDisposed() || !hostRef.current || hostRef.current.clientWidth < 8) return;
          fitAddon.fit();
          const next = { cols: instance.cols, rows: instance.rows };
          if (
            terminalIdRef.current &&
            (next.cols !== lastSizeRef.current.cols || next.rows !== lastSizeRef.current.rows)
          ) {
            lastSizeRef.current = next;
            void resizeTerminal(terminalIdRef.current, next.cols, next.rows);
          }
        };
        const scheduleFit = () => {
          if (!resizeFrame) resizeFrame = requestAnimationFrame(applyFit);
        };
        observer = new ResizeObserver(scheduleFit);
        observer.observe(hostRef.current);
        applyFit();

        const info = await ensureTerminalForTab(tabId, terminalIdRef.current, {
          missionId,
          cwd,
          cols: instance.cols,
          rows: instance.rows,
        });
        if (isDisposed()) return;
        terminalIdRef.current = info.id;
        setStatus('running');
        const shellName = info.shell.split(/[\\/]/).pop() ?? 'Terminal';
        onCreatedRef.current(info.id, shellName);

        unlisten = onTerminalEvent((event) => {
          if (event.terminalId !== info.id) return;
          if (event.kind === 'data' || event.kind === 'replay') {
            instance.write(event.data);
            return;
          }
          setStatus(event.exitCode === 0 ? 'exited' : 'error');
          if (event.exitCode !== 0) {
            setError(`Shell exited with code ${String(event.exitCode ?? 'unknown')}.`);
          }
        });
        await subscribeTerminal(info.id);
        instance.onData((data) => void writeTerminal(info.id, data));
        instance.focus();
      })
      .catch((reason: unknown) => {
        if (isDisposed()) return;
        setStatus('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      disposedRef.current = true;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      unlisten();
      if (terminalIdRef.current) void unsubscribeTerminal(terminalIdRef.current);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [cwd, missionId, tabId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#070707]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-droid-border bg-droid-bg px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-droid-text-muted">
          {cwd}
        </span>
        <TerminalButton
          title="Copy selection"
          onClick={() => {
            const selection = terminalRef.current?.getSelection();
            if (selection) void navigator.clipboard.writeText(selection);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton title="Clear terminal" onClick={() => terminalRef.current?.clear()}>
          <Trash2 className="h-3.5 w-3.5" />
        </TerminalButton>
        <TerminalButton title="Reset terminal display" onClick={() => terminalRef.current?.reset()}>
          <RotateCcw className="h-3.5 w-3.5" />
        </TerminalButton>
      </div>
      {status !== 'running' && (
        <div
          className={`shrink-0 border-b border-droid-border px-3 py-2 text-[11.5px] ${
            status === 'error'
              ? 'bg-red-500/10 text-red-200'
              : 'bg-droid-surface text-droid-text-muted'
          }`}
        >
          {status === 'starting'
            ? `Starting shell in ${cwd}…`
            : error || 'Terminal process exited.'}
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}

function TerminalButton({
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
