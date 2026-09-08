import { Component, type ErrorInfo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// ErrorBoundary — minimal class-component boundary for localized crash
// containment. Written as a class because that's the only way to tap into
// React's error-lifecycle hooks (getDerivedStateFromError /
// componentDidCatch). The goal is NOT to recover gracefully — it's to keep
// one misbehaving subtree (e.g. the PermissionCard checkbox region over an
// odd DOM shape on desktop) from unmounting the whole app when the user is
// driving claudex from their phone.
//
// Logs the stack to console so the user can forward it when the boundary
// fires. No toast, no telemetry, no new deps.
// ---------------------------------------------------------------------------

interface Props {
  children: ReactNode;
  // Rendered when the subtree throws. Receives the caught error so callers
  // can show something tailored (e.g. a Deny button on a permission card).
  // A plain string fallback works too.
  fallback?: ReactNode | ((error: Error) => ReactNode);
  // Optional extra context baked into the console.error line, so multiple
  // boundaries on a screen can be told apart in the devtools log.
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const label = this.props.label ?? "ErrorBoundary";
    // eslint-disable-next-line no-console
    console.error(`[${label}] caught`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") return fallback(error);
      if (fallback !== undefined) return fallback;
      return (
        <div className="rounded border border-danger/40 bg-danger-wash/60 p-3 text-ui text-danger">
          此卡片中的内容出了问题。
        </div>
      );
    }
    return this.props.children;
  }
}
