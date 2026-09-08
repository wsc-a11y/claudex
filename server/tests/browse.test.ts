import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";

describe("filesystem browse HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  describe("GET /api/browse/home", () => {
    it("requires auth", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/browse/home",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns os.homedir() for an authenticated user", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/browse/home",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: os.homedir() });
    });
  });

  describe("GET /api/browse", () => {
    it("requires auth", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse?path=${encodeURIComponent(ctx.tmpDir)}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a missing path with 400 not_absolute", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/browse",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("not_absolute");
    });

    it("rejects a relative path with 400 not_absolute", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/browse?path=relative/subdir",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("not_absolute");
    });

    it("returns 404 for a non-existent absolute path", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const missing = path.join(ctx.tmpDir, "does-not-exist-xyz");
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse?path=${encodeURIComponent(missing)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("returns 403 not_a_directory when pointed at a file", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const filePath = path.join(ctx.tmpDir, "plain.txt");
      fs.writeFileSync(filePath, "hello");
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse?path=${encodeURIComponent(filePath)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_a_directory");
    });

    it(
      "lists mixed dirs / files / hidden entries with correct ordering, flags, and parent",
      async () => {
        const ctx = await bootstrapAuthedApp();
        disposers.push(ctx.cleanup);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-browse-"));
        disposers.push(async () =>
          fs.rmSync(root, { recursive: true, force: true }),
        );

        fs.mkdirSync(path.join(root, "alpha"));
        fs.mkdirSync(path.join(root, "Beta"));
        fs.mkdirSync(path.join(root, ".hidden-dir"));
        fs.writeFileSync(path.join(root, "zeta.txt"), "z");
        fs.writeFileSync(path.join(root, "apple.txt"), "a");
        fs.writeFileSync(path.join(root, ".dotfile"), "secret");

        const res = await ctx.app.inject({
          method: "GET",
          url: `/api/browse?path=${encodeURIComponent(root)}`,
          headers: { cookie: ctx.cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // path.resolve() normalizes but does NOT follow symlinks. On macOS
        // /var/folders is itself a symlink to /private/var/folders — we
        // accept either form to avoid coupling to that detail.
        expect([root, fs.realpathSync(root)]).toContain(body.path);
        expect(body.parent).toBe(path.dirname(body.path));

        const names = body.entries.map((e: { name: string }) => e.name);
        // Dirs come first (alphabetical within dirs), then files. Sort is
        // locale-aware so `.hidden-dir` and `.dotfile` sort with punctuation
        // first; all we strictly require is dirs-before-files and
        // alphabetical within each bucket.
        const firstFileIdx = body.entries.findIndex(
          (e: { isDir: boolean }) => !e.isDir,
        );
        const dirNames = body.entries
          .slice(0, firstFileIdx)
          .map((e: { name: string }) => e.name);
        const fileNames = body.entries
          .slice(firstFileIdx)
          .map((e: { name: string }) => e.name);
        expect(dirNames.every((n: string) => n)).toBe(true);
        expect([...dirNames].sort((a, b) => a.localeCompare(b))).toEqual(
          dirNames,
        );
        expect([...fileNames].sort((a, b) => a.localeCompare(b))).toEqual(
          fileNames,
        );

        expect(names).toContain(".hidden-dir");
        expect(names).toContain(".dotfile");

        const hiddenDir = body.entries.find(
          (e: { name: string }) => e.name === ".hidden-dir",
        );
        expect(hiddenDir.isDir).toBe(true);
        expect(hiddenDir.isHidden).toBe(true);

        const dotfile = body.entries.find(
          (e: { name: string }) => e.name === ".dotfile",
        );
        expect(dotfile.isDir).toBe(false);
        expect(dotfile.isHidden).toBe(true);

        const apple = body.entries.find(
          (e: { name: string }) => e.name === "apple.txt",
        );
        expect(apple.isHidden).toBe(false);
        expect(apple.isDir).toBe(false);
        expect(apple.path).toBe(path.join(body.path, "apple.txt"));
      },
    );

    it("returns parent=null when listing the filesystem root", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = path.parse(process.cwd()).root; // "/" on posix
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse?path=${encodeURIComponent(root)}`,
        headers: { cookie: ctx.cookie },
      });
      // Some CI envs might hit EACCES reading / — accept that, but in the
      // normal case we expect a 200 with parent: null.
      if (res.statusCode === 403) {
        expect(res.json().error).toBe("permission_denied");
        return;
      }
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.parent).toBeNull();
      // path.resolve('/') is '/'; the response should reflect that.
      expect(body.path).toBe(root);
    });

    it("does not follow symlinks — a dangling symlink appears as a non-dir entry", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-browse-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );

      // symlink to something that doesn't exist — statSync would throw,
      // lstat gives us the link info.
      const linkPath = path.join(root, "dangling-link");
      fs.symlinkSync(
        path.join(root, "nothing-here"),
        linkPath,
      );
      // control: a real dir
      fs.mkdirSync(path.join(root, "real-dir"));

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse?path=${encodeURIComponent(root)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const link = body.entries.find(
        (e: { name: string }) => e.name === "dangling-link",
      );
      expect(link).toBeDefined();
      // symlinks are treated as non-dirs (we don't follow them) so they
      // show up in the file bucket even if the target would have been a dir.
      expect(link.isDir).toBe(false);

      const realDir = body.entries.find(
        (e: { name: string }) => e.name === "real-dir",
      );
      expect(realDir.isDir).toBe(true);
    });
  });

  describe("GET /api/browse/raw", () => {
    it("requires auth", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const filePath = path.join(root, "pixel.png");
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(filePath)}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a non-absolute path with 400 not_absolute", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/browse/raw?path=not-abs.png",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("not_absolute");
    });

    it("returns 404 not_found for a missing file", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(
          path.join(root, "nope.png"),
        )}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("rejects a directory with 400 is_a_directory", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(root)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("is_a_directory");
    });

    it("streams bytes with extension-based Content-Type (png)", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const filePath = path.join(root, "pixel.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(filePath, bytes);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(filePath)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["content-length"]).toBe(String(bytes.length));
      expect(res.headers["content-disposition"]).toContain("inline");
      expect(res.headers["content-disposition"]).toContain("pixel.png");
      expect(res.rawPayload.equals(bytes)).toBe(true);
    });

    it("falls back to application/octet-stream for unknown extensions", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const filePath = path.join(root, "mystery.weirdext");
      fs.writeFileSync(filePath, Buffer.from([0x01, 0x02, 0x03]));
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(filePath)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
    });

    it("sets Content-Disposition: attachment when download=1", async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-raw-"));
      disposers.push(async () =>
        fs.rmSync(root, { recursive: true, force: true }),
      );
      const filePath = path.join(root, "report.docx");
      fs.writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK zip header
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/browse/raw?path=${encodeURIComponent(filePath)}&download=1`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain("report.docx");
    });
  });
});
