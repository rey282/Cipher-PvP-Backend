import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
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

// ───── Rate limiting ─────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: 'Too many requests – please try again later.' }
});

// ───── Middleware ─────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const allowedHostnames = [
      'localhost',
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

// ───── Sessions (PostgreSQL-backed) ─────
const PgSession = pgSession(session);
app.use(session({
  name: 'cid',
  store: new PgSession({
    pool,
    tableName: 'session'
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

// ───── Passport + security ─────
app.use(passport.initialize());
app.use(passport.session());
app.use(globalLimiter);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// ───── routes ─────
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

// ───── Root + Cache ─────
app.get("/", (_req: Request, res: Response) => {
  res.send("API is running.");
});


/* ─────────── health check ─────────── */
app.get("/ping", (_req, res) => {
  res.status(200).send("pong");
});

/* ─────────── 404 fallback ─────────── */
app.use((_, res, _next) => {
  res.status(404).json({ error: 'Not Found' });
});

/* ─────────── start ─────────── */
app.listen(PORT, () => {
  console.log(`✅ Backend running on ${isProd ? "https://spajaja.cipher.uno" : `http://localhost:${PORT}`}`);
});
