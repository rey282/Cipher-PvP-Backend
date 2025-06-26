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
import { requireAdmin } from "./middleware/requireAdmin";
import rosterRouter from "./routes/roster"; 
import announcementRouter from "./routes/announcement";
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

    const allowedHostnames = [
      'localhost',
      'haya-pvp.vercel.app',
    ];

    try {
      const url = new URL(origin);
      const hostname = url.hostname;

      if (
        hostname.endsWith('.cipher.uno') ||  
        hostname === 'cipher.uno' ||        
        allowedHostnames.includes(hostname)  
      ) {
        return callback(null, true);
      }
    } catch (e) {
      return callback(new Error('Invalid origin'));
    }

    callback(new Error('Not allowed by CORS'));
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
app.use(rosterRouter);
app.use("/api/announcement", announcementRouter);

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
      ORDER BY p.elo DESC;`;

      if (!season.start && !season.end) {
        // All-Time
        const matchCount = await pool.query(`SELECT COUNT(*) FROM matches`);
        totalMatches = Number(matchCount.rows[0].count || 0);

      } else if (season.start && !season.end) {
        // Current active season
        const matchCount = await pool.query(
          `SELECT COUNT(*) FROM matches WHERE timestamp >= $1`,
          [season.start]
        );
        totalMatches = Number(matchCount.rows[0].count || 0);

      } else if (season.start && season.end) {
        // Past season
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

function isOwnerOrAdmin(req: express.Request, discordId: string): boolean {
  const viewer = req.user as { id?: string; isAdmin?: boolean } | undefined;
  return !!viewer && (viewer.id === discordId || !!viewer.isAdmin);
}

/* ─────────── /api/player/:id (profile) ─────────── */
app.get('/api/player/:id', async (req, res) => {
  const { id }      = req.params;
  const seasonKey   = String(req.query.season ?? 'players') as SeasonKey;
  const season      = seasonFromQuery(seasonKey);
  const cacheKey    = `player_profile_${id}_season_${seasonKey}`;

  const cached = cache.get(cacheKey);
  if (cached) { res.json(cached); return; }

  try {
    let rows: any[] = [];

    /* ─── 1. single season table (pf = profile table, ps = season-stats table) ─── */
    if (season.table) {
      const sql = `
        SELECT
          pf.discord_id,
          COALESCE(d.global_name, d.username, pf.nickname) AS display_name,
          d.username,
          d.avatar,

          /* season stats ── default to zero if the user hasn’t played this season */
          COALESCE(ps.elo, 0)           AS elo,
          COALESCE(ps.games_played, 0)  AS games_played,
          COALESCE(ps.win_rate, 0)      AS win_rate,

          /* static profile fields (never seasonal) */
          pf.description,
          pf.banner_url,
          pf.color
        FROM players                pf
        LEFT JOIN discord_usernames d  ON pf.discord_id = d.discord_id
        LEFT JOIN ${season.table}   ps ON pf.discord_id = ps.discord_id
        WHERE pf.discord_id = $1
        LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));

    /* ─── 2. All-Time aggregate ─── */
    } else {
      const unionSQL = Object.values(SEASONS)
        .filter(s => s.table)
        .map(s => `SELECT * FROM ${s.table}`)
        .join(' UNION ALL ');

      const sql = `
        WITH u AS (${unionSQL})
        SELECT p.discord_id,
                COALESCE(d.global_name, d.username, p.nickname) AS display_name,
                d.username,
                d.avatar,
               AVG(u.elo)                                                 AS elo,
               SUM(u.games_played)::int                                   AS games_played,
               COALESCE(
                 SUM(u.win_rate * u.games_played)
                 / NULLIF(SUM(u.games_played), 0), 0)                     AS win_rate,
               p.description,
               p.banner_url,
               p.color
          FROM players p
     LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
     LEFT JOIN u                    ON p.discord_id = u.discord_id
         WHERE p.discord_id = $1
      GROUP BY p.discord_id, d.global_name, d.username, d.avatar,
         p.nickname, p.description, p.banner_url, p.color

         LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));
    }

    if (!rows.length) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    cache.set(cacheKey, rows[0]);
    res.json(rows[0]);
    return;
  } catch (err) {
    console.error('DB error (player)', err);
    res.status(500).json({ error: 'Failed to fetch player' });
    return;
  }
});



/* ─────────── /api/player/:id (update profile) ─────────── */
app.patch('/api/player/:id', async (req, res) => {
  const { id } = req.params;
  const { description, banner_url } = req.body as {
    description?: string;
    banner_url?: string;
  };

  if (!isOwnerOrAdmin(req, id)) { res.sendStatus(403); return; }
  if (description === undefined && banner_url === undefined) {
    res.status(400).json({ error: 'Nothing to update' });
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

    /* clear every cached season variant for this player */
    (Object.keys(SEASONS) as SeasonKey[]).forEach(k =>
      cache.del(`player_profile_${id}_season_${k}`)
    );

    res.json(rows[0]);
    return;
  } catch (err) {
    console.error('DB error (patch player)', err);
    res.status(500).json({ error: 'Failed to update player' });
    return;
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
      global_name: globalName,
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

app.get("/api/admin/matches", requireAdmin, async (req, res): Promise<void> => {
  const limit = Math.max(Number(req.query.limit) || 100, 1);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const season = seasonFromQuery(req.query.season);
  const cacheKey = `admin_matches_${season.table || "all"}`;

  // Serve from cache if present and offset is 0
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
        const tmp = redBans[1];
        redBans[1] = blueBans[1];
        blueBans[1] = tmp;
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
      cache.set(cacheKey, response, 60); // 60 seconds or adjust as needed
    }

    res.json(response);
  } catch (err) {
    console.error('DB error (admin matches)', err);
    res.status(500).json({ error: 'Failed to fetch admin match history' });
  }
});




app.post("/api/admin/rollback/:matchId", requireAdmin, async (req, res) => {
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
      if (isNaN(gainNum)) {
        console.warn(`Invalid gain for player ${playerId}:`, gain);
        continue;
      }
    
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
    

    // Revert picks
    for (const teamKey of ["red_picks", "blue_picks"]) {
      const picks = raw[teamKey] || [];
      const teamWon = (teamKey === "red_picks" && winner === "red") || (teamKey === "blue_picks" && winner === "blue");

      for (const pick of picks) {
        const code = pick.code;
        const eid = pick.eidolon;
        if (!code || eid === undefined) continue;

        if (!seen.has(code)) {
          seen.add(code);
          await client.query(
            "UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1",
            [code]
          );
        }

        await client.query("UPDATE characters SET pick_count = GREATEST(pick_count - 1, 0) WHERE code = $1", [code]);

        await client.query(
          `UPDATE characters 
           SET e${eid}_uses = GREATEST(e${eid}_uses - 1, 0)
           WHERE code = $1`,
          [code]
        );

        if (teamWon) {
          await client.query(
            `UPDATE characters 
             SET e${eid}_wins = GREATEST(e${eid}_wins - 1, 0)
             WHERE code = $1`,
            [code]
          );
        }
      }
    }

    // Revert bans
    for (const teamKey of ["red_bans", "blue_bans"]) {
      const bans = raw[teamKey] || [];
      for (const ban of bans) {
        const code = ban.code;
        if (!code) continue;
        if (!seen.has(code)) {
          seen.add(code);
          await client.query(
            "UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1",
            [code]
          );
        }
        await client.query("UPDATE characters SET ban_count = GREATEST(ban_count - 1, 0) WHERE code = $1", [code]);
      }
    }

    // Revert prebans and jokers
    for (const [field, column] of [
      ["prebans", "preban_count"],
      ["jokers", "joker_count"],
    ] as const) {
      for (const code of raw[field] || []) {
        if (!seen.has(code)) {
          seen.add(code);
          await client.query(
            "UPDATE characters SET appearance_count = GREATEST(appearance_count - 1, 0) WHERE code = $1",
            [code]
          );
        }
        await client.query(
          `UPDATE characters 
           SET ${column} = GREATEST(${column} - 1, 0) 
           WHERE code = $1`,
          [code]
        );
      }
    }

    // Delete the match
    await client.query("DELETE FROM matches WHERE match_id = $1", [matchId]);

    await client.query("COMMIT");
    res.json({ success: true, message: "Match rollback successful." });
    return;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Rollback failed:", err);
    res.status(500).json({ error: "Failed to rollback match" });
    return;
  } finally {
    client.release();
  }
});

app.post("/api/admin/matches/refresh", requireAdmin, (req, res): void => {
  // Clear all cached match pages
  cache.keys().forEach((key) => {
    if (key.startsWith("admin_matches_")) {
      cache.del(key);
    }
  });

  res.json({ success: true });
});


/* ─────────── /api/balance ─────────── */
app.get("/api/balance", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, costs
      FROM balance_costs
      ORDER BY name ASC
    `);

    const characters = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      costs: row.costs,
    }));

    res.json({ characters });
  } catch (err) {
    console.error("DB error (balance)", err);
    res.status(500).json({ error: "Failed to fetch balance data" });
  }
});

app.put("/api/admin/balance", requireAdmin, async (req, res): Promise<void> => {
  const { characters } = req.body;

  if (!Array.isArray(characters)) {
    res.status(400).json({ error: "Missing characters array" });
    return;
  }

  try {
    await pool.query("BEGIN");
    await pool.query("DELETE FROM balance_costs");

    for (const c of characters) {
      if (!c.id || !c.name || !Array.isArray(c.costs) || c.costs.length !== 7) {
        throw new Error(`Invalid character entry for id ${c.id || "unknown"}`);
      }

      await pool.query(
        `INSERT INTO balance_costs (id, name, costs)
         VALUES ($1, $2, $3)
         ON CONFLICT (id)
         DO UPDATE SET name = $2, costs = $3`,
        [c.id, c.name, JSON.stringify(c.costs)]
      );
    }

    await pool.query("COMMIT");
    await recomputePlayerPoints();
    res.status(200).json({ success: true });
    return;
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (balance PUT)", err);
    res.status(500).json({ error: "Failed to update balance data" });
    return;
  }
});

/* ------------------------------------------------------------------ */
/*  Helper:  Re-calculate each player’s points after balance changes  */
/* ------------------------------------------------------------------ */
async function recomputePlayerPoints() {
  // 1. grab user → roster list from the draft-api server
  const res = await fetch("https://draft-api.cipher.uno/getUsers");
  if (!res.ok) {
    throw new Error(`getUsers fetch failed: ${res.status}`);
  }
  const users: {
    discordId: string;
    profileCharacters: { id: string; eidolon: number }[];
  }[] = await res.json();

  // 2. make one DB call to pull EVERY character cost row
  const { rows } = await pool.query<{
    id: string;
    costs: number[];
  }>("SELECT id, costs FROM balance_costs");
  const costMap: Record<string, number[]> = {};
  rows.forEach((r) => (costMap[r.id] = r.costs));

  // 3. build bulk update list: [{ id, points }, …]
  const updates: { id: string; points: number }[] = users.map((u) => {
    const total = u.profileCharacters.reduce((sum, pc) => {
      const costs = costMap[pc.id];
      if (!costs) return sum;              // unknown ID → 0 pts
      const e = Math.min(Math.max(pc.eidolon, 0), 6);
      return sum + costs[e];
    }, 0);
    return { id: u.discordId, points: total };
  });

  // 4. perform bulk updates in a single query
  //    (Postgres - unnest into a VALUES list)
  const ids   = updates.map((u) => u.id);
  const pts   = updates.map((u) => u.points);
  await pool.query(
    `
    UPDATE players AS p
       SET points = u.points
      FROM (SELECT UNNEST($1::text[])  AS id,
                   UNNEST($2::int[])   AS points) AS u
     WHERE p.discord_id = u.id;
    `,
    [ids, pts]
  );
}

/* ─────────── health check ─────────── */
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

/* 404 fallback */
app.use((_, res, _next) => {
  res.status(404).json({ error: 'Not Found' });
});

/* ─────────── start ─────────── */
app.listen(PORT, () => {
  console.log(`✅ Backend running on ${isProd ? "https://api.cipher.uno" : `http://localhost:${PORT}`}`);
});

