import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { seasonFromQuery } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });

const matchLimiter = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
  // Placeholder if you want per-route limit; else move this to middleware
  next();
};

// GET /api/player/:id/summary
router.get("/api/player/:id/summary", matchLimiter, async (req, res) => {
  const playerId = req.params.id;
  const season = seasonFromQuery(req.query.season);
  const mode = String(req.query.mode || "all"); // solo / duo / all
  const cacheKey = `player_summary_${playerId}_${season.table || "all"}_${mode}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    // 1. User info
    const userRes = await pool.query(
      `SELECT COALESCE(d.username, p.nickname) AS username,
              d.global_name,
              d.avatar
         FROM players p
    LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
        WHERE p.discord_id = $1`,
      [playerId]
    );
    const userRow = userRes.rows[0] || {};
    const username = userRow.username || "Unknown";
    const globalName = userRow.global_name || null;
    const avatar = userRow.avatar || null;

    // 2. Fetch match data
    const dateClause = season.start ? `AND m.timestamp BETWEEN $2 AND $3` : "";
    const params = season.start
      ? [playerId, season.start, season.end ?? new Date().toISOString()]
      : [playerId];

    const matchRes = await pool.query(
      `
      SELECT raw_data
        FROM matches m
       WHERE m.has_character_data = TRUE
         AND (
              EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team')  t WHERE t->>'id' = $1)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id' = $1)
         )
         ${dateClause};
      `,
      params
    );

    // 3. Filter match types
    const filtered = matchRes.rows.filter(({ raw_data }) => {
      const isRed = raw_data.red_team.some((m: any) => m.id === playerId);
      const team = raw_data[isRed ? "red_team" : "blue_team"];
      const mates = team.filter((m: any) => m.id !== playerId);
      return mode === "solo" ? mates.length === 0 : mode === "duo" ? mates.length > 0 : true;
    });

    // 4. Aggregation
    const pickCounts: Record<string, number> = {};
    const bansMade: Record<string, number> = {};
    const bansAgainst: Record<string, number> = {};
    const prebansMade: Record<string, number> = {};
    const jokersMade: Record<string, number> = {};
    const charWins: Record<string, number> = {};
    const charPlays: Record<string, number> = {};
    let fifteenCyclesCnt = 0;

    const isValidCode = (code: any) => typeof code === "string" && /^[a-z]+$/i.test(code);

    for (const { raw_data: rd } of filtered) {
      const isRed = rd.red_team.some((m: any) => m.id === playerId);
      const team = isRed ? "red" : "blue";
      const oppTeam = isRed ? "blue" : "red";

      const myBansRaw = [...(rd[`${team}_bans`] || [])];
      const oppBansRaw = [...(rd[`${oppTeam}_bans`] || [])];
      if (myBansRaw.length > 1 && oppBansRaw.length > 1) {
        [myBansRaw[1], oppBansRaw[1]] = [oppBansRaw[1], myBansRaw[1]];
      }

      myBansRaw.forEach((b: any) => isValidCode(b.code) && (bansMade[b.code] = (bansMade[b.code] || 0) + 1));
      oppBansRaw.forEach((b: any) => isValidCode(b.code) && (bansAgainst[b.code] = (bansAgainst[b.code] || 0) + 1));

      (rd.prebans || []).forEach((code: string) => isValidCode(code) && (prebansMade[code] = (prebansMade[code] || 0) + 1));
      (rd.jokers || []).forEach((code: string) => isValidCode(code) && (jokersMade[code] = (jokersMade[code] || 0) + 1));

      const teamWon = rd.winner === team;
      (rd[`${team}_picks`] || []).forEach((p: any) => {
        if (isValidCode(p.code)) {
          pickCounts[p.code] = (pickCounts[p.code] || 0) + 1;
          charPlays[p.code] = (charPlays[p.code] || 0) + 1;
          if (teamWon) charWins[p.code] = (charWins[p.code] || 0) + 1;
        }
      });

      const me = rd[`${team}_team`].find((m: any) => m.id === playerId);
      if (me && Number(me.cycles) === 15) fifteenCyclesCnt++;
    }

    const topN = (obj: Record<string, number>, n = 3) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([code, count]) => ({ code, count }));

    const mostPicked = topN(pickCounts);
    const mostBanned = topN(bansMade);
    const mostBannedAgainst = topN(bansAgainst);

    const combinedPrebans: Record<string, number> = { ...prebansMade };
    for (const code in jokersMade) {
      combinedPrebans[code] = (combinedPrebans[code] || 0) + jokersMade[code];
    }
    const mostPrebanned = topN(combinedPrebans);

    const wrArr = Object.keys(charPlays)
      .filter((code) => charPlays[code] >= 10)
      .map((code) => ({
        code,
        games: charPlays[code],
        wins: charWins[code] || 0,
        winRate: (charWins[code] || 0) / charPlays[code],
      }));
    const bestWR = [...wrArr].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    const worstWR = [...wrArr].sort((a, b) => a.winRate - b.winRate).slice(0, 3);

    // 5. Fetch char names/images
    const allCodes = [
      ...mostPicked.map((c) => c.code),
      ...mostBanned.map((c) => c.code),
      ...mostBannedAgainst.map((c) => c.code),
      ...mostPrebanned.map((c) => c.code),
      ...bestWR.map((c) => c.code),
      ...worstWR.map((c) => c.code),
    ];

    const charMap: Record<string, { name: string; image_url: string }> = {};
    if (allCodes.length) {
      const { rows: chars } = await pool.query(
        `SELECT code, name, image_url FROM characters WHERE code = ANY($1)`,
        [allCodes]
      );
      chars.forEach((c: any) => (charMap[c.code] = { name: c.name, image_url: c.image_url }));
    }

    const addInfo = <T extends { code: string }>(arr: T[]) =>
      arr.map((o) => ({ ...o, ...charMap[o.code] }));

    const summary = {
      playerId,
      username,
      global_name: globalName,
      avatar,
      mostPicked: addInfo(mostPicked),
      mostBanned: addInfo(mostBanned),
      mostBannedAgainst: addInfo(mostBannedAgainst),
      mostPrebanned: addInfo(mostPrebanned),
      bestWinRate: addInfo(bestWR),
      worstWinRate: addInfo(worstWR),
      fifteenCycles: fifteenCyclesCnt,
      seasonLabel: season.label,
    };

    cache.set(cacheKey, summary);
    res.json(summary);
  } catch (err) {
    console.error("DB error (player summary)", err);
    res.status(500).json({ error: "Failed to build player summary" });
  }
});

export default router;
