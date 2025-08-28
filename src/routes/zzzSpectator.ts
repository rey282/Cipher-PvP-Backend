// routes/zzzSpectator.ts
import express, { RequestHandler } from "express";
import { pool } from "../db";
import { genKey } from "../utils/genKey";

const router = express.Router();

/* ───────────────── Auth ───────────────── */
const requireLogin: RequestHandler = (req, res, next) => {
  const viewer = (req as any).user as { id?: string } | undefined;
  if (!viewer?.id) {
    res.status(401).json({ error: "Not logged in" });
    return; // return void, not Response
  }
  next();
};

/* ───────────────── SSE Hub ───────────────── */
type Client = import("express").Response;
const clients = new Map<string, Set<Client>>();

function addClient(key: string, res: Client) {
  let set = clients.get(key);
  if (!set) clients.set(key, (set = new Set()));
  set.add(res);
  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) clients.delete(key);
  });
}

function push(key: string, event: string, payload: any) {
  const set = clients.get(key);
  if (!set) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
}

async function snapshotAndPush(key: string) {
  const { rows } = await pool.query(
    `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
       FROM zzz_draft_sessions
      WHERE session_key = $1::text`,
    [key]
  );
  if (rows.length) push(key, "update", rows[0]);
}

/* ───────────────── Helpers ───────────────── */
function isValidState(s: any): boolean {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!Array.isArray(s.draftSequence) || s.draftSequence.length === 0) return false;
  if (!Number.isInteger(s.currentTurn) || s.currentTurn < 0) return false;
  if (!Array.isArray(s.picks) || s.picks.length !== s.draftSequence.length) return false;
  if (!Array.isArray(s.blueScores) || !Array.isArray(s.redScores)) return false;
  const okPicks = s.picks.every(
    (p: any) =>
      p === null ||
      (p &&
        typeof p === "object" &&
        typeof p.characterCode === "string" &&
        Number.isInteger(p.eidolon) &&
        Number.isInteger(p.superimpose))
  );
  return okPicks;
}

/* ───────────────── CREATE session ───────────────── */
router.post("/api/zzz/sessions", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { team1, team2, mode, state } = req.body || {};

  if (!team1 || !team2 || (mode !== "2v2" && mode !== "3v3") || !state || !isValidState(state)) {
    res.status(400).json({ error: "Missing or invalid body" });
    return;
  }

  const key = genKey(22);

  try {
    const { rows } = await pool.query(
      `INSERT INTO zzz_draft_sessions
         (session_key, owner_user_id, mode, team1, team2, state)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb)
       RETURNING mode, team1, team2, state, is_complete, last_activity_at, completed_at`,
      [key, viewer.id, mode, team1, team2, JSON.stringify(state)]
    );

    // Notify any early spectators (rare, but harmless)
    push(key, "update", rows[0]);

    const url = `${process.env.PUBLIC_BASE_URL || "https://cipher.uno"}/zzz/s/${key}`;
    res.json({ key, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* ───────────────── UPDATE session ───────────────── */
router.put("/api/zzz/sessions/:key", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { key } = req.params as { key: string };
  const { state, isComplete } = req.body || {};

  // Ownership check
  const owner = await pool.query(
    `SELECT owner_user_id FROM zzz_draft_sessions WHERE session_key = $1::text`,
    [key]
  );
  if (owner.rows.length === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (owner.rows[0].owner_user_id !== viewer.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Only update state if the key is present and the shape is valid
  const hasStateKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "state");
  const shouldUpdateState = hasStateKey && isValidState(state);
  const stateJson = shouldUpdateState ? JSON.stringify(state) : null;
  const isCompleteParam = typeof isComplete === "boolean" ? isComplete : null;

  try {
    const { rows } = await pool.query(
      `UPDATE zzz_draft_sessions
          SET state = COALESCE($2::jsonb, state),
              is_complete = COALESCE($3::boolean, is_complete),
              completed_at = CASE
                               WHEN $3::boolean IS TRUE AND completed_at IS NULL
                                 THEN now()
                               ELSE completed_at
                             END,
              last_activity_at = now()
        WHERE session_key = $1::text
        RETURNING mode, team1, team2, state, is_complete, last_activity_at, completed_at`,
      [key, stateJson, isCompleteParam]
    );

    if (rows.length) push(key, "update", rows[0]);
    res.json({ ok: true, stateUpdated: shouldUpdateState });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update session" });
  }
});

/* ───────────────── READ one session (public) ───────────────── */
router.get("/api/zzz/sessions/:key", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };
  try {
    const { rows } = await pool.query(
      `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
         FROM zzz_draft_sessions
        WHERE session_key = $1::text`,
      [key]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load session" });
  }
});

/* ───────────────── RECENT completed matches (public) ───────────────── */
router.get("/api/zzz/matches/recent", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 12;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        session_key,
        mode,
        team1,
        team2,
        state,
        is_complete,
        completed_at,
        last_activity_at
      FROM zzz_draft_sessions
      WHERE is_complete IS TRUE
      ORDER BY completed_at DESC NULLS LAST, last_activity_at DESC
      LIMIT $1::int
      `,
      [limit]
    );

    const data = rows.map((r) => ({
      key: r.session_key,
      mode: r.mode,
      team1: r.team1,
      team2: r.team2,
      state: r.state,
      completedAt: r.completed_at,
      lastActivityAt: r.last_activity_at,
    }));

    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch recent matches" });
  }
});

/* ───────────────── LIVE drafts (public) ───────────────── */
router.get("/api/zzz/matches/live", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(25, rawLimit)) : 8;

  const rawMinutes = Number(req.query.minutes);
  const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 2;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        session_key,
        mode,
        team1,
        team2,
        state,
        last_activity_at
      FROM zzz_draft_sessions
      WHERE is_complete IS NOT TRUE
        AND last_activity_at >= now() - ($2::int * INTERVAL '1 minute')
      ORDER BY last_activity_at DESC
      LIMIT $1::int
      `,
      [limit, minutes]
    );

    const data = rows.map((r) => ({
      key: r.session_key,
      mode: r.mode,
      team1: r.team1,
      team2: r.team2,
      state: r.state,
      lastActivityAt: r.last_activity_at,
    }));

    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch live drafts" });
  }
});

/* ───────────────── SSE stream (public) ───────────────── */
router.get("/api/zzz/sessions/:key/stream", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // avoid proxy buffering (nginx etc.)
  (res as any).flushHeaders?.(); // if available

  // Initial snapshot or not_found
  const { rows } = await pool.query(
    `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
       FROM zzz_draft_sessions
      WHERE session_key = $1::text`,
    [key]
  );
  if (rows.length === 0) {
    res.write("event: not_found\ndata: {}\n\n");
    res.end();
    return;
  }

  // Register client, send initial snapshot
  addClient(key, res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(rows[0])}\n\n`);

  // Heartbeat
  const ping = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
});

export default router;
