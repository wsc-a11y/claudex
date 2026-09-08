// Cross-platform absolute-path helpers for the web UI.
//
// The server uses Node's `path` module (platform-aware), so any absolute
// path it returns — and any absolute path a user types — may be POSIX
// (`/a/b`), Windows drive-letter (`D:\a\b`, `D:/a/b`), or Windows UNC
// (`\\server\share\a`). The UI historically hardcoded `/` as the
// separator, which mangled breadcrumbs, basenames, and "up" navigation
// on Windows hosts. Route every display/navigation split through here.

const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WIN_UNC_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;

export function isWindowsPath(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || WIN_UNC_RE.test(p);
}

export function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/")) return true;
  return isWindowsPath(p);
}

function sep(p: string): "\\" | "/" {
  return isWindowsPath(p) ? "\\" : "/";
}

export interface PathSplit {
  root: string;
  parts: string[];
}

// Split an absolute path into its root prefix and body segments. Mixed
// slashes in Windows inputs are tolerated (`D:/Code` is normalized to
// `D:\Code`); POSIX paths are returned as-is.
export function splitPath(p: string): PathSplit {
  if (isWindowsPath(p)) {
    const unified = p.replace(/\//g, "\\");
    if (/^[A-Za-z]:\\/.test(unified)) {
      const root = unified.slice(0, 3); // "D:\"
      const parts = unified.slice(3).split("\\").filter(Boolean);
      return { root, parts };
    }
    // UNC: \\server\share\...
    const after = unified.slice(2);
    const firstSep = after.indexOf("\\");
    if (firstSep === -1) {
      return { root: unified, parts: [] };
    }
    const afterHost = after.slice(firstSep + 1);
    const secondSep = afterHost.indexOf("\\");
    if (secondSep === -1) {
      const base = unified.endsWith("\\") ? unified : unified + "\\";
      return { root: base, parts: [] };
    }
    const rootLen = 2 + firstSep + 1 + secondSep + 1;
    const root = unified.slice(0, rootLen);
    const parts = unified.slice(rootLen).split("\\").filter(Boolean);
    return { root, parts };
  }
  const parts = p.split("/").filter(Boolean);
  return { root: "/", parts };
}

export function basename(p: string): string {
  if (!p) return "";
  const { root, parts } = splitPath(p);
  return parts[parts.length - 1] ?? root;
}

export function dirname(p: string): string {
  if (!p) return "/";
  const { root, parts } = splitPath(p);
  if (parts.length <= 1) return root;
  return root.replace(/[\\/]$/, "") + sep(p) + parts.slice(0, -1).join(sep(p));
}

export interface Crumb {
  label: string;
  path: string;
}

// Build clickable breadcrumb segments for an absolute path. The first
// crumb is the root prefix (`/`, `D:\`, `\\srv\share\`) and renders as a
// single tap-target so users can jump straight to it.
export function buildCrumbs(absPath: string): Crumb[] {
  if (!absPath) return [{ label: "/", path: "/" }];
  const { root, parts } = splitPath(absPath);
  const crumbs: Crumb[] = [{ label: root, path: root }];
  const s = sep(absPath);
  let acc = root;
  for (const p of parts) {
    acc = acc.endsWith(s) ? acc + p : acc + s + p;
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}
