// src/middleware/rateLimiters.ts
import rateLimit from "express-rate-limit";

// Shared options so all limiters behave the same
const commonOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  // Skip preflights and health checks
  skip: (req: any) =>
    req.method === "OPTIONS" ||
    req.path === "/ping" ||
    req.path === "/healthz",
  handler: (req: any, res: any /*, next */) => {
    // Optional gentle backoff hint (seconds)
    res.setHeader("Retry-After", "5");
    res.status(429).json({
      status: 429,
      error: "Too many requests – please slow down.",
    });
  },
} as const;

export const matchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  ...commonOpts,
});

// Public list/read endpoints (recent/live, etc.)
export const publicLimiter = rateLimit({
  windowMs: 10_000,
  max: 100,
  ...commonOpts,
});

// Draft WRITE actions — key by session + player token
export const draftActionLimiter = rateLimit({
  windowMs: 10_000,
  max: 200,
  keyGenerator: (req: any) => {
    const sessionKey = req.params?.key || "nokey";
    const pt = (req.body?.pt || req.query?.pt || req.ip) as string;
    return `${sessionKey}:${pt}`;
  },
  ...commonOpts,
});

// Owner mutations (create/update/delete session & presets)
export const ownerLimiter = rateLimit({
  windowMs: 10_000,
  max: 40,
  keyGenerator: (req: any) => (req.user?.id || req.ip) as string,
  ...commonOpts,
});

// Regex helpers to spot drafting routes (and SSE streams) for skip logic
export const DRAFT_ROOT_RE = /^\/api\/(?:hsr|zzz)\/sessions(?:\/|$)/;
export const SSE_STREAM_RE = /^\/api\/(?:hsr|zzz)\/sessions\/[^/]+\/stream$/;
