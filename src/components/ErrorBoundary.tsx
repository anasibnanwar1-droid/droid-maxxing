import { Component, type ErrorInfo, type ReactNode } from 'react';
import { hideAllNativeBrowsers } from '../lib/nativeBrowser';
import { readShellDiagnostics } from '../lib/diagnostics';

interface Props {
  children: ReactNode;
  // 'app' renders a full recovery screen; 'pane' renders a compact inline
  // fallback that isolates a sub-tree (e.g. the browser pane) without taking
  // down the whole shell.
  scope?: 'app' | 'pane';
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The native browser is a separate OS layer that would otherwise stay
    // painted over this fallback, so detach it before anything else.
    void hideAllNativeBrowsers();
    console.error('[shell] render error', {
      scope: this.props.scope ?? 'app',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
      diagnostics: readShellDiagnostics(),
    });
  }

  private recover = () => this.setState({ error: null });
  private reload = () => window.location.reload();

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.scope === 'pane') {
      return <PaneFallback label={this.props.label} error={error} onRetry={this.recover} />;
    }
    return <AppFallback error={error} onRecover={this.recover} onReload={this.reload} />;
  }
}

export function AppFallback({
  error,
  onRecover,
  onReload,
}: {
  error: Error;
  onRecover: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-droid-bg px-8 text-center text-droid-text">
      <div className="max-w-md">
        <h1 className="text-[15px] font-semibold">Something went wrong</h1>
        <p className="mt-2 text-[13px] text-droid-text-muted">
          The app ran into an unexpected error. Your sessions are safe, you can recover the view or
          reload the app.
        </p>
        <pre className="mt-4 max-h-32 overflow-auto rounded-lg border border-droid-border bg-droid-elevated/60 px-3 py-2 text-left font-mono text-[11px] text-droid-text-secondary">
          {error.message}
        </pre>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRecover}
          className="rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
        >
          Try to recover
        </button>
        <button
          onClick={onReload}
          className="rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:opacity-90"
        >
          Reload app
        </button>
      </div>
    </div>
  );
}

export function PaneFallback({
  label,
  error,
  onRetry,
}: {
  label?: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-droid-bg px-6 text-center text-droid-text">
      <div className="max-w-xs">
        <h2 className="text-[13px] font-medium">{label ?? 'This panel'} hit an error</h2>
        <p className="mt-1.5 text-[12px] text-droid-text-muted">{error.message}</p>
      </div>
      <button
        onClick={onRetry}
        className="rounded-lg border border-droid-border px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Retry
      </button>
    </div>
  );
}
