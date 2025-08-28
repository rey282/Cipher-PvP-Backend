// routes/zzzSpectator.ts
import express, { RequestHandler } from "express";
import { pool } from "../db";
import { genKey } from "../utils/genKey";

const router = express.Router();

const requireLogin: RequestHandler = (req, res, next) => {
  const viewer = (req as any).user as { id?: string } | undefined;
  if (!viewer?.id) {
    res.status(401).json({ error: "Not logged in" });
    return; // important: return void, not Response
  }
  next();
};

/* ───────────────── CREATE session ───────────────── */
router.post(
  "/api/zzz/sessions",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };
    const { team1, team2, mode, state } = req.body || {};

    if (!team1 || !team2 || (mode !== "2v2" && mode !== "3v3") || !state) {
      res.status(400).json({ error: "Missing or invalid body" });
      return;
    }

    const key = genKey(22);

    try {
      await pool.query(
        `INSERT INTO zzz_draft_sessions
           (session_key, owner_user_id, mode, team1, team2, state)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb)`,
        [key, viewer.id, mode, team1, team2, JSON.stringify(state)]
      );
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    const url = `${process.env.PUBLIC_BASE_URL || "https://cipher.uno"}/zzz/s/${key}`;
    res.json({ key, url });
  }
);

// ───────────────── UPDATE session ─────────────────
router.put("/api/zzz/sessions/:key", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { key } = req.params as { key: string };
  const { state, isComplete } = req.body || {};

  // Ownership
  const owner = await pool.query(
    `SELECT owner_user_id
       FROM zzz_draft_sessions
      WHERE session_key = $1::text`,
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

  // ---- validate state shape (only accept real ZZZ draft states) ----
  const hasStateKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "state");

  const isValidState = (s: any) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    if (!Array.isArray(s.draftSequence) || s.draftSequence.length === 0) return false;
    if (!Number.isInteger(s.currentTurn) || s.currentTurn < 0) return false;
    if (!Array.isArray(s.picks) || s.picks.length !== s.draftSequence.length) return false;
    if (!Array.isArray(s.blueScores) || !Array.isArray(s.redScores)) return false;
    // basic element checks
    const okPicks = s.picks.every(
      (p: any) =>
        p === null ||
        (p &&
          typeof p === "object" &&
          typeof p.characterCode === "string" &&
          Number.isInteger(p.eidolon) &&
          Number.isInteger(p.superimpose))
    );
    if (!okPicks) return false;
    return true;
  };

  const shouldUpdateState = hasStateKey && isValidState(state);
  const stateJson = shouldUpdateState ? JSON.stringify(state) : null;

  const isCompleteParam = typeof isComplete === "boolean" ? isComplete : null;

  try {
    await pool.query(
      `UPDATE zzz_draft_sessions
          SET state = COALESCE($2::jsonb, state),
              is_complete = COALESCE($3::boolean, is_complete),
              completed_at = CASE
                               WHEN $3::boolean IS TRUE AND completed_at IS NULL
                                 THEN now()
                               ELSE completed_at
                             END,
              last_activity_at = now()
        WHERE session_key = $1::text`,
      [key, stateJson, isCompleteParam]
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update session" });
    return;
  }

  res.json({ ok: true, stateUpdated: shouldUpdateState });
});

/* ───────────────── READ one session (public) ───────────────── */
router.get(
  "/api/zzz/sessions/:key",
  async (req, res): Promise<void> => {
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
  }
);

/* ───────────────── RECENT completed matches (public) ───────────────── */
router.get(
  "/api/zzz/matches/recent",
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(50, rawLimit))
      : 12;

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
        state: r.state, // jsonb
        completedAt: r.completed_at,
        lastActivityAt: r.last_activity_at,
      }));

      res.json({ data });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch recent matches" });
    }
  }
);

/* ───────────────── LIVE (ongoing) drafts (public) ───────────────── */
router.get(
  "/api/zzz/matches/live",
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(25, rawLimit))
      : 8;

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
        state: r.state, // jsonb
        lastActivityAt: r.last_activity_at,
      }));

      res.json({ data });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch live drafts" });
    }
  }
);

export default router;
