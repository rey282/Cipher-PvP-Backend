import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { requireAdmin } from "../middleware/requireAdmin";
import { seasonFromQuery } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60 });

/* ─────────── GET /api/admin/matches ─────────── */
router.get("/api/admin/matches", requireAdmin, async (req, res) => {
  const limit = Math.max(Number(req.query.limit) || 100, 1);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const season = seasonFromQuery(req.query.season);
  const cacheKey = `admin_matches_${season.table || "all"}`;

  if (offset === 0) {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }
  }

  const params: any[] = [];
  let whereClause = `WHERE m.has_character_data = TRUE`;

  if (season.start) {
    params.push(season.start, season.end ?? new Date().toISOString());
    whereClause = `WHERE m.timestamp BETWEEN $1 AND $2 AND m.has_character_data = TRUE`;
  }

  try {
    const countSQL = `
      SELECT COUNT(*) AS total
      FROM matches m
      ${whereClause}
    `;
    const { rows: [cnt] } = await pool.query(countSQL, params);
    const total = Number(cnt?.total || 0);

    params.push(limit, offset);

    const listSQL = `
      SELECT match_id, timestamp, raw_data
      FROM matches m
      ${whereClause}
      ORDER BY match_id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;
    const { rows } = await pool.query(listSQL, params);

    const matches = rows.map((r: any) => {
      const rd = r.raw_data;
      const redNames = (rd.red_team || []).map((m: any) => m.name);
      const blueNames = (rd.blue_team || []).map((m: any) => m.name);

      const dateISO = rd.date && !isNaN(Date.parse(rd.date))
        ? new Date(rd.date).toISOString()
        : r.timestamp?.toISOString();

      const redBans = [...(rd.red_bans || [])];
      const blueBans = [...(rd.blue_bans || [])];
      if (redBans.length > 1 && blueBans.length > 1) {
        [redBans[1], blueBans[1]] = [blueBans[1], redBans[1]];
      }

      return {
        matchId: r.match_id,
        date: dateISO,
        winner: rd.winner,
        redTeam: redNames,
        blueTeam: blueNames,
        redPicks: (rd.red_picks || []).map((c: any) => c.code),
        bluePicks: (rd.blue_picks || []).map((c: any) => c.code),
        redBans: redBans.map((b: any) => b.code),
        blueBans: blueBans.map((b: any) => b.code),
        prebans: rd.prebans || [],
        jokers: rd.jokers || [],
        redCycles: (rd.red_team || []).map((m: any) => m.cycles || 0),
        blueCycles: (rd.blue_team || []).map((m: any) => m.cycles || 0),
        redCyclePenalty: rd.red_penalty || 0,
        blueCyclePenalty: rd.blue_penalty || 0,
      };
    });

    const response = {
      data: matches,
      total,
      lastFetched: new Date().toISOString(),
      seasonLabel: season.label,
    };

    if (offset === 0) {
      cache.set(cacheKey, response, 60);
    }

    res.json(response);
  } catch (err) {
    console.error("DB error (admin matches)", err);
    res.status(500).json({ error: "Failed to fetch admin match history" });
  }
});

/* ─────────── POST /api/admin/matches/refresh ─────────── */
router.post("/api/admin/matches/refresh", requireAdmin, (req, res) => {
  cache.keys().forEach((key) => {
    if (key.startsWith("admin_matches_")) {
      cache.del(key);
    }
  });
  res.json({ success: true });
});

/* ─────────── POST /api/admin/rollback/:matchId ─────────── */
router.post("/api/admin/rollback/:matchId", requireAdmin, async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (isNaN(matchId)) {
    res.status(400).json({ error: "Invalid match ID" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT elo_gains, raw_data FROM matches WHERE match_id = $1 AND has_character_data = TRUE",
      [matchId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const match = rows[0];
    const raw = typeof match.raw_data === "string" ? JSON.parse(match.raw_data) : match.raw_data;
    const eloGains = match.elo_gains;
    const winner = raw.winner;
    const seen = new Set<string>();

    // Revert ELO
    for (const [playerId, gain] of Object.entries(eloGains)) {
      const gainNum = Number(gain);
      if (isNaN(gainNum)) continue;

      await client.query(
        `UPDATE players SET 
          elo = elo - $1,
          games_played = GREATEST(games_played - 1, 0),
          win_rate = CASE
            WHEN games_played - 1 <= 0 THEN 0
            WHEN $1 > 0 THEN ((win_rate * games_played - 1) / GREATEST(games_played - 1, 1))
            ELSE ((win_rate * games_played) / GREATEST(games_played - 1, 1))
          END
         WHERE discord_id = $2`,
        [gainNum, playerId]
      );
    }

    // Revert character stats
    for (const teamKey of ["red_picks", "blue_picks"]) {
      const picks = raw[teamKey] || [];
      const teamWon = (teamKey === "red_picks" && winner === "red") || (teamKey === "blue_picks" && winner === "blue");

      for (const pick of picks) {
        const { code, eidolon } = pick;
        if (!code || eidolon === undefined) continue;

        if (!seen.has(code)) {
          seen.add(code);
          await client.query(`UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1`, [code]);
        }

        await client.query(`UPDATE characters SET pick_count = GREATEST(pick_count - 1, 0) WHERE code = $1`, [code]);
        await client.query(`UPDATE characters SET e${eidolon}_uses = GREATEST(e${eidolon}_uses - 1, 0) WHERE code = $1`, [code]);

        if (teamWon) {
          await client.query(`UPDATE characters SET e${eidolon}_wins = GREATEST(e${eidolon}_wins - 1, 0) WHERE code = $1`, [code]);
        }
      }
    }

    for (const teamKey of ["red_bans", "blue_bans"]) {
      const bans = raw[teamKey] || [];
      for (const ban of bans) {
        const code = ban.code;
        if (!code) continue;
        if (!seen.has(code)) {
          seen.add(code);
          await client.query(`UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1`, [code]);
        }
        await client.query(`UPDATE characters SET ban_count = GREATEST(ban_count - 1, 0) WHERE code = $1`, [code]);
      }
    }

    for (const [field, column] of [["prebans", "preban_count"], ["jokers", "joker_count"]] as const) {
      for (const code of raw[field] || []) {
        if (!seen.has(code)) {
          seen.add(code);
          await client.query(`UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1`, [code]);
        }
        await client.query(`UPDATE characters SET ${column} = GREATEST(${column} - 1, 0) WHERE code = $1`, [code]);
      }
    }

    await client.query("DELETE FROM matches WHERE match_id = $1", [matchId]);
    await client.query("COMMIT");

    res.json({ success: true, message: "Match rollback successful." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Rollback failed:", err);
    res.status(500).json({ error: "Failed to rollback match" });
  } finally {
    client.release();
  }
});

/* ─────────── GET /api/admin/roster-log ─────────── */
router.get("/api/admin/roster-log", requireAdmin, async (req, res) => {
  const { discordId, name } = req.query;

  let query = `
    SELECT rl.id, rl.discord_id, rl.old_points, rl.new_points, rl.submitted_at,
           du.username, du.global_name
      FROM roster_log rl
 LEFT JOIN discord_usernames du ON rl.discord_id = du.discord_id
  `;

  const params: any[] = [];
  const conditions: string[] = [];

  if (discordId) {
    params.push(discordId);
    conditions.push(`rl.discord_id = $${params.length}`);
  }

  if (name) {
    params.push(`%${name}%`);
    conditions.push(`(du.username ILIKE $${params.length} OR du.global_name ILIKE $${params.length})`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  query += ` ORDER BY rl.submitted_at DESC`;

  try {
    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching roster log:", err);
    res.status(500).json({ error: "Failed to fetch roster log" });
  }
});

  

export default router;
