import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import helmet from 'helmet';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import passport from 'passport';
import { discordAuthRouter } from './auth/discord';
import { pool } from './db';

dotenv.config();

const requiredEnvs = ['DATABASE_URL', 'SESSION_SECRET'];
for (const name of requiredEnvs) {
  if (!process.env[name]) {
    console.error(`❌ ${name} is missing in .env`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

const isProd = process.env.NODE_ENV === 'production';

// ───── Rate limiting ─────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: 'Too many requests – please try again later.' }
});
const matchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: 'Too many match requests – please slow down.' }
});

// ───── Middleware ─────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); 

    const allowedDomains = [
      'localhost:5173',
      'haya-pvp.vercel.app',
    ];

    const url = new URL(origin);
    if (
      url.hostname.endsWith('.cipher.uno') ||             
      url.hostname === 'cipher.uno' ||
      allowedDomains.includes(url.hostname)
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

/* ───── Sessions (PostgreSQL-backed) ───── */
const PgSession = pgSession(session);
app.use(session({
  name: 'cid',
  store: new PgSession({
    pool, // your existing PG pool
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    domain: isProd ? '.cipher.uno' : undefined,
  }
}));

/* ───── Passport init + session ───── */
app.use(passport.initialize());
app.use(passport.session());

app.use(globalLimiter);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// ───── New auth routes ─────
app.use('/auth', discordAuthRouter);

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
app.get("/api/player/:id/summary", matchLimiter, async (req, res) => {
  const playerId = req.params.id;
  const season   = seasonFromQuery(req.query.season);
  const mode     = String(req.query.mode || "all");  // all / solo / duo
  const cacheKey = `player_summary_${playerId}_${season.table || "all"}_${mode}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    /* ---------- 1. basic user info (name + avatar) ---------- */
    const userRes = await pool.query(
      `SELECT COALESCE(d.username, p.nickname) AS username, p.avatar
         FROM players p
    LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
        WHERE p.discord_id = $1`,
      [playerId]
    );
    const userRow = userRes.rows[0] || {};
    const username = userRow.username || "Unknown";
    const avatar   = userRow.avatar   || null;

    /* ---------- 2. fetch raw matches for this player ---------- */
    const dateClause = season.start
      ? `AND m.timestamp BETWEEN $2 AND $3`
      : "";
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

    /* ---------- 3. filter matches by solo / duo / all ---------- */
    const filteredRows = matchRes.rows.filter(({ raw_data }) => {
      const isRed  = raw_data.red_team.some((m: any) => m.id === playerId);
      const myTeam = raw_data[isRed ? "red_team" : "blue_team"];
      const mates  = myTeam.filter((m: any) => m.id !== playerId);
      return mode === "solo"
        ? mates.length === 0
        : mode === "duo"
        ? mates.length > 0
        : true;
    });

    /* ---------- 4. aggregation buckets ---------- */
    const pickCounts       : Record<string, number> = {};
    const bansMade         : Record<string, number> = {};
    const bansAgainst      : Record<string, number> = {};
    const prebansMade      : Record<string, number> = {};
    const jokersMade       : Record<string, number> = {};
    const charWins         : Record<string, number> = {};
    const charPlays        : Record<string, number> = {};
    let   fifteenCyclesCnt = 0;

    /* ---------- 5. crunch each match ---------- */
    const isValidCode = (code: any) =>
      typeof code === "string" && /^[a-z]+$/i.test(code);

    for (const { raw_data: rd } of filteredRows) {
      const isRed   = rd.red_team.some((m: any) => m.id === playerId);
      const team    = isRed ? "red"  : "blue";
      const oppTeam = isRed ? "blue" : "red";

      /* ----- fix: swap only 2nd ban if present ----- */
      const myBansRaw  = [...(rd[`${team}_bans`]    || [])];
      const oppBansRaw = [...(rd[`${oppTeam}_bans`] || [])];
      if (myBansRaw.length > 1 && oppBansRaw.length > 1) {
        const tmp = myBansRaw[1];
        myBansRaw[1]  = oppBansRaw[1];
        oppBansRaw[1] = tmp;
      }

      /* ----- your team’s bans ----- */
      myBansRaw.forEach((b: any) => {
        if (isValidCode(b.code))
          bansMade[b.code] = (bansMade[b.code] || 0) + 1;
      });

      /* ----- opponent’s bans against you ----- */
      oppBansRaw.forEach((b: any) => {
        if (isValidCode(b.code))
          bansAgainst[b.code] = (bansAgainst[b.code] || 0) + 1;
      });

      /* ----- track prebans & jokers separately ----- */
      (rd.prebans || []).forEach((code: any) => {
        if (isValidCode(code))
          prebansMade[code] = (prebansMade[code] || 0) + 1;
      });
      (rd.jokers || []).forEach((code: any) => {
        if (isValidCode(code))
          jokersMade[code] = (jokersMade[code] || 0) + 1;
      });

      /* ----- picks & win tracking ----- */
      const teamWon = rd.winner === team;
      (rd[`${team}_picks`] || []).forEach((p: any) => {
        pickCounts[p.code]  = (pickCounts[p.code]  || 0) + 1;
        charPlays[p.code]   = (charPlays[p.code]   || 0) + 1;
        if (teamWon)
          charWins[p.code] = (charWins[p.code] || 0) + 1;
      });

      /* ----- 15-cycle tracker ----- */
      const me = (rd[`${team}_team`] || []).find((m: any) => m.id === playerId);
      if (me && Number(me.cycles) === 15) fifteenCyclesCnt += 1;
    }

    /* ---------- 6. helper functions ---------- */
    const topN = (obj: Record<string, number>, n = 3) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([code, count]) => ({ code, count }));

    /* ---------- 7. build result arrays ---------- */
    const mostPicked        = topN(pickCounts);
    const mostBanned        = topN(bansMade);
    const mostBannedAgainst = topN(bansAgainst);
    const combinedPrebans: Record<string, number> = { ...prebansMade };
    for (const code in jokersMade) {
      combinedPrebans[code] = (combinedPrebans[code] || 0) + jokersMade[code];
    }
    const mostPrebanned = topN(combinedPrebans);

    /* ----- win-rate lists ----- */
    const MIN_GAMES = 10;
    const wrArr = Object.keys(charPlays)
      .filter(code => charPlays[code] >= MIN_GAMES)
      .map(code => ({
        code,
        games   : charPlays[code],
        wins    : charWins[code] || 0,
        winRate : (charWins[code] || 0) / charPlays[code],
      }));
    const bestWR  = [...wrArr].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
    const worstWR = [...wrArr].sort((a, b) => a.winRate - b.winRate).slice(0, 3);

    /* ---------- 8. fetch static char data ---------- */
    const allCodes = [
      ...mostPicked.map(c => c.code),
      ...mostBanned.map(c => c.code),
      ...mostBannedAgainst.map(c => c.code),
      ...mostPrebanned.map(c => c.code),
      ...bestWR.map(c => c.code),
      ...worstWR.map(c => c.code),
    ];
    const charMap: Record<string, { name: string; image_url: string }> = {};
    if (allCodes.length) {
      const { rows: chars } = await pool.query(
        `SELECT code, name, image_url FROM characters WHERE code = ANY($1)`,
        [allCodes]
      );
      chars.forEach(
        (c: any) => (charMap[c.code] = { name: c.name, image_url: c.image_url })
      );
    }
    const addInfo = <T extends { code: string }>(arr: T[]) =>
      arr.map(o => ({ ...o, ...charMap[o.code] }));

    /* ---------- 9. assemble summary ---------- */
    const summary = {
      playerId,
      username,
      avatar,
      mostPicked        : addInfo(mostPicked),
      mostBanned        : addInfo(mostBanned),         // bans by this player
      mostBannedAgainst : addInfo(mostBannedAgainst),  // bans that target this player
      mostPrebanned     : addInfo(mostPrebanned),      // new
      bestWinRate       : addInfo(bestWR),
      worstWinRate      : addInfo(worstWR),
      fifteenCycles     : fifteenCyclesCnt,
      seasonLabel       : season.label,
    };

    cache.set(cacheKey, summary);
    res.json(summary);
  } catch (err) {
    console.error("DB error (player summary)", err);
    res.status(500).json({ error: "Failed to build player summary" });
  }
});




/* ─────────── /api/player/:id/matches  ─────────── */
app.get('/api/player/:id/matches', matchLimiter, async (req, res) => {
  const playerId = req.params.id;
  const limit    = Math.max(Number(req.query.limit)  || 15, 1);
  const offset   = Math.max(Number(req.query.offset) || 0 , 0);
  const mode     = String(req.query.mode || 'all');     // all / solo / duo
  const season   = seasonFromQuery(req.query.season);

  /* ---------- dynamic param indexes ---------- */
  const params: any[] = [playerId]; // $1
  let dateClause = '';
  if (season.start) {
    dateClause = `AND m.timestamp BETWEEN $2 AND $3`;
    params.push(season.start, season.end ?? new Date().toISOString()); // $2, $3
  }
  const modeIdx   = params.length + 1;
  const limitIdx  = modeIdx + 1;
  const offsetIdx = modeIdx + 2;
  params.push(mode, limit, offset);

  try {
    const countSQL = `
      WITH player_matches AS (
        SELECT
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
      SELECT COUNT(*)
        FROM player_matches
       WHERE (
              $${modeIdx} = 'all'
           OR ($${modeIdx} = 'solo' AND self_count > 1)
           OR ($${modeIdx} = 'duo'  AND self_count = 1)
       );
    `;
    const { rows: [cnt] } = await pool.query(countSQL, params.slice(0, modeIdx));
    const total = Number(cnt?.count || 0);

    const listSQL = `
      WITH player_matches AS (
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
      OFFSET $${offsetIdx};
    `;

    const { rows } = await pool.query(listSQL, params);

    const matches = rows.map((r: any) => {
      const rd = r.raw_data;
      const isRed = rd.red_team.some((m: any) => m.id === playerId);
      const myTeam = isRed ? 'red' : 'blue';
      const oppTeam = isRed ? 'blue' : 'red';

      const uniq = <T>(arr: T[]) => [...new Set(arr)];
      const teammateNames = uniq(rd[`${myTeam}_team`].filter((m: any) => m.id !== playerId).map((m: any) => m.name));
      const opponentNames = uniq(rd[`${oppTeam}_team`].map((m: any) => m.name));

      const dateISO = rd.date && !isNaN(Date.parse(rd.date)) ? new Date(rd.date).toISOString() : r.timestamp?.toISOString();

      const myBansRaw = [...(rd[`${myTeam}_bans`] || [])];
      const oppBansRaw = [...(rd[`${oppTeam}_bans`] || [])];
      if (myBansRaw.length > 1 && oppBansRaw.length > 1) {
        const tmp = myBansRaw[1];
        myBansRaw[1] = oppBansRaw[1];
        oppBansRaw[1] = tmp;
      }

      const myCycles = rd[`${myTeam}_team`].map((m: any) => m.cycles || 0);
      const oppCycles = rd[`${oppTeam}_team`].map((m: any) => m.cycles || 0);
      const myCyclePenalty = isRed ? rd.red_penalty || 0 : rd.blue_penalty || 0;
      const oppCyclePenalty = isRed ? rd.blue_penalty || 0 : rd.red_penalty || 0;

      return {
        matchId: r.match_id,
        date: dateISO,
        result: rd.winner === myTeam ? 'win' : 'lose',
        teammateNames,
        opponentNames,
        myPicks: (rd[`${myTeam}_picks`] || []).map((c: any) => c.code),
        oppPicks: (rd[`${oppTeam}_picks`] || []).map((c: any) => c.code),
        myBans: myBansRaw.map((b: any) => b.code),
        oppBans: oppBansRaw.map((b: any) => b.code),
        prebans: rd.prebans || [],
        jokers: rd.jokers || [],
        myCycles,
        oppCycles,
        myCyclePenalty,
        oppCyclePenalty
      };
    });

    res.json({
      data: matches,
      total,
      lastFetched: new Date().toISOString(),
      seasonLabel: season.label
    });
  } catch (err) {
    console.error('DB error (player matches)', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

/* ─────────── health check ─────────── */
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

/* 404 fallback */
app.use((_, res, _next) => {
  res.status(404).json({ error: 'Not Found' });
});

/* ─────────── start ─────────── */
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
