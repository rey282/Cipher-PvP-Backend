import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { CHARACTER_TABLE_MAP } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour

// GET /api/characters?cycle=0
router.get("/api/characters", async (req, res) => {
  const cycle = req.query.cycle || "0";
  const table = CHARACTER_TABLE_MAP[cycle as string] ?? "characters";
  const cacheKey = `characters_${cycle}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const q = `
    SELECT code, name, subname, rarity, image_url, path, element,
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
    const data = rows.map(r => ({
      ...r,
      subname: r.subname ?? null
    }));
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

  const unionQuery = Object.values(CHARACTER_TABLE_MAP)
    .map((table) => `SELECT * FROM ${table}`)
    .join(" UNION ALL ");

  const q = `
    WITH u AS (
      ${unionQuery}
    ),
    agg AS (
      SELECT
        code,
        SUM(appearance_count)::int AS appearance_count,
        SUM(pick_count)::int       AS pick_count,
        SUM(ban_count)::int        AS ban_count,
        SUM(preban_count)::int     AS preban_count,
        SUM(joker_count)::int      AS joker_count,

        SUM(e0_uses)::int AS e0_uses, SUM(e0_wins)::int AS e0_wins,
        SUM(e1_uses)::int AS e1_uses, SUM(e1_wins)::int AS e1_wins,
        SUM(e2_uses)::int AS e2_uses, SUM(e2_wins)::int AS e2_wins,
        SUM(e3_uses)::int AS e3_uses, SUM(e3_wins)::int AS e3_wins,
        SUM(e4_uses)::int AS e4_uses, SUM(e4_wins)::int AS e4_wins,
        SUM(e5_uses)::int AS e5_uses, SUM(e5_wins)::int AS e5_wins,
        SUM(e6_uses)::int AS e6_uses, SUM(e6_wins)::int AS e6_wins
      FROM u
      GROUP BY code
    ),
    labels AS (
      SELECT DISTINCT ON (code)
        code, name, subname, rarity, image_url, path, element
      FROM u
      ORDER BY code
    )
    SELECT
      l.code, l.name, l.subname, l.rarity, l.image_url, l.path, l.element,
      a.*,
      (a.e0_uses+a.e1_uses+a.e2_uses+a.e3_uses+a.e4_uses+a.e5_uses+a.e6_uses) AS total_uses,
      (a.e0_wins+a.e1_wins+a.e2_wins+a.e3_wins+a.e4_wins+a.e5_wins+a.e6_wins) AS total_wins,
      (
        (a.e0_uses+a.e1_uses+a.e2_uses+a.e3_uses+a.e4_uses+a.e5_uses+a.e6_uses) -
        (a.e0_wins+a.e1_wins+a.e2_wins+a.e3_wins+a.e4_wins+a.e5_wins+a.e6_wins)
      ) AS total_losses
    FROM agg a
    JOIN labels l USING (code)
    ORDER BY appearance_count DESC;
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
    console.error("DB error (characters/all)", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

export default router;
