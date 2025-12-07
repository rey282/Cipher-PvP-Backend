import express, { Request, Response } from "express";
import { pool } from "../db";
import fetch from "node-fetch";

const router = express.Router();
const ROSTER_SECRET = process.env.ROSTER_SECRET_KEY;

type ManualPointUpdate = {
  discordId: string;
  points: number;
};

router.post(
  "/api/player/roster",
  async (
    req: Request<{}, {}, ManualPointUpdate>,
    res: Response
  ) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${ROSTER_SECRET}`) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { discordId, points } = req.body;

    if (!discordId || typeof points !== "number" || points < 0) {
      res.status(400).json({ error: "Missing or invalid fields" });
      return;
    }

    try {
      //Fetch old points first
      const { rows } = await pool.query(
        `SELECT points FROM players WHERE discord_id = $1;`,
        [discordId]
      );

      if (rows.length === 0) {
        res.status(200).json({
          success: false,
          message: "Player not found, no update performed",
        });
        return;
      }

      const oldPoints = rows[0].points;

      //Update player points
      await pool.query(
        `UPDATE players SET points = $1 WHERE discord_id = $2;`,
        [points, discordId]
      );

      //Log change with old + new points
      await pool.query(
        `INSERT INTO roster_log (discord_id, old_points, new_points, submitted_at)
         VALUES ($1, $2, $3, NOW());`,
        [discordId, oldPoints, points]
      );

      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Error in /api/player/roster:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Proxy getUsers from draft-api.cipher.uno to avoid CORS
router.get('/api/roster/users', async (_req, res) => {
  try {
    const response = await fetch(`${process.env.YANYAN_API_URL}/getUsers`);
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Failed to fetch roster users", err);
    res.status(500).json({ error: 'Failed to fetch roster users' });
  }
});

export default router;
