import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.js";

export function createLogger(config: Config) {
  const logFile = path.join(config.logDir, "server.log");
  // Always write to a rolling-friendly file; pretty-print to stdout in dev.
  const fileStream = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
  const streams: pino.StreamEntry[] = [
    { level: "info", stream: fileStream },
  ];
  if (config.nodeEnv === "development") {
    streams.push({
      level: "debug",
      stream: pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }),
    });
  } else {
    streams.push({ level: "info", stream: process.stdout });
  }
  return pino(
    {
      level: config.nodeEnv === "development" ? "debug" : "info",
      base: { app: "claudex-server" },
    },
    pino.multistream(streams),
  );
}

export type Logger = ReturnType<typeof createLogger>;
