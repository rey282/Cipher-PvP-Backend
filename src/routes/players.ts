import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { SEASONS, seasonFromQuery, SeasonKey } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });

// GET /api/players
router.get("/api/players", async (req, res) => {
  const seasonKey = String(req.query.season);
  const season = seasonFromQuery(seasonKey);
  const cacheKey = `player_stats_${season.table || "all"}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  let q: string;
  let totalMatches = 0;

  try {
    if (season.table) {
      q = `
        SELECT p.discord_id,
               COALESCE(d.global_name, d.username, p.nickname) AS username,
               p.nickname,
               p.elo,
               p.games_played,
               p.win_rate,
               p.points,
               p.description,
               p.color,
               p.banner_url
        FROM ${season.table} p
   LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
    ORDER BY p.elo DESC;
      `;

      const matchCount = await pool.query(
        season.start && !season.end
          ? `SELECT COUNT(*) FROM matches WHERE timestamp >= $1`
          : season.start && season.end
          ? `SELECT COUNT(*) FROM matches WHERE timestamp BETWEEN $1 AND $2`
          : `SELECT COUNT(*) FROM matches`,
        season.start
          ? season.end
            ? [season.start, season.end]
            : [season.start]
          : []
      );
      totalMatches = Number(matchCount.rows[0].count || 0);
    } else {
      const unionSQL = Object.values(SEASONS)
        .filter((s) => s.table)
        .map((s) => `SELECT * FROM ${s.table}`)
        .join(" UNION ALL ");

      q = `
        WITH u AS (${unionSQL})
        SELECT u.discord_id,
               MAX(COALESCE(d.global_name, d.username, u.nickname)) AS username,
               MAX(u.nickname)                               AS nickname,
               AVG(u.elo)                                    AS elo,
               SUM(u.games_played)::int                      AS games_played,
               SUM(u.win_rate * u.games_played)
                 / NULLIF(SUM(u.games_played), 0)            AS win_rate,
               MAX(u.points)                                 AS points,
               MAX(u.description)                            AS description,
               MAX(u.color)                                  AS color,
               MAX(u.banner_url)                             AS banner_url
        FROM u
   LEFT JOIN discord_usernames d ON u.discord_id = d.discord_id
    GROUP BY u.discord_id
    ORDER BY elo DESC;
      `;

      const matchCount = await pool.query(`SELECT COUNT(*) FROM matches`);
      totalMatches = Number(matchCount.rows[0].count || 0);
    }

    const { rows } = await pool.query(q);
    const response = {
      data: rows,
      totalMatches,
      lastFetched: new Date().toISOString(),
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (players)", err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// GET /api/player/:id
router.get("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const seasonKey = String(req.query.season ?? "players") as SeasonKey;
  const season = seasonFromQuery(seasonKey);
  const cacheKey = `player_profile_${id}_season_${seasonKey}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    let rows: any[] = [];

    if (season.table) {
      const sql = `
        SELECT
          pf.discord_id,
          COALESCE(d.global_name, d.username, pf.nickname) AS display_name,
          d.username,
          d.avatar,
          COALESCE(ps.elo, 0)           AS elo,
          COALESCE(ps.games_played, 0)  AS games_played,
          COALESCE(ps.win_rate, 0)      AS win_rate,
          pf.description,
          pf.banner_url,
          pf.color
        FROM players pf
   LEFT JOIN discord_usernames d  ON pf.discord_id = d.discord_id
   LEFT JOIN ${season.table} ps   ON pf.discord_id = ps.discord_id
       WHERE pf.discord_id = $1
       LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));
    } else {
      const unionSQL = Object.values(SEASONS)
        .filter((s) => s.table)
        .map((s) => `SELECT * FROM ${s.table}`)
        .join(" UNION ALL ");

      const sql = `
        WITH u AS (${unionSQL})
        SELECT p.discord_id,
               COALESCE(d.global_name, d.username, p.nickname) AS display_name,
               d.username,
               d.avatar,
               AVG(u.elo) AS elo,
               SUM(u.games_played)::int AS games_played,
               COALESCE(
                 SUM(u.win_rate * u.games_played)
                 / NULLIF(SUM(u.games_played), 0), 0) AS win_rate,
               p.description,
               p.banner_url,
               p.color
        FROM players p
   LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
   LEFT JOIN u ON p.discord_id = u.discord_id
       WHERE p.discord_id = $1
    GROUP BY p.discord_id, d.global_name, d.username, d.avatar,
             p.nickname, p.description, p.banner_url, p.color
       LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));
    }

    if (!rows.length) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    cache.set(cacheKey, rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error("DB error (player)", err);
    res.status(500).json({ error: "Failed to fetch player" });
  }
});

// PATCH /api/player/:id
router.patch("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const { description, banner_url } = req.body as {
    description?: string;
    banner_url?: string;
  };

  const viewer = req.user as { id?: string } | undefined;

  if (!viewer || viewer.id !== id) {
    const result = await pool.query(
      `SELECT 1 FROM admin_users WHERE discord_id = $1`,
      [viewer?.id]
    );
    const isAdmin = (result?.rowCount ?? 0) > 0;
    if (!isAdmin) {
      res.sendStatus(403);
      return;
    }
  }

  if (description === undefined && banner_url === undefined) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  try {
    const sql = `
      UPDATE players
         SET description = COALESCE($2, description),
             banner_url  = COALESCE($3, banner_url)
       WHERE discord_id = $1
   RETURNING description, banner_url;
    `;
    const { rows } = await pool.query(sql, [
      id,
      description ?? null,
      banner_url ?? null,
    ]);

    // Invalidate all seasonal cache versions
    (Object.keys(SEASONS) as SeasonKey[]).forEach((k) =>
      cache.del(`player_profile_${id}_season_${k}`)
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("DB error (patch player)", err);
    res.status(500).json({ error: "Failed to update player" });
  }
});

export default router;
