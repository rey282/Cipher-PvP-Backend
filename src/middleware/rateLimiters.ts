// src/middleware/rateLimiters.ts
import rateLimit from "express-rate-limit";

export const matchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    error: "Too many request – please slow down.",
  },
});
