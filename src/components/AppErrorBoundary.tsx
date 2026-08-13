/**
 * @file AppErrorBoundary.tsx
 * @description Stage 9 (9.2) — the single root error boundary. Before this,
 * any render-time throw or a failed lazy chunk (the classic stale tab
 * requesting an old hashed bundle after a redeploy) produced a blank white
 * screen. This boundary turns both into a controlled, branded message with a
 * one-click recovery path (reload), and nothing else:
 *
 *   • purely additive on the FAILURE path — it renders `children` untouched
 *     until React reports an error below it;
 *   • no auto-reload (a broken chunk must not become a reload loop) — recovery
 *     is a user-initiated button;
 *   • logging is error-object-only (message/stack), consistent with the 9.7
 *     logging-hygiene rule: no tokens, no personal data, no raw responses.
 *
 * Inline styles are deliberate: the fallback must survive a build where the
 * stylesheet itself failed to load.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
  /** True when the failure looks like a stale/missing lazy chunk after a redeploy. */
  staleChunk: boolean;
  issueId: string;
  copyState: 'idle' | 'copied' | 'failed';
}

const BUILD_RELEASE_IDENTITY = String(import.meta.env.VITE_RELEASE_IDENTITY || 'development-unbound').trim();

function createIssueId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `MP-UI-${time}-${random}`;
}

const CHUNK_FAILURE_PATTERNS = [
  'dynamically imported module',
  'Importing a module script failed',
  'ChunkLoadError',
  'Loading chunk',
];

function looksLikeStaleChunk(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return CHUNK_FAILURE_PATTERNS.some((p) => text.includes(p));
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false, staleChunk: false, issueId: '', copyState: 'idle' };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { failed: true, staleChunk: looksLikeStaleChunk(error), issueId: createIssueId(), copyState: 'idle' };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Error object + component stack only — never user data or tokens (9.7).
    console.error(`[AppErrorBoundary:${this.state.issueId || 'unassigned'}] render failure`, error, info.componentStack);
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  private readonly copyReference = async (): Promise<void> => {
    const reference = `Milk Pop support reference\nIssue: ${this.state.issueId}\nRelease: ${BUILD_RELEASE_IDENTITY}`;
    try {
      await navigator.clipboard.writeText(reference);
      this.setState({ copyState: 'copied' });
    } catch {
      this.setState({ copyState: 'failed' });
    }
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const message = this.state.staleChunk
      ? 'This tab is running an older version of the site than the server. Reloading will fetch the latest version.'
      : 'Something went wrong while drawing this page. Reloading usually fixes it. Any unsaved information on this page may need to be entered again.';
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: '#FBFBFC',
          color: '#2E2A26',
        }}
      >
        <div style={{ maxWidth: '420px', textAlign: 'center' }}>
          <div style={{ fontSize: '40px', lineHeight: 1, marginBottom: '16px' }} aria-hidden="true">
            🥤
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px' }}>
            Milk Pop hit a snag
          </h1>
          <p style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 20px', color: '#5C564F' }}>
            {message}
          </p>
          <p style={{ fontSize: '12px', lineHeight: 1.5, margin: '0 0 16px', color: '#756E66', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            Support reference: {this.state.issueId}<br />Release: {BUILD_RELEASE_IDENTITY}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={this.reload}
              style={{
                minHeight: '44px',
                padding: '10px 24px',
                borderRadius: '9999px',
                border: 'none',
                background: '#2E2A26',
                color: '#FFFFFF',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={() => { void this.copyReference(); }}
              style={{
                minHeight: '44px',
                padding: '10px 18px',
                borderRadius: '9999px',
                border: '1px solid #CFC7BE',
                background: '#FFFFFF',
                color: '#2E2A26',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Copy support reference
            </button>
          </div>
          {this.state.copyState !== 'idle' && (
            <p role="status" aria-live="polite" style={{ fontSize: '13px', margin: '12px 0 0', color: this.state.copyState === 'copied' ? '#137A42' : '#A12727' }}>
              {this.state.copyState === 'copied' ? 'Support reference copied.' : 'The reference could not be copied on this device.'}
            </p>
          )}
        </div>
      </div>
    );
  }
}
