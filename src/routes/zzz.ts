// src/routes/zzz.ts
import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour

/* ───────────── GET /api/zzz/characters ───────────── */
router.get("/characters", async (_req, res) => {
  const cacheKey = "zzz_characters_all";
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const q = `
    SELECT code, name, subname, rarity, image_url, limited
    FROM zzz_characters
    ORDER BY rarity DESC, name ASC
  `;

  try {
    const { rows } = await pool.query(q);
    const response = {
      data: rows,
      lastFetched: new Date().toISOString(),
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (zzz_characters)", err);
    res.status(500).json({ error: "Failed to fetch ZZZ characters" });
  }
});

/* ───────────── GET /api/zzz/wengines ───────────── */
router.get("/wengines", async (_req, res) => {
  const cacheKey = "zzz_wengines_all";
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const q = `
    SELECT id, name, subname, rarity, image_url, limited
    FROM zzz_wengine
    ORDER BY rarity DESC, name ASC
  `;

  try {
    const { rows } = await pool.query(q);
    const response = {
      data: rows,
      lastFetched: new Date().toISOString(),
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (zzz_wengines)", err);
    res.status(500).json({ error: "Failed to fetch ZZZ W-Engines" });
  }
});


export default router;
