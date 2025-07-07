import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour

// Map for character table per cycle
const tableMap: Record<string, string> = {
  "0": "characters",
  "1": "characters_1",
  "2": "characters_2"
};

// GET /api/characters?cycle=0
router.get("/api/characters", async (req, res) => {
  const cycle = req.query.cycle || "0";
  const table = tableMap[cycle as string] ?? "characters";
  const cacheKey = `characters_${cycle}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const q = `
    SELECT code, name, rarity, image_url, path, element,
           appearance_count, pick_count, ban_count,
           preban_count, joker_count,
           e0_uses, e1_uses, e2_uses, e3_uses, e4_uses, e5_uses, e6_uses,
           e0_wins, e1_wins, e2_wins, e3_wins, e4_wins, e5_wins, e6_wins,
           (e0_uses+e1_uses+e2_uses+e3_uses+e4_uses+e5_uses+e6_uses) AS total_uses,
           (e0_wins+e1_wins+e2_wins+e3_wins+e4_wins+e5_wins+e6_wins) AS total_wins,
           (e0_uses+e1_uses+e2_uses+e3_uses+e4_uses+e5_uses+e6_uses) -
           (e0_wins+e1_wins+e2_wins+e3_wins+e4_wins+e5_wins+e6_wins) AS total_losses
    FROM ${table}
    ORDER BY appearance_count DESC;
  `;

  try {
    const { rows } = await pool.query(q);
    const response = { data: rows, lastFetched: new Date().toISOString() };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (characters)", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

// GET /api/characters/all
router.get("/api/characters/all", async (_req, res) => {
  const cacheKey = "characters_all";
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const q = `
    WITH u AS (
      SELECT * FROM characters
      UNION ALL
      SELECT * FROM characters_1
      UNION ALL
      SELECT * FROM characters_2
    ),
    grouped AS (
      SELECT
        code, name, rarity, image_url, path, element,
        COALESCE(SUM(appearance_count),0)::int AS appearance_count,
        COALESCE(SUM(pick_count)      ,0)::int AS pick_count,
        COALESCE(SUM(ban_count)       ,0)::int AS ban_count,
        COALESCE(SUM(preban_count)    ,0)::int AS preban_count,
        COALESCE(SUM(joker_count)     ,0)::int AS joker_count,
        COALESCE(SUM(e0_uses),0)::int AS e0_uses,  COALESCE(SUM(e0_wins),0)::int AS e0_wins,
        COALESCE(SUM(e1_uses),0)::int AS e1_uses,  COALESCE(SUM(e1_wins),0)::int AS e1_wins,
        COALESCE(SUM(e2_uses),0)::int AS e2_uses,  COALESCE(SUM(e2_wins),0)::int AS e2_wins,
        COALESCE(SUM(e3_uses),0)::int AS e3_uses,  COALESCE(SUM(e3_wins),0)::int AS e3_wins,
        COALESCE(SUM(e4_uses),0)::int AS e4_uses,  COALESCE(SUM(e4_wins),0)::int AS e4_wins,
        COALESCE(SUM(e5_uses),0)::int AS e5_uses,  COALESCE(SUM(e5_wins),0)::int AS e5_wins,
        COALESCE(SUM(e6_uses),0)::int AS e6_uses,  COALESCE(SUM(e6_wins),0)::int AS e6_wins
      FROM u
      GROUP BY code, name, rarity, image_url, path, element
    )
    SELECT *,
           (e0_uses+e1_uses+e2_uses+e3_uses+e4_uses+e5_uses+e6_uses)::int AS total_uses,
           (e0_wins+e1_wins+e2_wins+e3_wins+e4_wins+e5_wins+e6_wins)::int AS total_wins,
           (e0_uses+e1_uses+e2_uses+e3_uses+e4_uses+e5_uses+e6_uses
          - e0_wins-e1_wins-e2_wins-e3_wins-e4_wins-e5_wins-e6_wins)::int AS total_losses
    FROM grouped
    ORDER BY appearance_count DESC;
  `;

  try {
    const { rows } = await pool.query(q);
    const response = {
      data: rows,
      lastFetched: new Date().toISOString()
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (characters/all)", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

export default router;
