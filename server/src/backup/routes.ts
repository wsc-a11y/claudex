import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildBackupBundle } from "./export.js";
import { coerceBundle, importBackupBundle } from "./import.js";

// -----------------------------------------------------------------------------
// Full-data backup routes
//
//   GET  /api/export/all             → JSON bundle (attachment download)
//   POST /api/import/all             → multipart, field `bundle` is the JSON file
//
// Login-gated. Export streams the JSON body (Fastify's reply.send on a string
// is fine for multi-MB transcripts in the P0 workload; if bundles grow past
// ~50MB we can swap to a Readable that pipes rows from SQLite). Import parses
// the file into memory, validates shape, and runs `importBackupBundle`
// inside a single transaction so partial failures roll back cleanly.
//
// The shared `CLAUDEX_VERSION` is bumped in lockstep with the web/server
// package.json — we read it here as a literal to avoid having to add fs
// reads at boot.
// -----------------------------------------------------------------------------

const CLAUDEX_VERSION = "0.0.1";

// Hard cap on uploaded bundle size. Generous enough for the expected data
// volumes (sessions × events over multiple months of use) while still
// refusing a DOS by file size. Multipart plugin is registered globally in
// `transport/app.ts` with a `fileSize: 5 MB` limit — backup needs a bigger
// ceiling, so we override per-request.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface BackupRoutesDeps {
  db: Database.Database;
}

export async function registerBackupRoutes(
  app: FastifyInstance,
  deps: BackupRoutesDeps,
): Promise<void> {
  // --- Export ---------------------------------------------------------
  app.get(
    "/api/export/all",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const bundle = buildBackupBundle(deps.db, {
        claudexVersion: CLAUDEX_VERSION,
      });
      const date = new Date()
        .toISOString()
        .replace(/[:-]/g, "")
        .replace(/\..+$/, "")
        .replace("T", "-"); // YYYYMMDD-HHMMSS
      const filename = `claudex-backup-${date}.json`;
      // JSON.stringify is fine for today's scale — we can swap to a streaming
      // encoder if a user reports a slow/OOM export against a huge DB.
      const body = JSON.stringify(bundle);
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${filename}"`,
        )
        .send(body);
    },
  );

  // --- Import ---------------------------------------------------------
  app.post(
    "/api/import/all",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      if (
        typeof (req as any).isMultipart !== "function" ||
        !(req as any).isMultipart()
      ) {
        return reply.code(400).send({ error: "expected_multipart" });
      }
      let part: any;
      try {
        part = await (req as any).file({
          limits: { fileSize: MAX_BUNDLE_BYTES },
        });
      } catch (err: any) {
        if (err?.code === "FST_REQ_FILE_TOO_LARGE" || err?.statusCode === 413) {
          return reply.code(413).send({ error: "bundle_too_large" });
        }
        throw err;
      }
      if (!part) {
        return reply.code(400).send({ error: "no_file" });
      }

      // Drain into a Buffer — the import step needs the full JSON before it
      // can validate or apply. We cap at MAX_BUNDLE_BYTES above; anything
      // above that trips multipart's `truncated` flag.
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
      } catch (err: any) {
        return reply.code(400).send({ error: "read_failed" });
      }
      if (part.file?.truncated) {
        return reply.code(413).send({ error: "bundle_too_large" });
      }
      const raw = Buffer.concat(chunks).toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid_json" });
      }

      let bundle;
      try {
        bundle = coerceBundle(parsed);
      } catch (err: any) {
        return reply.code(400).send({ error: err?.message ?? "invalid_bundle" });
      }

      try {
        const result = importBackupBundle(deps.db, bundle, {
          claudexVersion: CLAUDEX_VERSION,
        });
        return reply.send(result);
      } catch (err: any) {
        app.log?.warn?.({ err }, "import bundle failed");
        return reply
          .code(500)
          .send({ error: "import_failed", detail: String(err?.message ?? err) });
      }
    },
  );
}
