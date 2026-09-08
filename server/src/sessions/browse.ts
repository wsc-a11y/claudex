import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Filesystem browse API. Powers the web FolderPicker, the @-file mention
 * sheet, and the general-purpose Files browser.
 *
 * Three endpoints:
 *   GET /api/browse/home     — user home (the default landing path)
 *   GET /api/browse?path=    — list immediate children of an absolute path.
 *                              Classifies each as dir/file, flags hidden
 *                              (leading-dot) entries, never follows symlinks.
 *   GET /api/browse/read?path= — read text contents of an absolute-path file
 *                                with binary detection + 1 MB cap.
 *
 * This is a host-machine service and the user knows their own paths, so
 * we intentionally do not restrict which absolute paths can be listed.
 */

const BINARY_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "ico", "webp", "bmp", "tiff", "tif",
  // audio / video
  "mp3", "mp4", "wav", "ogg", "flac", "aac", "mkv", "avi", "mov", "wmv",
  // archives
  "zip", "tar", "gz", "bz2", "xz", "rar", "7z", "zst",
  // binaries
  "exe", "dll", "obj", "bin", "wasm", "so", "dylib", "a", "o",
  // docs
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // DBs
  "db", "sqlite", "sqlite3",
  // JVM
  "class", "jar",
  // compiled python
  "pyc",
]);

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

// Hard cap on the raw-bytes endpoint. Images are usually small, PDFs can
// be larger — but nobody wants to pull a 500 MB video through an frpc
// tunnel on a phone. 50 MB is enough for everyday office docs and PDFs
// and still a sane ceiling. Files bigger than this return 413.
const MAX_RAW_BYTES = 50 * 1024 * 1024;

// Content-Type lookup for the raw endpoint. Deliberately small — we only
// need the types the browser can actually render inline or that we send
// as downloads (office). `application/octet-stream` is the fallback for
// anything we don't recognize; the browser will download it.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  // documents
  pdf: "application/pdf",
  // office
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  // audio / video (browser-decodable subset)
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  // web
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
};

function formatMode(mode: number): string {
  const chars = ["-", "-", "-", "-", "-", "-", "-", "-", "-", "-"];
  if ((mode & 0o400) !== 0) chars[1] = "r";
  if ((mode & 0o200) !== 0) chars[2] = "w";
  if ((mode & 0o100) !== 0) chars[3] = "x";
  if ((mode & 0o040) !== 0) chars[4] = "r";
  if ((mode & 0o020) !== 0) chars[5] = "w";
  if ((mode & 0o010) !== 0) chars[6] = "x";
  if ((mode & 0o004) !== 0) chars[7] = "r";
  if ((mode & 0o002) !== 0) chars[8] = "w";
  if ((mode & 0o001) !== 0) chars[9] = "x";
  return chars.join("");
}

export async function registerBrowseRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/browse/home",
    { preHandler: app.requireAuth as any },
    async () => ({ path: os.homedir() }),
  );

  app.get(
    "/api/browse",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { path?: string };
      const raw = q?.path;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      if (!path.isAbsolute(raw)) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      const abs = path.resolve(raw);

      let stat: fs.Stats;
      try {
        // lstat on the target itself: if the path *is* a symlink to a dir
        // we still follow it for the listing (statSync would), but we do
        // not follow symlinks for children. Use stat here to accept a
        // symlinked-dir passed in as `path`.
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          return reply.code(404).send({ error: "not_found" });
        }
        if (code === "EACCES" || code === "EPERM") {
          return reply.code(403).send({ error: "permission_denied" });
        }
        throw err;
      }
      if (!stat.isDirectory()) {
        return reply.code(403).send({ error: "not_a_directory" });
      }

      let names: string[];
      try {
        names = await fsp.readdir(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM") {
          return reply.code(403).send({ error: "permission_denied" });
        }
        throw err;
      }

      const entries = [] as Array<{
        name: string;
        path: string;
        isDir: boolean;
        isHidden: boolean;
        size?: number;
        mtimeMs?: number;
      }>;
      for (const name of names) {
        const childPath = path.join(abs, name);
        let childStat: fs.Stats | null = null;
        try {
          // lstat — don't follow symlinks. A dangling symlink should show
          // up as a non-dir entry, not crash the listing.
          childStat = await fsp.lstat(childPath);
        } catch {
          // entry disappeared between readdir and lstat, or no permission.
          // Skip it — the listing is a snapshot, not a transaction.
          continue;
        }
        const isSymlink = childStat.isSymbolicLink();
        const isDir = !isSymlink && childStat.isDirectory();
        const isFile = isSymlink || childStat.isFile();
        if (!isDir && !isFile) {
          // sockets, block devices, fifos, etc. — skip.
          continue;
        }
        entries.push({
          name,
          path: childPath,
          isDir,
          isHidden: name.startsWith("."),
          size: isFile ? childStat.size : undefined,
          mtimeMs: childStat.mtimeMs,
        });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const parent = path.dirname(abs);
      return {
        path: abs,
        parent: parent === abs ? null : parent,
        entries,
      };
    },
  );

  // GET /api/browse/read?path=<absPath>
  //
  // Reads a text file at any absolute host path. Used by the general-purpose
  // Files browser (which is not project-scoped). Mirrors the safety of the
  // project-scoped /api/files/read: extension blocklist, null-byte sniff, and
  // a hard 1 MB cap with a `truncated: true` flag. No git annotations — that
  // layer lives in the project-scoped API and isn't meaningful for arbitrary
  // host paths.
  app.get(
    "/api/browse/read",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { path?: string };
      const raw = q?.path;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      if (!path.isAbsolute(raw)) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      const abs = path.resolve(raw);

      // Extension-based rejection first — fastest path, no I/O.
      const ext = path.extname(abs).toLowerCase().slice(1);
      if (BINARY_EXTENSIONS.has(ext)) {
        return reply.code(415).send({ error: "binary_file" });
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT")
          return reply.code(404).send({ error: "not_found" });
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }
      if (stat.isDirectory()) {
        return reply.code(400).send({ error: "is_a_directory" });
      }

      // Read up to MAX_READ_BYTES + 1 so we can detect "larger than cap" in
      // one read.
      const fd = await fsp.open(abs, "r");
      let content: string;
      let truncated = false;
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES + 1);
        const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES + 1, 0);
        truncated = bytesRead > MAX_READ_BYTES;
        const slice = buf.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));

        // Null-byte sniff: catches binaries the extension check missed.
        const sniffLen = Math.min(512, slice.length);
        for (let i = 0; i < sniffLen; i++) {
          if (slice[i] === 0) {
            return reply.code(415).send({ error: "binary_file" });
          }
        }

        content = slice.toString("utf8");
      } finally {
        await fd.close();
      }

      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const parent = path.dirname(abs);
      return {
        path: abs,
        parent: parent === abs ? null : parent,
        name: path.basename(abs),
        content,
        lines,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: formatMode(stat.mode),
        truncated,
      };
    },
  );

  // GET /api/browse/raw?path=<absPath>&download=1
  //
  // Streams raw bytes at any absolute host path with a best-guess
  // Content-Type. Powers inline previews for images / PDFs / HTML /
  // audio / video, and the "Download" button for Office docs that the
  // UI can't render inline.
  //
  // Same auth + absolute-path validation as the rest of /api/browse*.
  // No null-byte sniff — this endpoint is explicitly for binary content.
  // The 50 MB cap is enforced before streaming so we don't start a
  // response we can't finish.
  //
  // `download=1` (or any truthy value) toggles
  // `Content-Disposition: attachment` so clicking a download-link in
  // the UI actually saves instead of navigating. Default is `inline`
  // so <img> / <iframe> previews don't break.
  app.get(
    "/api/browse/raw",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { path?: string; download?: string };
      const raw = q?.path;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      if (!path.isAbsolute(raw)) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      const abs = path.resolve(raw);

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT")
          return reply.code(404).send({ error: "not_found" });
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }
      if (stat.isDirectory()) {
        return reply.code(400).send({ error: "is_a_directory" });
      }
      if (stat.size > MAX_RAW_BYTES) {
        return reply.code(413).send({ error: "file_too_large" });
      }

      const ext = path.extname(abs).toLowerCase().slice(1);
      const contentType =
        CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";

      // ASCII-only filename in Content-Disposition's filename= plus an
      // RFC 5987 filename* for anything with non-ASCII characters — same
      // pattern common Node frameworks use.
      const baseName = path.basename(abs);
      const safeAscii = baseName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      const encoded = encodeURIComponent(baseName);
      const disposition =
        q?.download && q.download !== "0" && q.download !== "false"
          ? "attachment"
          : "inline";

      reply
        .header("Content-Type", contentType)
        .header("Content-Length", String(stat.size))
        .header(
          "Content-Disposition",
          `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
        )
        // Short-lived cache: same-file re-renders within a session are
        // fine from cache, but edits on disk are visible on refresh.
        .header("Cache-Control", "private, max-age=30");

      return reply.send(fs.createReadStream(abs));
    },
  );
}
