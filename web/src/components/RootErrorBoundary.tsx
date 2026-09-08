import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/error-reporter";

// ---------------------------------------------------------------------------
// RootErrorBoundary — last-line-of-defense boundary wrapped around the
// entire <App />. When a render error escapes every subtree boundary, this
// shows a full-screen red "crash" page with the error + stack so the user
// on a phone can actually see what broke, instead of a silent white screen.
//
// Hard rule: this component's render MUST NOT depend on Tailwind, any
// shared component, the router, or any user-land module. If those are what
// crashed, a fallback that uses them crashes again and we're right back at
// white. Everything is inline style + literal text.
//
// Reports the caught error to /api/client-errors via reportClientError so
// the /errors screen can surface it later, independent of this in-page
// view (the user can Reload and then go look).
// ---------------------------------------------------------------------------

interface State {
  error: Error | null;
  componentStack: string;
}

export class RootErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? "" });
    try {
      reportClientError({
        kind: "render",
        error,
        componentStack: info.componentStack ?? undefined,
      });
    } catch {
      /* never make a render crash worse */
    }
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          padding: "16px",
          background: "#1a0000",
          color: "#ffd7d7",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: "12px",
          lineHeight: 1.5,
          boxSizing: "border-box",
          overflowWrap: "anywhere",
        }}
      >
        <div
          style={{
            fontSize: "16px",
            fontWeight: 600,
            marginBottom: "8px",
            color: "#ff8a8a",
          }}
        >
          渲染崩溃
        </div>
        <div style={{ marginBottom: "12px", whiteSpace: "pre-wrap" }}>
          {error.message || String(error)}
        </div>
        {error.stack && (
          <details open style={{ marginBottom: "12px" }}>
            <summary style={{ cursor: "pointer", color: "#ffb4b4" }}>
              调用栈
            </summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                margin: "8px 0 0 0",
                opacity: 0.85,
              }}
            >
              {error.stack}
            </pre>
          </details>
        )}
        {componentStack && (
          <details style={{ marginBottom: "12px" }}>
            <summary style={{ cursor: "pointer", color: "#ffb4b4" }}>
              组件栈
            </summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                margin: "8px 0 0 0",
                opacity: 0.7,
              }}
            >
              {componentStack}
            </pre>
          </details>
        )}
        <div style={{ marginTop: "16px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              try {
                location.reload();
              } catch {
                /* no-op */
              }
            }}
            style={{
              padding: "8px 14px",
              border: "1px solid #ff8a8a",
              background: "transparent",
              color: "#ffd7d7",
              borderRadius: "6px",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            重新加载
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                location.assign("/errors");
              } catch {
                /* no-op */
              }
            }}
            style={{
              padding: "8px 14px",
              border: "1px solid #ff8a8a",
              background: "transparent",
              color: "#ffd7d7",
              borderRadius: "6px",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            打开 /errors
          </button>
        </div>
        <div style={{ marginTop: "14px", opacity: 0.6 }}>
          此错误已上报到 /api/client-errors——可访问{" "}
          <code style={{ color: "#ffb4b4" }}>/errors</code> 查看并解决它。
        </div>
      </div>
    );
  }
}
