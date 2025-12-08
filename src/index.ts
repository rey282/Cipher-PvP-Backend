import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import session from 'express-session';
import type { Request, Response } from "express";
import pgSession from 'connect-pg-simple';
import passport from 'passport';

import { discordAuthRouter } from './auth/discord';
import { pool } from './db'; 

import rosterRouter from "./routes/roster";
import announcementRouter from "./routes/announcement";

import charactersRouter from "./routes/characters";
import playersRouter from "./routes/players";
import summaryRouter from "./routes/summary";
import matchesRouter from "./routes/matches";
import adminRouter from "./routes/admin";
import balanceRouter from "./routes/balance";
import cerydraRouter from "./routes/cerydra";
import insightsRouter from "./routes/insights";
import zzzRouter from "./routes/zzz";
import cipherCostRouter from "./routes/ciphercost";
import zzzSpectatorRoutes from "./routes/zzzSpectator";
import hsrSpectatorRoutes from "./routes/hsrSpectator";
import zzzBalanceRouter from "./routes/zzz-balance";


// scoped limiters
import {
  publicLimiter,
  draftActionLimiter,
  ownerLimiter,
  DRAFT_ROOT_RE,
  SSE_STREAM_RE,
} from "./middleware/rateLimiters";

dotenv.config();

const requiredEnvs = ['DATABASE_URL', 'SESSION_SECRET'];
for (const name of requiredEnvs) {
  if (!process.env[name]) {
    console.error(`❌ ${name} is missing in .env`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

/* ───────── Global limiter ───────── */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,  
  max: 2000,             
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.method === "OPTIONS" ||
    req.path === "/ping" ||
    req.path === "/healthz",
  handler: (_req, res) => {
    res.setHeader("Retry-After", "5");
    res.status(429).json({
      status: 429,
      error: "Too many requests – please try again later.",
    });
  },
});


/* ───────── CORS ───────── */
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const allowedHostnames = [
      'localhost',
      '127.0.0.1',
      'haya-pvp.vercel.app',
    ];

    try {
      const url = new URL(origin);
      const hostname = url.hostname;

      if (
        hostname.endsWith('.cipher.uno') ||
        hostname === 'cipher.uno' ||
        allowedHostnames.includes(hostname)
      ) {
        return callback(null, true);
      }
    } catch (e) {
      return callback(new Error('Invalid origin'));
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

/* ───────── Sessions ───────── */
const PgSession = pgSession(session);
app.use(session({
  name: 'cid',
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,    
    pruneSessionInterval: 60 * 60, 
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    domain: isProd ? '.cipher.uno' : undefined,
  }
}));

/* ───────── Security & body parsing ───────── */
app.use(passport.initialize());
app.use(passport.session());
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

/* ───────── Apply global limiter EXCEPT drafting ───────── */
app.use((req, res, next) => {
  if (DRAFT_ROOT_RE.test(req.path) || SSE_STREAM_RE.test(req.path)) {
    return next();
  }
  return globalLimiter(req, res, next);
});

/* ───────── Scoped rate limiters for DRAFTING only ───────── */
app.use("/api/hsr/matches/recent", publicLimiter);
app.use("/api/hsr/matches/live", publicLimiter);
app.use("/api/zzz/matches/recent", publicLimiter);
app.use("/api/zzz/matches/live", publicLimiter);

app.use("/api/hsr/sessions/:key/actions", draftActionLimiter);
app.use("/api/zzz/sessions/:key/actions", draftActionLimiter);

app.use("/api/hsr/sessions", ownerLimiter);
app.use("/api/hsr/sessions/:key", ownerLimiter);
app.use("/api/hsr/cost-presets", ownerLimiter);
app.use("/api/hsr/cost-presets/:id", ownerLimiter);

app.use("/api/zzz/sessions", ownerLimiter);
app.use("/api/zzz/sessions/:key", ownerLimiter);
app.use("/api/zzz/cost-presets", ownerLimiter);
app.use("/api/zzz/cost-presets/:id", ownerLimiter);

/* ───────── Routes ───────── */
app.use(rosterRouter);
app.use("/api/announcement", announcementRouter);
app.use("/auth", discordAuthRouter);
app.use(charactersRouter);
app.use(playersRouter);
app.use(summaryRouter);
app.use(matchesRouter);
app.use(adminRouter);
app.use(balanceRouter);
app.use(cerydraRouter);
app.use(insightsRouter);
app.use("/api/zzz", zzzRouter);
app.use(cipherCostRouter);
app.use(zzzSpectatorRoutes);
app.use(zzzBalanceRouter);
app.use(hsrSpectatorRoutes);

/* ───────── Root & Health ───────── */
app.get("/", (_req: Request, res: Response) => {
  res.send("API is running.");
});

app.get("/ping", (_req, res) => {
  res.status(200).send("pong");
});

app.get("/healthz", async (_req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    console.error("DB healthcheck failed:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/proxy/token", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // Forward the form data exactly as Discord expects it.
    const params = new URLSearchParams(req.body);

    const discordRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const data = await discordRes.json();
    res.status(discordRes.status).json(data);

  } catch (error) {
    console.error("[Discord Proxy Error]", error);
    const err = error as Error;
    res.status(500).json({ error: "Proxy failed", details: err.message });


  }
});


/* ───────── 404 fallback ───────── */
app.use((_, res, _next) => {
  res.status(404).json({ error: 'Not Found' });
});

/* ───────── start ───────── */
app.listen(PORT, () => {
  console.log(`✅ Backend running on ${isProd ? "https://spajaja.cipher.uno" : `http://localhost:${PORT}`}`);
});
