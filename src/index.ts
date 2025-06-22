import express  from 'express';
import { Request, Response, NextFunction } from 'express';
import cors     from 'cors';
import dotenv   from 'dotenv';
import NodeCache from 'node-cache';
import { pool } from './db';

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

/* one-hour cache */
const cache = new NodeCache({ stdTTL: 60 * 60 });

/* ═════════════════════════════════════════════════════════════════════╗
   ║                      ➤ NEW / SEASONS (CONFIG)                     ║
   ╚════════════════════════════════════════════════════════════════════╝ */
type SeasonKey = 'players' | 'players_1' | 'all';
type SeasonDef = { label: string; table: string; start: string | null; end: string | null };

const SEASONS: Record<SeasonKey, SeasonDef> = {
  players:   { label: 'Season 2', table: 'players',   start: '2025-06-23', end: null },
  players_1: { label: 'Season 1', table: 'players_1', start: '2025-03-31', end: '2025-06-22' },
  all:       { label: 'All-Time', table: '',          start: null,         end: null }
};
const seasonFromQuery = (q: any): SeasonDef => {
  const key = String(q);
  return key in SEASONS ? SEASONS[key as SeasonKey] : SEASONS.players;
};

/* ═════════════════════════════════════════════════════════════════════ */

/* ─────────── /api/characters ─────────── */
app.get('/api/characters', async (req, res) => {
  const cycle = req.query.cycle || '0';
  const tableMap: Record<string, string> = { '0': 'characters', '1': 'characters_1', '2': 'characters_2' };
  const table = tableMap[cycle as string] ?? 'characters';
  const cacheKey = `characters_${cycle}`;

  const cached = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

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
    console.error('DB error (characters)', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

/* ─────────── /api/characters/all ─────────── */
app.get('/api/characters/all', async (req, res) => {
  const cacheKey = 'characters_all';
  const cached   = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

  const q = `
    /* ── 1. UNION THREE CYCLE TABLES ─────────────────────────────────────── */
    WITH u AS (
      SELECT * FROM characters
      UNION ALL
      SELECT * FROM characters_1
      UNION ALL
      SELECT * FROM characters_2
    ),

    /* ── 2. GROUP & COALESCE EVERYTHING TO ZERO, CAST TO INT ─────────────── */
    grouped AS (
      SELECT
        code, name, rarity, image_url, path, element,

        /* simple counters */
        COALESCE(SUM(appearance_count),0)::int AS appearance_count,
        COALESCE(SUM(pick_count)      ,0)::int AS pick_count,
        COALESCE(SUM(ban_count)       ,0)::int AS ban_count,
        COALESCE(SUM(preban_count)    ,0)::int AS preban_count,
        COALESCE(SUM(joker_count)     ,0)::int AS joker_count,

        /* eidolon uses & wins (all forced to int) */
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

    /* ── 3. FINAL SELECT WITH SAFE TOTALS (still ints) ───────────────────── */
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
      data       : rows,
      lastFetched: new Date().toISOString()
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error('DB error (characters/all)', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});



/* ─────────── /api/players ─────────── */
app.get('/api/players', async (req, res) => {
  const seasonKey = String(req.query.season);
  const season    = seasonFromQuery(seasonKey);
  const cacheKey  = `player_stats_${season.table || 'all'}`;

  const cached = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

  let q: string;
  let totalMatches = 0;

  try {
    if (season.table) {
      q = `
        SELECT p.discord_id,
               COALESCE(d.username, p.nickname)             AS username,
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
      ORDER BY p.elo DESC;`;

      if (season.start && season.end) {
        const matchCount = await pool.query(
          `SELECT COUNT(*) FROM matches WHERE timestamp BETWEEN $1 AND $2`,
          [season.start, season.end]
        );
        totalMatches = Number(matchCount.rows[0].count || 0);
      }
    } else {
      const unionSQL = Object.values(SEASONS)
                       .filter(s => s.table)
                       .map(s => `SELECT * FROM ${s.table}`)
                       .join(' UNION ALL ');

      q = `
        WITH u AS (${unionSQL})
        SELECT u.discord_id,
               MAX(COALESCE(d.username, u.nickname))         AS username,
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
      ORDER BY elo DESC;`;

      const matchCount = await pool.query(`SELECT COUNT(*) FROM matches`);
      totalMatches = Number(matchCount.rows[0].count || 0);
    }

    const { rows } = await pool.query(q);

    const response = {
      data: rows,
      lastFetched: new Date().toISOString(),
      totalMatches
    };

    cache.set(cacheKey, response);
    res.json(response);

  } catch (err) {
    console.error('DB error (players)', err);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});



/* ─────────── /api/player/:id/summary ─────────── */
app.get('/api/player/:id/summary', async (req, res) => {
  const playerId = req.params.id;
  const season   = seasonFromQuery(req.query.season);
  const mode     = String(req.query.mode || 'all');                       // NEW
  const cacheKey = `player_summary_${playerId}_${season.table || 'all'}_${mode}`; // NEW

  const cached = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

  try {
    const userRes = await pool.query(
      `SELECT COALESCE(d.username, p.nickname) AS username
         FROM players p
    LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
        WHERE p.discord_id = $1`, [playerId]);
    const username = userRes.rows[0]?.username || "Unknown";

    const dateClause = season.start ? `AND m.timestamp BETWEEN $2 AND $3` : '';
    const params     = season.start
      ? [playerId, season.start, season.end ?? new Date().toISOString()]
      : [playerId];

    const matchRes = await pool.query(`
      SELECT raw_data
        FROM matches m
       WHERE m.has_character_data = TRUE
         AND (
           EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team')  t WHERE t->>'id' = $1)
           OR  EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id' = $1)
         )
         ${dateClause};
    `, params);

    const filteredRows = matchRes.rows.filter(({ raw_data }) => {
      const isRed = raw_data.red_team.some((m: any) => m.id === playerId);
      const myTeam = raw_data[isRed ? 'red_team' : 'blue_team'];
      const mates  = myTeam.filter((m: any) => m.id !== playerId);
      return mode === 'solo' ? mates.length === 0
           : mode === 'duo'  ? mates.length  > 0
           : true;
    });

    const pickCounts: Record<string, number> = {};
    const banCounts : Record<string, number> = {};
    const charWins  : Record<string, number> = {};
    const charPlays : Record<string, number> = {};
    let   fifteenC  = 0;

    for (const { raw_data: rd } of filteredRows) {
      const isRed = rd.red_team.some((m: any) => m.id === playerId);
      const team  = isRed ? 'red' : 'blue';

      (rd[`${team}_bans`] || []).forEach((b: any) => {
        banCounts[b.code] = (banCounts[b.code] || 0) + 1;
      });
      (rd.prebans || []).forEach((code: string) => {
        banCounts[code] = (banCounts[code] || 0) + 1;
      });
      (rd.jokers || []).forEach((code: string) => {
        banCounts[code] = (banCounts[code] || 0) + 1;
      });

      const teamWon = rd.winner === team;
      (rd[`${team}_picks`] || []).forEach((p: any) => {
        pickCounts[p.code]  = (pickCounts[p.code]  || 0) + 1;
        charPlays[p.code]   = (charPlays[p.code]   || 0) + 1;
        if (teamWon) charWins[p.code] = (charWins[p.code] || 0) + 1;
      });

      const me = (rd[`${team}_team`] || []).find((m: any) => m.id === playerId);
      if (me && Number(me.cycles) === 15) fifteenC += 1;
    }

    const topN = (obj: Record<string, number>, n = 3) =>
      Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([code, count]) => ({ code, count }));

    const mostPicked = topN(pickCounts);
    const mostBanned = topN(banCounts);

    const MIN_GAMES = 10;
    const wrArr = Object.keys(charPlays)
      .filter(code => charPlays[code] >= MIN_GAMES)
      .map(code => ({
        code,
        games   : charPlays[code],
        wins    : charWins[code] || 0,
        winRate : (charWins[code] || 0) / charPlays[code]
      }));
    const bestWR  = [...wrArr].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    const worstWR = [...wrArr].sort((a, b) => a.winRate - b.winRate).slice(0, 3);

    const allCodes = [
      ...mostPicked.map(c => c.code),
      ...mostBanned.map(c => c.code),
      ...bestWR.map(c => c.code),
      ...worstWR.map(c => c.code)
    ];

    const charMap: Record<string, { name: string; image_url: string }> = {};
    if (allCodes.length) {
      const { rows: chars } = await pool.query(
        `SELECT code, name, image_url FROM characters WHERE code = ANY($1)`, [allCodes]);
      chars.forEach((c: any) => charMap[c.code] = { name: c.name, image_url: c.image_url });
    }
    const addInfo = <T extends { code: string }>(arr: T[]) =>
      arr.map(o => ({ ...o, ...charMap[o.code] }));

    const summary = {
      playerId,
      username,
      mostPicked   : addInfo(mostPicked),
      mostBanned   : addInfo(mostBanned),
      bestWinRate  : addInfo(bestWR),
      worstWinRate : addInfo(worstWR),
      fifteenCycles: fifteenC,
      seasonLabel  : season.label
    };

    cache.set(cacheKey, summary);
    res.json(summary);
  } catch (err) {
    console.error('DB error (player summary)', err);
    res.status(500).json({ error: 'Failed to build player summary' });
  }
});



/* ─────────── /api/player/:id/matches ─────────── */
app.get("/api/player/:id/matches", async (req, res) => {
  const playerId = req.params.id;
  const limit    = Number(req.query.limit) || 15;
  const mode     = String(req.query.mode || 'all');                                       // NEW
  const season   = seasonFromQuery(req.query.season);
  const cacheKey = `player_matches_${playerId}_${limit}_${season.table || 'all'}_${mode}`; // NEW

  const cached = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

  const dateClause = season.start ? `AND m.timestamp BETWEEN $3 AND $4` : '';
  const params     = season.start
      ? [playerId, limit, season.start, season.end ?? new Date().toISOString()]
      : [playerId, limit];

  const q = `
    SELECT match_id, timestamp, raw_data
      FROM matches m
     WHERE m.has_character_data = TRUE
       AND (
         EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'red_team')  t WHERE t->>'id' = $1)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(raw_data->'blue_team') t WHERE t->>'id' = $1)
       )
       ${dateClause}
  ORDER BY match_id DESC
     LIMIT $2;`;

  try {
    const { rows } = await pool.query(q, params);

    const matches = rows.map((r: any) => {
      const rd = r.raw_data;
      const isRed   = rd.red_team.some((m: any) => m.id === playerId);
      const myTeam  = isRed ? 'red'  : 'blue';
      const oppTeam = isRed ? 'blue' : 'red';

      const uniq = (arr: any[]) => [...new Set(arr)];
      const teammateNames = uniq(
        rd[`${myTeam}_team`].filter((m: any) => m.id !== playerId).map((m: any) => m.name));
      const opponentNames = uniq(rd[`${oppTeam}_team`].map((m: any) => m.name));

      const dateISO =
        rd.date && !isNaN(Date.parse(rd.date))
          ? new Date(rd.date).toISOString()
          : r.timestamp?.toISOString();

      const myBansRaw  = [...(rd[`${myTeam}_bans`]  || [])];
      const oppBansRaw = [...(rd[`${oppTeam}_bans`] || [])];
      if (myBansRaw.length > 1 && oppBansRaw.length > 1) {
        const tmp = myBansRaw[1]; myBansRaw[1] = oppBansRaw[1]; oppBansRaw[1] = tmp;
      }

      const myCycles       = rd[`${myTeam}_team`].map((m: any) => m.cycles || 0);
      const oppCycles      = rd[`${oppTeam}_team`].map((m: any) => m.cycles || 0);
      const myCyclePenalty = isRed ? rd.red_penalty  || 0 : rd.blue_penalty || 0;
      const oppCyclePenalty= isRed ? rd.blue_penalty || 0 : rd.red_penalty  || 0;

      return {
        matchId : r.match_id,
        date    : dateISO,
        result  : rd.winner === myTeam ? 'win' : 'lose',
        teammateNames,
        opponentNames,
        myPicks : (rd[`${myTeam}_picks`] || []).map((c: any) => c.code),
        oppPicks: (rd[`${oppTeam}_picks`] || []).map((c: any) => c.code),
        myBans  : myBansRaw.map((b: any) => b.code),
        oppBans : oppBansRaw.map((b: any) => b.code),
        prebans : rd.prebans || [],
        jokers  : rd.jokers  || [],
        myCycles, oppCycles,
        myCyclePenalty, oppCyclePenalty
      };
    });

    const filteredMatches = matches.filter(m =>
      mode === 'solo' ? m.teammateNames.length === 0
    : mode === 'duo'  ? m.teammateNames.length  > 0
    : true);

    const response = {
      data: filteredMatches,
      lastFetched: new Date().toISOString(),
      seasonLabel: season.label
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (player matches)", err);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

/* ─────────── start ─────────── */
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
