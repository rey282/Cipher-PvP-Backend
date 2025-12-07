import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { seasonFromQuery } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });

/* -------------------- GET /api/player/:id/summary -------------------- */
router.get("/api/player/:id/summary", async (req, res) => {
  const playerId = req.params.id;
  const season = seasonFromQuery(req.query.season);
  const mode = String(req.query.mode || "all"); // solo / duo / all
  const cacheKey = `player_summary_${playerId}_${season.table || "all"}_${mode}`;

  // Try cache
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    /* -------------------- 1. Player info -------------------- */
    const userRes = await pool.query(
      `
      SELECT 
        COALESCE(d.username, p.nickname) AS username,
        d.global_name,
        d.avatar
      FROM players p
      LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
      WHERE p.discord_id = $1
      `,
      [playerId]
    );
    const u = userRes.rows[0] || {};
    const username = u.username || "Unknown";

    /* -------------------- 2. Fetch matches -------------------- */
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
             EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team') t WHERE t->>'id' = $1)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id' = $1)
        )
      ${dateClause}
      `,
      params
    );

    /* -------------------- 3. Filter match type -------------------- */
    const filtered = matchRes.rows.filter(({ raw_data }) => {
      const isRed = raw_data.red_team.some((m: any) => m.id === playerId);
      const team = raw_data[isRed ? "red_team" : "blue_team"];
      const mates = team.filter((m: any) => m.id !== playerId);

      if (mode === "solo") return mates.length === 0;
      if (mode === "duo") return mates.length > 0;
      return true;
    });

    /* -------------------- 4. Aggregations -------------------- */
    const pickCounts: Record<string, number> = {};
    const bansMade: Record<string, number> = {};
    const bansAgainst: Record<string, number> = {};
    const prebansMade: Record<string, number> = {};
    const jokersMade: Record<string, number> = {};
    const charWins: Record<string, number> = {};
    const charPlays: Record<string, number> = {};
    let fifteenCyclesCnt = 0;
    const eidonPlays: Record<string, number[]> = {};
    const eidonWins: Record<string, number[]> = {};


    const valid = (code: any) => typeof code === "string" && /^[a-z]+$/i.test(code);

    for (const { raw_data: rd } of filtered) {
      const isRed = rd.red_team.some((m: any) => m.id === playerId);
      const team = isRed ? "red" : "blue";
      const opp = isRed ? "blue" : "red";

      // Fix swapped bans
      const myBans = [...(rd[`${team}_bans`] || [])];
      const oppBans = [...(rd[`${opp}_bans`] || [])];
      if (myBans.length > 1 && oppBans.length > 1) {
        [myBans[1], oppBans[1]] = [oppBans[1], myBans[1]];
      }

      // Count bans
      myBans.forEach((b: any) => valid(b.code) && (bansMade[b.code] = (bansMade[b.code] || 0) + 1));
      oppBans.forEach((b: any) => valid(b.code) && (bansAgainst[b.code] = (bansAgainst[b.code] || 0) + 1));

      // Prebans & Jokers
      (rd.prebans || []).forEach((c: string) => valid(c) && (prebansMade[c] = (prebansMade[c] || 0) + 1));
      (rd.jokers || []).forEach((c: string) => valid(c) && (jokersMade[c] = (jokersMade[c] || 0) + 1));

      // Pick → win/loss tracking
      const teamWon = rd.winner === team;
      (rd[`${team}_picks`] || []).forEach((p: any) => {
        if (!valid(p.code)) return;

        const e = Math.min(Math.max(Number(p.eidolon ?? 0), 0), 6);

        // Init arrays for Eidolon tracking
        if (!eidonPlays[p.code]) eidonPlays[p.code] = [0,0,0,0,0,0,0];
        if (!eidonWins[p.code]) eidonWins[p.code] = [0,0,0,0,0,0,0];

        // Regular stats
        pickCounts[p.code] = (pickCounts[p.code] || 0) + 1;
        charPlays[p.code] = (charPlays[p.code] || 0) + 1;
        if (teamWon) charWins[p.code] = (charWins[p.code] || 0) + 1;

        // Eidolon stats
        eidonPlays[p.code][e] += 1;
        if (teamWon) eidonWins[p.code][e] += 1;
      });


      // 15 cycle checker
      const me = rd[`${team}_team`].find((m: any) => m.id === playerId);
      if (me && Number(me.cycles) === 15) fifteenCyclesCnt++;
    }

    /* -------------------- 5. Top lists -------------------- */
    const topN = (obj: Record<string, number>, n = 3) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([code, count]) => ({ code, count }));

    const mostPicked = topN(pickCounts).map((c) => ({
      code: c.code,
      count: c.count,
      wins: charWins[c.code] || 0,
      losses: (charPlays[c.code] || 0) - (charWins[c.code] || 0),
      games: charPlays[c.code] || 0,
    }));

    const mostBanned = topN(bansMade);
    const mostBannedAgainst = topN(bansAgainst);

    const combinedPrebans: Record<string, number> = { ...prebansMade };
    for (const code in jokersMade) {
      combinedPrebans[code] = (combinedPrebans[code] || 0) + jokersMade[code];
    }
    const mostPrebanned = topN(combinedPrebans);

    /* -------------------- 6. Full WR list -------------------- */
    const allCharacterWR = Object.keys(charPlays).map((code) => ({
      code,
      games: charPlays[code],
      wins: charWins[code] || 0,
      losses: (charPlays[code] || 0) - (charWins[code] || 0),
      winRate: (charWins[code] || 0) / (charPlays[code] || 1),
    }));

    /* -------------------- 7. WINRATE top 3 -------------------- */
    const wrArr = allCharacterWR.filter((c) => c.games >= 5);
    const bestWR = [...wrArr].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    const worstWR = [...wrArr].sort((a, b) => a.winRate - b.winRate).slice(0, 3);

    /* -------------------- 8. Character metadata lookup -------------------- */
    const allCodes = Array.from(
      new Set([
        ...Object.keys(charPlays),
        ...mostPicked.map((c) => c.code),
        ...mostBanned.map((c) => c.code),
        ...mostBannedAgainst.map((c) => c.code),
        ...mostPrebanned.map((c) => c.code),
        ...bestWR.map((c) => c.code),
        ...worstWR.map((c) => c.code),
      ])
    );
    for (const code in eidonPlays) allCodes.push(code);

    let charMap: Record<string, any> = {};

    if (allCodes.length) {
      const { rows: meta } = await pool.query(
        `SELECT code, name, subname, rarity, image_url, path, element
        FROM characters
        WHERE code = ANY($1)`,
        [allCodes]
      );

      meta.forEach((m) => {
        charMap[m.code] = {
          name: m.name,
          subname: m.subname,
          rarity: m.rarity,
          image_url: m.image_url,
          path: m.path,
          element: m.element,
        };
      });
    }


    const addInfo = <T extends { code: string }>(arr: T[]) =>
      arr.map((o) => ({ ...o, ...(charMap[o.code] || {}) }));
    

    /* -------------------- 9. Add metadata to allCharacterWR -------------------- */
    const allCharacterWRFull = addInfo(allCharacterWR);

    /* -------------------- 10. Build final summary -------------------- */
    const summary = {
      playerId,
      username,
      global_name: u.global_name,
      avatar: u.avatar,

      mostPicked: addInfo(mostPicked),
      mostBanned: addInfo(mostBanned),
      mostBannedAgainst: addInfo(mostBannedAgainst),
      mostPrebanned: addInfo(mostPrebanned),

      bestWinRate: addInfo(bestWR),
      worstWinRate: addInfo(worstWR),

      allCharacterWR: allCharacterWRFull,

      eidolons: Object.keys(eidonPlays).map((code) => ({
        code,
        name: charMap[code]?.name,
        image_url: charMap[code]?.image_url,
        element: charMap[code]?.element,
        path: charMap[code]?.path,
        rarity: charMap[code]?.rarity,

        uses: eidonPlays[code],
        wins: eidonWins[code],
      })),

      fifteenCycles: fifteenCyclesCnt,
      seasonLabel: season.label,
    };


    cache.set(cacheKey, summary);
    res.json(summary);
  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({ error: "Failed to generate player summary" });
  }
});

export default router;
