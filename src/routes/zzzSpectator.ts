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

router.post("/api/zzz/sessions", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { team1, team2, mode, state } = req.body || {};
  if (!team1 || !team2 || (mode !== "2v2" && mode !== "3v3") || !state) {
    res.status(400).json({ error: "Missing or invalid body" });
    return;
  }

  const key = genKey(22);

  await pool.query(
    `INSERT INTO zzz_draft_sessions
      (session_key, owner_user_id, mode, team1, team2, state)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [key, viewer.id, mode, team1, team2, JSON.stringify(state)] // jsonb: stringify
  );

  const url = `${process.env.PUBLIC_BASE_URL || "https://cipher.uno"}/zzz/s/${key}`;
  res.json({ key, url });
});

router.put("/api/zzz/sessions/:key", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { key } = req.params as { key: string };
  const { state, isComplete } = req.body || {};

  const { rows } = await pool.query(
    `SELECT owner_user_id FROM zzz_draft_sessions WHERE session_key = $1`,
    [key]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (rows[0].owner_user_id !== viewer.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await pool.query(
    `UPDATE zzz_draft_sessions
       SET state = $2,
           is_complete = COALESCE($3, is_complete),
           completed_at = CASE WHEN $3 IS TRUE AND completed_at IS NULL THEN now() ELSE completed_at END,
           last_activity_at = now()
     WHERE session_key = $1`,
    [key, JSON.stringify(state ?? {}), isComplete === true ? true : null] // jsonb: stringify
  );

  res.json({ ok: true });
});

router.get("/api/zzz/sessions/:key", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };
  const { rows } = await pool.query(
    `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
       FROM zzz_draft_sessions
      WHERE session_key = $1`,
    [key]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(rows[0]);
});

export default router;
