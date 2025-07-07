import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { seasonFromQuery } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes

// GET /api/insights
router.get("/api/insights", async (req, res) => {
  const seasonKey = req.query.season as string;
  const season = seasonFromQuery(seasonKey);
  const cacheKey = `hsr_insights_${seasonKey || "players"}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const whereClauses: string[] = ["has_character_data = TRUE"];
    const values: any[] = [];

    if (season.start) {
      values.push(season.start);
      whereClauses.push(`timestamp >= $${values.length}`);
    }
    if (season.end) {
      const endDate = new Date(season.end);
      endDate.setDate(endDate.getDate() + 1);
      values.push(endDate.toISOString().slice(0, 10));
      whereClauses.push(`timestamp < $${values.length}`);
    }

    const query = `
      SELECT 
        timestamp,
        raw_data->'red_team'  AS red_team,
        raw_data->'blue_team' AS blue_team,
        raw_data->'prebans'   AS prebans,
        raw_data->'jokers'    AS jokers,
        COALESCE((raw_data->>'red_penalty')::int, 0)  AS red_penalty,
        COALESCE((raw_data->>'blue_penalty')::int, 0) AS blue_penalty
      FROM matches
      WHERE ${whereClauses.join(" AND ")}
    `;

    const { rows } = await pool.query(query, values);

    let totalMatches = 0;
    let totalCycles = 0;
    let total15cCycles = 0;
    let totalPrebans = 0;
    let totalPenalties = 0;

    const matchesByDay: Record<string, number> = {};

    for (const row of rows) {
      const date = new Date(row.timestamp).toISOString().slice(0, 10);
      matchesByDay[date] = (matchesByDay[date] || 0) + 1;
      totalMatches++;

      const redTeam = row.red_team ?? [];
      const blueTeam = row.blue_team ?? [];
      const allCycles = [...redTeam, ...blueTeam].map((m: any) => m.cycles || 0);

      totalCycles += allCycles.filter((v: number) => v !== 15).reduce((a, b) => a + b, 0);
      total15cCycles += allCycles.filter((v: number) => v === 15).length;

      totalPrebans += (row.prebans?.length || 0) + (row.jokers?.length || 0);
      totalPenalties += row.red_penalty + row.blue_penalty;
    }

    const response = {
      averageCyclesPerMatch: totalMatches ? totalCycles / (totalMatches * 2) : 0,
      averagePrebansPerMatch: totalMatches ? totalPrebans / totalMatches : 0,
      averagePenaltyPerMatch: totalMatches ? totalPenalties / totalMatches : 0,
      matchesByDay,
      totalMatches,
      total15cCycles,
      lastFetched: new Date().toISOString(),
    };

    cache.set(cacheKey, response, 600);
    res.json(response);
  } catch (err) {
    console.error("Error generating insights:", err);
    res.status(500).json({ error: "Failed to load insights" });
  }
});

export default router;
