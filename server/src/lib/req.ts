import type { FastifyRequest } from "fastify";

/**
 * Typed accessor for the request-scoped fields that audit/rate-limit/push
 * code reads over and over. Fastify exposes `req.ip` on the base type but
 * our `userId` is added by the auth preHandler via `@fastify/cookie` +
 * module augmentation, and TS doesn't always pull the augmentation in. We
 * also want a uniform user-agent extraction that always returns
 * `string | null` instead of checking `typeof ... === "string"` inline at
 * every callsite.
 */
export interface RequestCtx {
  ip: string | null;
  userAgent: string | null;
  userId: string | null;
}

export function getRequestCtx(req: FastifyRequest): RequestCtx {
  const ua = req.headers["user-agent"];
  return {
    ip: typeof req.ip === "string" ? req.ip : null,
    userAgent: typeof ua === "string" && ua.length > 0 ? ua : null,
    userId:
      typeof (req as { userId?: unknown }).userId === "string"
        ? ((req as { userId: string }).userId)
        : null,
  };
}
