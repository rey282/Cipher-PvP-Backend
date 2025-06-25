
import express, { Request, Response } from "express";
import { pool } from "../db";

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
        const result = await pool.query(
          `
          UPDATE players
             SET points = $1
           WHERE discord_id = $2;
          `,
          [points, discordId]
        );
      
        if (result.rowCount === 0) {
          res.status(200).json({ success: false, message: "Player not found, no update performed" });
          return;
        }
      
        res.status(200).json({ success: true });
      } catch (err) {
        console.error("Error in /api/player/roster:", err);
        res.status(500).json({ error: "Internal server error" });
      }
      
  }
);

export default router;
