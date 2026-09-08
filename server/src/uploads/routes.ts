import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { SessionStore } from "../sessions/store.js";
import { AttachmentStore, type AttachmentRow } from "./store.js";

// -----------------------------------------------------------------------------
// Attachment upload routes
//
// Powers the composer's "📎 Attach" chip. Files live on disk under
// `<stateDir>/uploads/<session-id>/<nano-id>-<sanitized-name>` and metadata in
// SQLite (see migration id=7). Two-phase lifecycle — upload first, link to
// a user_message when the user hits Send. Unlinked attachments can be
// deleted; linked attachments are immutable.
//
// Hard limits:
//   - 5 MB per file (rejected as 413)
//   - 10 MB per request (multipart plugin enforces it; surfaces as 413)
//   - allowlisted mime types only (rejected as 415)
// -----------------------------------------------------------------------------

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
]);

/** Serializable shape returned by upload + used by the web client. */
interface AttachmentApi {
  id: string;
  filename: string;
  mime: string;
  size: number;
  previewUrl?: string;
}

export interface UploadsRoutesDeps {
  db: Database.Database;
  /** Absolute path to the root under which per-session upload dirs live.
   * Defaults to `<stateDir>/uploads`; tests inject a tmp dir. */
  uploadsRoot: string;
}

/**
 * Clip + sanitize a user-supplied filename so it's safe as a path component.
 * Strips any character outside `[a-zA-Z0-9._-]` and clips the result to 64
 * characters. Falls back to "file" if the sanitized form is empty (e.g. the
 * original was all Unicode) so we never produce a bare nano-id with no name.
 */
export function sanitizeFilename(raw: string): string {
  // Only the basename — drop any path components from the uploaded name.
  const base = path.basename(raw);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  const clipped = cleaned.slice(0, 64);
  return clipped.length > 0 ? clipped : "file";
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function toApi(row: AttachmentRow): AttachmentApi {
  const out: AttachmentApi = {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.sizeBytes,
  };
  if (isImageMime(row.mime)) {
    out.previewUrl = `/api/attachments/${row.id}/raw`;
  }
  return out;
}

export async function registerUploadsRoutes(
  app: FastifyInstance,
  deps: UploadsRoutesDeps,
): Promise<void> {
  const sessions = new SessionStore(deps.db);
  const attachments = new AttachmentStore(deps.db);

  await fsp.mkdir(deps.uploadsRoot, { recursive: true, mode: 0o700 });

  // POST /api/sessions/:id/attachments
  //
  // multipart/form-data. Accepts one or more `file` parts. Returns the first
  // uploaded attachment (the web client uploads one file per request, so this
  // is the common case). For multi-file submissions only the first part is
  // persisted — we keep the API simple and let the client serialize uploads.
  app.post(
    "/api/sessions/:id/attachments",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id: sessionId } = req.params as { id: string };
      const session = sessions.findById(sessionId);
      if (!session) return reply.code(404).send({ error: "not_found" });

      // `req.isMultipart()` is installed by @fastify/multipart; refuse
      // non-multipart bodies up front so the user sees a clean error.
      if (typeof (req as any).isMultipart !== "function" || !(req as any).isMultipart()) {
        return reply.code(400).send({ error: "expected_multipart" });
      }

      let part: any;
      try {
        part = await (req as any).file({
          limits: {
            fileSize: MAX_FILE_BYTES,
          },
        });
      } catch (err: any) {
        // @fastify/multipart throws a tagged error for oversize requests.
        if (err?.code === "FST_REQ_FILE_TOO_LARGE" || err?.statusCode === 413) {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw err;
      }
      if (!part) {
        return reply.code(400).send({ error: "no_file" });
      }

      const mime = String(part.mimetype ?? "application/octet-stream");
      if (!ALLOWED_MIME.has(mime)) {
        // Drain the stream so the client doesn't hang on a backed-up buffer
        // while we reply. The plugin requires the stream to be consumed.
        part.file.resume();
        return reply.code(415).send({ error: "unsupported_mime", mime });
      }

      const sessionDir = path.join(deps.uploadsRoot, sessionId);
      await fsp.mkdir(sessionDir, { recursive: true, mode: 0o700 });

      const safeName = sanitizeFilename(part.filename ?? "file");
      const diskName = `${nanoid(12)}-${safeName}`;
      const diskPath = path.join(sessionDir, diskName);

      try {
        // Stream to disk. Plugin already enforces the per-file limit; when
        // exceeded the stream emits `limit` and pipeline rejects with the
        // FST_REQ_FILE_TOO_LARGE error.
        const out = fs.createWriteStream(diskPath, { mode: 0o600 });
        await pipeline(part.file, out);
      } catch (err: any) {
        // Clean up the partial file — we don't want orphans on disk if the
        // upload was aborted mid-stream.
        try {
          await fsp.unlink(diskPath);
        } catch {
          /* ignore */
        }
        if (
          err?.code === "FST_REQ_FILE_TOO_LARGE" ||
          part.file?.truncated
        ) {
          return reply.code(413).send({ error: "file_too_large" });
        }
        throw err;
      }

      // Paranoia: the plugin's `truncated` flag also signals a clipped file
      // without throwing on older versions.
      if (part.file?.truncated) {
        try {
          await fsp.unlink(diskPath);
        } catch {
          /* ignore */
        }
        return reply.code(413).send({ error: "file_too_large" });
      }

      const stat = await fsp.stat(diskPath);
      const row = attachments.insertUnlinked({
        sessionId,
        filename: safeName,
        mime,
        sizeBytes: stat.size,
        path: diskPath,
      });

      return reply.send(toApi(row));
    },
  );

  // GET /api/attachments/:id/raw
  //
  // Serves the raw file bytes. Login-gated. `Cache-Control: private, max-age=3600`
  // so the composer's image thumbnail doesn't re-fetch every render. 404 on
  // unknown id. Does NOT require the session id in the URL — the attachment
  // id itself is unguessable (nanoid(12)) and login gates it.
  app.get(
    "/api/attachments/:id/raw",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = attachments.findById(id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (!fs.existsSync(row.path)) {
        return reply.code(404).send({ error: "file_missing" });
      }
      reply.header("Content-Type", row.mime);
      reply.header("Cache-Control", "private, max-age=3600");
      reply.header(
        "Content-Disposition",
        `inline; filename="${row.filename.replace(/"/g, "")}"`,
      );
      return reply.send(fs.createReadStream(row.path));
    },
  );

  // DELETE /api/attachments/:id
  //
  // Removes an UNLINKED attachment. Linked rows refuse with 404 — you can't
  // retract an attachment after sending. Best-effort file removal; the row is
  // gone regardless of whether the file unlink succeeded.
  app.delete(
    "/api/attachments/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const removed = attachments.deleteUnlinked(id);
      if (!removed) return reply.code(404).send({ error: "not_found" });
      try {
        await fsp.unlink(removed.path);
      } catch {
        /* best-effort */
      }
      return reply.code(204).send();
    },
  );
}

/**
 * Best-effort: remove the session's upload directory + any files beneath it.
 * Called from the session DELETE route after the row is gone — the DB
 * cascade handles the rows, but nothing else removes the files. Swallows
 * errors: the session is already deleted, we can't refuse on cleanup.
 */
export async function removeSessionUploadsDir(
  uploadsRoot: string,
  sessionId: string,
): Promise<void> {
  const dir = path.join(uploadsRoot, sessionId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
