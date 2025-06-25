// routes/roster.ts
import express, { Request, Response } from "express";
import { pool } from "../db";

const router = express.Router();
const ROSTER_SECRET = process.env.ROSTER_SECRET_KEY;

/* -------- types -------- */
type RosterUpdateBody = {
  discordId: string;
  profileCharacters: { id: string; eidolon: number }[];
};

/* -------- POST /api/player/roster -------- */
router.post(
  "/api/player/roster",
  async (
    req: Request<{}, {}, RosterUpdateBody>,
    res: Response
  ): Promise<void> => {
    /* 🔐 ── shared-secret auth ─────────────────────────── */
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${ROSTER_SECRET}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    /* ── validate body ────────────────────────────────── */
    const { discordId, profileCharacters } = req.body;
    if (!discordId || !Array.isArray(profileCharacters)) {
      res.status(400).json({ error: "Missing or invalid fields" });
      return;
    }

    try {
      /* 1. grab cost map (id ➜ [E0…E6]) */
      const { rows } = await pool.query<{ id: string; costs: number[] }>(
        "SELECT id, costs FROM balance_costs"
      );
      const costMap: Record<string, number[]> = {};
      rows.forEach((r) => (costMap[r.id] = r.costs));

      /* 2. compute total points */
      let total = 0;
      for (const { id, eidolon } of profileCharacters) {
        const costs = costMap[id];
        if (!costs) continue; // unknown char → 0 pts
        const e = Math.min(Math.max(eidolon, 0), 6);
        total += costs[e];
      }

      /* 3. upsert into players table */
      await pool.query(
        `
        INSERT INTO players (discord_id, points, updated_at)
             VALUES ($1, $2, NOW())
        ON CONFLICT (discord_id)
        DO UPDATE SET points = EXCLUDED.points,
                      updated_at = NOW();
        `,
        [discordId, total]
      );

      res.status(200).json({ success: true, points: total });
      return;
    } catch (err) {
      console.error("Error in /api/player/roster:", err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
  }
);

export default router;
