import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { seasonFromQuery } from "../utils/seasons";
import { matchLimiter } from "../middleware/rateLimiters";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour

// GET /api/player/:id/matches
router.get("/api/player/:id/matches", matchLimiter, async (req, res) => {
  const playerId = req.params.id;
  const limit = Math.max(Number(req.query.limit) || 15, 1);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const mode = String(req.query.mode || "all");
  const season = seasonFromQuery(req.query.season);

  // Build a unique cache key per player/season/mode/pagination
  const cacheKey = `player_matches:${playerId}:${season.label}:${mode}:${limit}:${offset}`;
  const cached = cache.get(cacheKey);
    if (cached) {
    res.json(cached); 
    return;
    }


  const params: any[] = [playerId];
  let dateClause = "";

  if (season.start) {
    dateClause = `AND m.timestamp BETWEEN $2 AND $3`;
    params.push(season.start, season.end ?? new Date().toISOString());
  }

  const modeIdx = params.length + 1;
  const limitIdx = modeIdx + 1;
  const offsetIdx = modeIdx + 2;
  params.push(mode, limit, offset);

  try {
    const countSQL = `WITH player_matches AS (
      SELECT (
        SELECT COUNT(*)
        FROM jsonb_array_elements(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM jsonb_array_elements(raw_data->'red_team') t
              WHERE t->>'id'=$1
            ) THEN raw_data->'red_team'
            ELSE raw_data->'blue_team'
          END
        ) elem
        WHERE elem->>'id'=$1
      ) AS self_count
      FROM matches m
      WHERE m.has_character_data = TRUE
        AND (
             EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team')  t WHERE t->>'id'=$1)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id'=$1)
        )
        ${dateClause}
    )
    SELECT COUNT(*)
    FROM player_matches
    WHERE (
          $${modeIdx} = 'all'
       OR ($${modeIdx} = 'solo' AND self_count > 1)
       OR ($${modeIdx} = 'duo'  AND self_count = 1)
    );`;

    const { rows: [cnt] } = await pool.query(countSQL, params.slice(0, modeIdx));
    const total = Number(cnt?.count || 0);

    const listSQL = `WITH player_matches AS (
      SELECT
        match_id,
        timestamp,
        raw_data,
        (
          SELECT COUNT(*)
          FROM jsonb_array_elements(
            CASE
              WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(raw_data->'red_team') t
                WHERE t->>'id'=$1
              ) THEN raw_data->'red_team'
              ELSE raw_data->'blue_team'
            END
          ) elem
          WHERE elem->>'id'=$1
        ) AS self_count
      FROM matches m
      WHERE m.has_character_data = TRUE
        AND (
             EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team')  t WHERE t->>'id'=$1)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id'=$1)
        )
        ${dateClause}
    )
    SELECT match_id, timestamp, raw_data
    FROM player_matches
    WHERE (
          $${modeIdx} = 'all'
       OR ($${modeIdx} = 'solo' AND self_count > 1)
       OR ($${modeIdx} = 'duo'  AND self_count = 1)
    )
    ORDER BY match_id DESC
    LIMIT  $${limitIdx}
    OFFSET $${offsetIdx};`;

    const { rows } = await pool.query(listSQL, params);

    const matches = rows.map((r: any) => {
      const rd = r.raw_data;
      const isRed = (rd.red_team || []).some((m: any) =>
        String(m?.id ?? m["id"]) === String(playerId)
      );
      const myTeam = isRed ? "red" : "blue";
      const oppTeam = isRed ? "blue" : "red";

      const uniq = <T>(arr: T[]) => [...new Set(arr)];
      const teammateNames = uniq(rd[`${myTeam}_team`].filter((m: any) => m.id !== playerId).map((m: any) => m.name));
      const opponentNames = uniq(rd[`${oppTeam}_team`].map((m: any) => m.name));

      const dateISO = rd.date && !isNaN(Date.parse(rd.date))
        ? new Date(rd.date).toISOString()
        : r.timestamp?.toISOString();

      const myBansRaw = [...(rd[`${myTeam}_bans`] || [])];
      const oppBansRaw = [...(rd[`${oppTeam}_bans`] || [])];
      if (myBansRaw.length > 1 && oppBansRaw.length > 1) {
        const tmp = myBansRaw[1];
        myBansRaw[1] = oppBansRaw[1];
        oppBansRaw[1] = tmp;
      }

      return {
        matchId: r.match_id,
        date: dateISO,
        result: rd.winner === myTeam ? "win" : "lose",
        teammateNames,
        opponentNames,
        myPicks: (rd[`${myTeam}_picks`] || []).map((c: any) => ({
          code: c.code,
          eidolon: c.eidolon ?? 0,
          superimposition: c.superimposition ?? 0
        })),

        oppPicks: (rd[`${oppTeam}_picks`] || []).map((c: any) => ({
          code: c.code,
          eidolon: c.eidolon ?? 0,
          superimposition: c.superimposition ?? 0
        })),


        myBans: myBansRaw.map((b: any) => b.code),
        oppBans: oppBansRaw.map((b: any) => b.code),
        prebans: rd.prebans || [],
        jokers: rd.jokers || [],
        myCycles: (rd[`${myTeam}_team`] || []).map((m: any) => m.cycles || 0),
        oppCycles: (rd[`${oppTeam}_team`] || []).map((m: any) => m.cycles || 0),
        myCyclePenalty: isRed ? rd.red_penalty || 0 : rd.blue_penalty || 0,
        oppCyclePenalty: isRed ? rd.blue_penalty || 0 : rd.red_penalty || 0,
        redTeam: rd.red_team || [],
        blueTeam: rd.blue_team || [],
        myTeamSide: isRed ? "red" : "blue",
      };
    });

    const response = {
      data: matches,
      total,
      lastFetched: new Date().toISOString(),
      seasonLabel: season.label,
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (player matches)", err);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

export default router;
