// routes/announcement.ts
import express from "express";
import { pool } from "../db";

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const result = await pool.query("SELECT message FROM announcement LIMIT 1");
    res.json({ message: result.rows[0]?.message ?? null });
  } catch (err) {
    console.error("Error fetching announcement:", err);
    res.status(500).json({ error: "Failed to load announcement" });
  }
});

export default router;
