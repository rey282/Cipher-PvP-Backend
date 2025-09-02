// routes/zzzSpectator.ts
import express, { RequestHandler } from "express";
import { pool } from "../db";
import { genKey } from "../utils/genKey";

const router = express.Router();

/* ───────────────── Auth ───────────────── */
const requireLogin: RequestHandler = (req, res, next) => {
  const viewer = (req as any).user as { id?: string } | undefined;
  if (!viewer?.id) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  next();
};

// Shared draft JSON shapes (match what the frontend sends/stores)
type ZzzMode = "2v2" | "3v3";

function shapeSessionRow(row: any) {
  // NUMERIC comes back as string; normalize here
  const costLimit =
    row.cost_limit == null ? null : Number(row.cost_limit);
  const penaltyPerPoint =
    row.penalty_per_point == null ? 2500 : Number(row.penalty_per_point);

  const payload: any = {
    mode: row.mode,
    team1: row.team1,
    team2: row.team2,
    state: row.state,
    featured: row.featured,
    is_complete: row.is_complete,
    last_activity_at: row.last_activity_at,
    completed_at: row.completed_at,
    costProfileId: row.cost_profile_id || null,

    // ✅ now guaranteed numbers (or null for costLimit)
    costLimit,
    penaltyPerPoint,
  };

  if (row.cost_profile_id) {
    payload.costProfile = {
      name: row.cp_name || "Preset",
      charMs: row.cp_char_ms || {},
      wePhase: row.cp_we_phase || {},
    };
  }
  return payload;
}


// --- Types & helper: sanitize featured + type guards ---
type FeaturedCharacter = {
  kind: "character";
  code: string;
  rule: "none" | "globalBan" | "globalPick";
  customCost?: number | null;
};

type FeaturedWengine = {
  kind: "wengine";
  id: string;
  // NOTE: server ignores globalPick for W-Engines; only allow none/globalBan
  rule: "none" | "globalBan";
  customCost?: number | null;
};

type FeaturedItem = FeaturedCharacter | FeaturedWengine;

function isChar(f: FeaturedItem): f is FeaturedCharacter {
  return f.kind === "character";
}
function isWE(f: FeaturedItem): f is FeaturedWengine {
  return f.kind === "wengine";
}

function sanitizeFeatured(raw: any): FeaturedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (f?.kind === "character" && typeof f.code === "string") {
        const rule: FeaturedCharacter["rule"] =
          f.rule === "globalBan" || f.rule === "globalPick" ? f.rule : "none";
        return {
          kind: "character",
          code: f.code,
          rule,
          customCost: typeof f.customCost === "number" ? f.customCost : null,
        } as FeaturedCharacter;
      }
      if (
        f?.kind === "wengine" &&
        (typeof f.id === "string" || typeof f.id === "number")
      ) {
        // Force W-Engine to only none/globalBan
        const rule: FeaturedWengine["rule"] =
          f.rule === "globalBan" ? "globalBan" : "none";
        return {
          kind: "wengine",
          id: String(f.id),
          rule,
          customCost: typeof f.customCost === "number" ? f.customCost : null,
        } as FeaturedWengine;
      }
      return null;
    })
    .filter(Boolean) as FeaturedItem[];
}

/* ───────────────── Cost Preset types ───────────────── */
type CostProfileRow = {
  id: string;
  owner_user_id: string;
  name: string;
  char_ms: Record<string, number[]>;
  we_phase: Record<string, number[]>;
  created_at?: string;
  updated_at?: string;
};

function sanitizeCostBody(
  raw: any
):
  | {
      name: string;
      char_ms: Record<string, number[]>;
      we_phase: Record<string, number[]>;
    }
  | null {
  if (!raw || typeof raw !== "object") return null;

  const name = String(raw.name || "").trim();
  if (!name || name.length > 40) return null;

  const char_ms = raw.charMs ?? raw.char_ms;
  const we_phase = raw.wePhase ?? raw.we_phase;

  if (!char_ms || typeof char_ms !== "object") return null;
  if (!we_phase || typeof we_phase !== "object") return null;

  const outChar: Record<string, number[]> = {};
  for (const [code, arr] of Object.entries(char_ms)) {
    if (!Array.isArray(arr) || arr.length !== 7) return null;
    const nums = arr.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    outChar[code] = nums;
  }

  const outWe: Record<string, number[]> = {};
  for (const [id, arr] of Object.entries(we_phase)) {
    if (!Array.isArray(arr) || arr.length !== 5) return null;
    const nums = arr.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    outWe[String(id)] = nums; // store as string keys
  }

  return { name, char_ms: outChar, we_phase: outWe };
}

interface ServerPick {
  characterCode: string;
  eidolon: number; // 0..6
  wengineId: string | null;
  superimpose: number; // 1..5
}

interface SpectatorState {
  draftSequence: string[];
  currentTurn: number;
  picks: (ServerPick | null)[];
  blueScores: number[];
  redScores: number[];
  blueLocked?: boolean;
  redLocked?: boolean;
}

/* ───────────────── SSE Hub ───────────────── */
type Client = import("express").Response;
const clients = new Map<string, Set<Client>>();

function addClient(key: string, res: Client) {
  let set = clients.get(key);
  if (!set) clients.set(key, (set = new Set()));
  set.add(res);
  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) clients.delete(key);
  });
}

function push(key: string, event: string, payload: any) {
  const set = clients.get(key);
  if (!set) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
}

async function snapshotAndPush(key: string) {
  const { rows } = await pool.query(
    `SELECT
        s.mode, s.team1, s.team2, s.state, s.featured, s.is_complete,
        s.last_activity_at, s.completed_at, s.cost_profile_id,
        s.cost_limit, s.penalty_per_point,
        cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.we_phase AS cp_we_phase
     FROM zzz_draft_sessions s
     LEFT JOIN zzz_cost_presets cp ON cp.id = s.cost_profile_id
    WHERE s.session_key = $1::text`,
    [key]
  );
  if (rows.length) push(key, "update", shapeSessionRow(rows[0]));
}

/* ───────────────── Helpers ───────────────── */
function isValidState(s: any): boolean {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!Array.isArray(s.draftSequence) || s.draftSequence.length === 0)
    return false;
  if (!Number.isInteger(s.currentTurn) || s.currentTurn < 0) return false;
  if (!Array.isArray(s.picks) || s.picks.length !== s.draftSequence.length)
    return false;
  if (!Array.isArray(s.blueScores) || !Array.isArray(s.redScores)) return false;
  const okPicks = s.picks.every(
    (p: any) =>
      p === null ||
      (p &&
        typeof p === "object" &&
        typeof p.characterCode === "string" &&
        Number.isInteger(p.eidolon) &&
        Number.isInteger(p.superimpose))
  );
  return okPicks;
}

const isBanToken = (tok: string) => tok === "BB" || tok === "RR";
const sideOfToken = (tok: string) =>
  tok?.startsWith("B") ? "B" : tok?.startsWith("R") ? "R" : "";
const sideLocked = (s: SpectatorState, side: "B" | "R") =>
  side === "B" ? !!s.blueLocked : !!s.redLocked;

/* ───────────────── CREATE session ───────────────── */
router.post(
  "/api/zzz/sessions",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };
    const {
      team1,
      team2,
      mode,
      state,
      featured,
      costProfileId,
      costLimit: costLimitRaw,
      penaltyPerPoint: penaltyRaw,
    } = req.body || {};

    if (
      !team1 ||
      !team2 ||
      (mode !== "2v2" && mode !== "3v3") ||
      !state ||
      !isValidState(state)
    ) {
      res.status(400).json({ error: "Missing or invalid body" });
      return;
    }

    // If the owner already has an unfinished session, reuse it and also return tokens
    const existing = await pool.query(
      `SELECT session_key, mode, team1, team2, state, is_complete, last_activity_at, completed_at,
              blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point
         FROM zzz_draft_sessions
        WHERE owner_user_id = $1::text
          AND is_complete IS NOT TRUE
        ORDER BY last_activity_at DESC
        LIMIT 1`,
      [viewer.id]
    );

    if (existing.rows.length) {
      const ex = existing.rows[0];
      const url = `${
        process.env.PUBLIC_BASE_URL || "https://cipher.uno"
      }/zzz/s/${ex.session_key}`;
      res.json({
        key: ex.session_key,
        url,
        reused: true,
        blueToken: ex.blue_token || null,
        redToken: ex.red_token || null,
        costProfileId: ex.cost_profile_id || null,
        costLimit: Number(ex.cost_limit),
        penaltyPerPoint: ex.penalty_per_point,
      });
      return;
    }

    const key = genKey(22);
    const blueToken = genKey(20);
    const redToken = genKey(20);

    // cost defaults (mode-aware)
    const parsedCL = Number(costLimitRaw);
    const finalCostLimit =
      Number.isFinite(parsedCL) && parsedCL > 0
        ? parsedCL
        : mode === "3v3"
        ? 9
        : 6;

    const parsedPenalty = Number(penaltyRaw);
    const finalPenaltyPerPoint =
      Number.isFinite(parsedPenalty) && parsedPenalty > 0
        ? Math.floor(parsedPenalty)
        : 2500;

    // Validate preset ownership if provided
    let presetId: string | null = null;
    if (typeof costProfileId === "string" && costProfileId) {
      const q = await pool.query(
        `SELECT id FROM zzz_cost_presets WHERE id = $1::uuid AND owner_user_id = $2::text`,
        [costProfileId, viewer.id]
      );
      presetId = q.rows.length ? q.rows[0].id : null;
    }

    try {
      const featuredSan = sanitizeFeatured(featured ?? []);
      const { rows } = await pool.query(
        `INSERT INTO zzz_draft_sessions
          (session_key, owner_user_id, mode, team1, team2, state, featured,
           blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::jsonb,
                $8::text, $9::text, $10::uuid, $11::numeric, $12::int)
        RETURNING mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
                  cost_profile_id, cost_limit, penalty_per_point`,
        [
          key,
          viewer.id,
          mode,
          team1,
          team2,
          JSON.stringify(state),
          JSON.stringify(featuredSan),
          blueToken,
          redToken,
          presetId,
          finalCostLimit,
          finalPenaltyPerPoint,
        ]
      );

      await snapshotAndPush(key);

      const url = `${
        process.env.PUBLIC_BASE_URL || "https://cipher.uno"
      }/zzz/s/${key}`;
      res.json({
        key,
        url,
        blueToken,
        redToken,
        costProfileId: rows[0].cost_profile_id || null,
        costLimit: Number(rows[0].cost_limit),
        penaltyPerPoint: rows[0].penalty_per_point,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to create session" });
    }
  }
);

/* ───────────────── UPDATE session ───────────────── */
router.put(
  "/api/zzz/sessions/:key",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };
    const { key } = req.params as { key: string };
    const {
      state,
      isComplete,
      featured,
      costProfileId,
      costLimit: costLimitRaw,
      penaltyPerPoint: penaltyRaw,
    } = req.body || {};

    // Ownership check
    const owner = await pool.query(
      `SELECT owner_user_id FROM zzz_draft_sessions WHERE session_key = $1::text`,
      [key]
    );
    if (owner.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (owner.rows[0].owner_user_id !== viewer.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const hasStateKey = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "state"
    );
    const shouldUpdateState = hasStateKey && isValidState(state);
    const stateJson = shouldUpdateState ? JSON.stringify(state) : null;
    const isCompleteParam =
      typeof isComplete === "boolean" ? isComplete : null;

    // costProfileId handling
    let presetIdSql: string | null | undefined = undefined; // undefined => keep as-is
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "costProfileId")) {
      if (costProfileId === null) {
        presetIdSql = null; // explicit clear
      } else if (typeof costProfileId === "string" && costProfileId) {
        const chk = await pool.query(
          `SELECT id FROM zzz_cost_presets WHERE id = $1::uuid AND owner_user_id = $2::text`,
          [costProfileId, viewer.id]
        );
        presetIdSql = chk.rows.length ? chk.rows[0].id : null; // if invalid/foreign => null
      } else {
        presetIdSql = null;
      }
    }

    // optional costLimit / penaltyPerPoint updates
    const hasCL = Object.prototype.hasOwnProperty.call(req.body ?? {}, "costLimit");
    const hasPenalty = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "penaltyPerPoint"
    );

    // Validate numbers if provided; else let them be null to keep as-is
    const parsedCL = Number(costLimitRaw);
    const clUpdate =
      hasCL && Number.isFinite(parsedCL) && parsedCL > 0 ? parsedCL : null;

    const parsedPenalty = Number(penaltyRaw);
    const penaltyUpdate =
      hasPenalty && Number.isFinite(parsedPenalty) && parsedPenalty > 0
        ? Math.floor(parsedPenalty)
        : null;

    try {
      const featuredSan = Array.isArray(featured)
        ? sanitizeFeatured(featured)
        : null;

      const { rows } = await pool.query(
        `UPDATE zzz_draft_sessions
            SET state = COALESCE($2::jsonb, state),
                featured = COALESCE($3::jsonb, featured),
                is_complete = COALESCE($4::boolean, is_complete),
                completed_at = CASE WHEN $4::boolean IS TRUE AND completed_at IS NULL THEN now() ELSE completed_at END,
                cost_profile_id = COALESCE($5::uuid,
                                   CASE WHEN $6::int = 1 THEN NULL ELSE cost_profile_id END),
                cost_limit = COALESCE($7::numeric, cost_limit),
                penalty_per_point = COALESCE($8::int, penalty_per_point),
                last_activity_at = now()
          WHERE session_key = $1::text
          RETURNING mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
                    cost_profile_id, cost_limit, penalty_per_point`,
        [
          key,
          stateJson,
          featuredSan ? JSON.stringify(featuredSan) : null,
          isCompleteParam,
          typeof presetIdSql === "string" ? presetIdSql : null,
          presetIdSql === null ? 1 : 0,
          hasCL ? clUpdate : null,
          hasPenalty ? penaltyUpdate : null,
        ]
      );

      if (rows.length) await snapshotAndPush(key);
      res.json({
        ok: true,
        stateUpdated: shouldUpdateState,
        costProfileId: rows[0]?.cost_profile_id ?? null,
        costLimit: Number(rows[0]?.cost_limit),
        penaltyPerPoint: rows[0]?.penalty_per_point,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to update session" });
    }
  }
);

/* ───────────────── OWNER: fetch my open (unfinished) session ───────────────── */
router.get(
  "/api/zzz/sessions/open",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };

    try {
      const { rows } = await pool.query(
        `SELECT session_key, mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
                blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point
           FROM zzz_draft_sessions
          WHERE owner_user_id = $1::text
            AND is_complete IS NOT TRUE
          ORDER BY last_activity_at DESC
          LIMIT 1`,
        [viewer.id]
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "No open session" });
        return;
      }

      const r = rows[0];
      res.json({
        key: r.session_key,
        mode: r.mode,
        team1: r.team1,
        team2: r.team2,
        state: r.state,
        featured: r.featured,
        is_complete: r.is_complete,
        last_activity_at: r.last_activity_at,
        completed_at: r.completed_at,
        blueToken: r.blue_token || null,
        redToken: r.red_token || null,
        costProfileId: r.cost_profile_id || null,
        costLimit: Number(r.cost_limit),
        penaltyPerPoint: r.penalty_per_point,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load open session" });
    }
  }
);

/* ───────────────── READ one session (public) ───────────────── */
router.get("/api/zzz/sessions/:key", async (req, res) => {
  const { key } = req.params as { key: string };
  try {
    const { rows } = await pool.query(
      `SELECT
          s.mode, s.team1, s.team2, s.state, s.featured, s.is_complete,
          s.last_activity_at, s.completed_at, s.cost_profile_id,
          s.cost_limit, s.penalty_per_point,
          cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.we_phase AS cp_we_phase
       FROM zzz_draft_sessions s
       LEFT JOIN zzz_cost_presets cp ON cp.id = s.cost_profile_id
      WHERE s.session_key = $1::text`,
      [key]
    );
    if (!rows.length) return void res.status(404).json({ error: "Session not found" });
    res.json(shapeSessionRow(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load session" });
  }
});


/* ───────────────── RECENT completed matches (public) ───────────────── */
router.get(
  "/api/zzz/matches/recent",
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(50, rawLimit))
      : 12;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          session_key,
          mode,
          team1,
          team2,
          state,
          is_complete,
          completed_at,
          last_activity_at,
          cost_profile_id,
          cost_limit,
          penalty_per_point
        FROM zzz_draft_sessions
        WHERE is_complete IS TRUE
        ORDER BY completed_at DESC NULLS LAST, last_activity_at DESC
        LIMIT $1::int
        `,
        [limit]
      );

      const data = rows.map((r) => ({
        key: r.session_key,
        mode: r.mode,
        team1: r.team1,
        team2: r.team2,
        state: r.state,
        completedAt: r.completed_at,
        lastActivityAt: r.last_activity_at,
        costProfileId: r.cost_profile_id || null,
        costLimit: Number(r.cost_limit),
        penaltyPerPoint: r.penalty_per_point,
      }));

      res.json({ data });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch recent matches" });
    }
  }
);

/* ───────────────── LIVE drafts (public) ───────────────── */
router.get(
  "/api/zzz/matches/live",
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(25, rawLimit))
      : 8;

    const rawMinutes = Number(req.query.minutes);
    const minutes =
      Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 120;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          session_key,
          mode,
          team1,
          team2,
          state,
          last_activity_at,
          cost_profile_id,
          cost_limit,
          penalty_per_point
        FROM zzz_draft_sessions
        WHERE is_complete IS NOT TRUE
          AND last_activity_at >= now() - ($2::int * INTERVAL '1 minute')
        ORDER BY last_activity_at DESC
        LIMIT $1::int
        `,
        [limit, minutes]
      );

      const data = rows.map((r) => ({
        key: r.session_key,
        mode: r.mode,
        team1: r.team1,
        team2: r.team2,
        state: r.state,
        lastActivityAt: r.last_activity_at,
        costProfileId: r.cost_profile_id || null,
        costLimit: Number(r.cost_limit),
        penaltyPerPoint: r.penalty_per_point,
      }));

      res.json({ data });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch live drafts" });
    }
  }
);

/* ───────────────── SSE stream (public) ───────────────── */
router.get("/api/zzz/sessions/:key/stream", async (req, res) => {
  const { key } = req.params as { key: string };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as any).flushHeaders?.();

  const { rows } = await pool.query(
    `SELECT
        s.mode, s.team1, s.team2, s.state, s.featured, s.is_complete,
        s.last_activity_at, s.completed_at, s.cost_profile_id,
        s.cost_limit, s.penalty_per_point,
        cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.we_phase AS cp_we_phase
     FROM zzz_draft_sessions s
     LEFT JOIN zzz_cost_presets cp ON cp.id = s.cost_profile_id
    WHERE s.session_key = $1::text`,
    [key]
  );

  if (rows.length === 0) {
    res.write("event: not_found\ndata: {}\n\n");
    res.end();
    return;
  }

  addClient(key, res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(shapeSessionRow(rows[0]))}\n\n`);

  const ping = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
});

/** Resolve which side a player token belongs to */
router.get(
  "/api/zzz/sessions/:key/resolve-token",
  async (req, res): Promise<void> => {
    const { key } = req.params as { key: string };
    const pt = String(req.query.pt || "");

    if (!pt) {
      res.status(400).json({ error: "Missing pt" });
      return;
    }

    const q = await pool.query(
      `SELECT blue_token, red_token FROM zzz_draft_sessions WHERE session_key = $1::text`,
      [key]
    );
    if (q.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const row = q.rows[0];
    if (row.blue_token === pt) return void res.json({ side: "B" });
    if (row.red_token === pt) return void res.json({ side: "R" });

    res.status(403).json({ error: "Invalid player token" });
  }
);

/* ───────────────── PLAYER ACTIONS (public) ─────────────────
Body: {
  op: 'pick'|'ban'|'setMindscape'|'setSuperimpose'|'setWengine'|'setLock'|'undoLast',
  pt: string,
  index?: number,
  characterCode?: string,
  eidolon?: number,
  superimpose?: number,
  wengineId?: string|null,
  locked?: boolean
}
*/
router.post(
  "/api/zzz/sessions/:key/actions",
  async (req, res): Promise<void> => {
    const { key } = req.params as { key: string };
    const { op, pt, index, characterCode, eidolon, superimpose, wengineId } =
      req.body || {};

    if (!pt || typeof pt !== "string") {
      return void res.status(400).json({ error: "Missing pt" });
    }

    try {
      const q = await pool.query(
        `SELECT mode, team1, team2, state, featured, is_complete, blue_token, red_token
           FROM zzz_draft_sessions
          WHERE session_key = $1::text`,
        [key]
      );
      if (q.rows.length === 0)
        return void res.status(404).json({ error: "Session not found" });

      const row = q.rows[0];
      if (row.is_complete === true)
        return void res.status(409).json({ error: "Draft already completed" });

      const playerSide: "B" | "R" | null =
        row.blue_token === pt ? "B" : row.red_token === pt ? "R" : null;
      if (!playerSide)
        return void res.status(403).json({ error: "Invalid player token" });

      const state = row.state as SpectatorState;
      if (!isValidState(state))
        return void res.status(500).json({ error: "Corrupt state" });

      // ---- Featured (sanitized & narrowed) ----
      const featuredList = sanitizeFeatured(row.featured);
      const characterGlobalBan = new Set(
        featuredList
          .filter(isChar)
          .filter((f) => f.rule === "globalBan")
          .map((f) => f.code)
      );
      const characterGlobalPick = new Set(
        featuredList
          .filter(isChar)
          .filter((f) => f.rule === "globalPick")
          .map((f) => f.code)
      );
      // W-Engines: only 'globalBan' is honored server-side
      const wengineGlobalBan = new Set(
        featuredList
          .filter(isWE)
          .filter((f) => f.rule === "globalBan")
          .map((f) => String(f.id))
      );

      const opNeedsIndex = new Set([
        "pick",
        "ban",
        "setMindscape",
        "setSuperimpose",
        "setWengine",
      ]).has(op);

      if (opNeedsIndex) {
        if (!Number.isInteger(index) || (index as number) < 0) {
          return void res.status(400).json({ error: "Invalid index" });
        }
        if ((index as number) >= state.draftSequence.length) {
          return void res.status(400).json({ error: "Index out of range" });
        }
      }

      const tokenAtIndex = opNeedsIndex
        ? state.draftSequence[index as number]
        : "";
      const slotSide = opNeedsIndex ? sideOfToken(tokenAtIndex) : "";
      const isBan = opNeedsIndex ? isBanToken(tokenAtIndex) : false;

      if (op === "pick") {
        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (index !== state.currentTurn)
          return void res.status(409).json({ error: "Not current turn" });
        if (isBan)
          return void res.status(400).json({ error: "Cannot pick on ban slot" });
        if (slotSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for this turn" });
        if (typeof characterCode !== "string" || !characterCode) {
          return void res.status(400).json({ error: "Missing characterCode" });
        }

        // Character: global ban
        if (characterGlobalBan.has(characterCode)) {
          return void res
            .status(409)
            .json({ error: "Character is globally banned" });
        }

        // Unique per side (even if globalPick)
        const mySideCodes = state.picks
          .map<string | null>((p, i) =>
            state.draftSequence[i]?.startsWith(playerSide)
              ? p
                ? p.characterCode
                : null
              : null
          )
          .filter((v): v is string => typeof v === "string");

        if (mySideCodes.includes(characterCode)) {
          return void res
            .status(409)
            .json({ error: "Character already picked by this side" });
        }

        state.picks[index as number] = {
          characterCode,
          eidolon: 0,
          wengineId: null,
          superimpose: 1,
        };
        state.currentTurn = Math.min(
          state.currentTurn + 1,
          state.draftSequence.length
        );
      } else if (op === "ban") {
        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (index !== state.currentTurn)
          return void res.status(409).json({ error: "Not current turn" });
        if (!isBan) return void res.status(400).json({ error: "Not a ban slot" });
        if (slotSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for this turn" });
        if (typeof characterCode !== "string" || !characterCode) {
          return void res.status(400).json({ error: "Missing characterCode" });
        }

        // Cannot ban global-pick characters
        if (characterGlobalPick.has(characterCode)) {
          return void res.status(409).json({
            error: "Cannot ban: character is globally allowed (globalPick)",
          });
        }

        state.picks[index as number] = {
          characterCode,
          eidolon: 0,
          wengineId: null,
          superimpose: 1,
        };
        state.currentTurn = Math.min(
          state.currentTurn + 1,
          state.draftSequence.length
        );
      } else if (op === "setMindscape") {
        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = state.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });
        slot.eidolon = Math.max(0, Math.min(6, Number(eidolon ?? 0)));
      } else if (op === "setSuperimpose") {
        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = state.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });
        slot.superimpose = Math.max(1, Math.min(5, Number(superimpose ?? 1)));
      } else if (op === "setWengine") {
        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = state.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });

        // 🔒 Enforce universal ban for W-Engines
        if (wengineId != null && String(wengineId) !== "") {
          if (wengineGlobalBan.has(String(wengineId))) {
            return void res
              .status(409)
              .json({ error: "W-Engine is globally banned" });
          }
        }

        slot.wengineId =
          wengineId == null || String(wengineId) === ""
            ? null
            : String(wengineId);
      } else if (op === "setLock") {
        const { locked } = req.body || {};
        if (typeof locked !== "boolean")
          return void res.status(400).json({ error: "Missing 'locked' boolean" });
        if (locked === false)
          return void res.status(403).json({ error: "Unlock not allowed here" });
        if (state.currentTurn < state.draftSequence.length) {
          return void res.status(409).json({ error: "Draft not complete" });
        }
        if (playerSide === "B") state.blueLocked = true;
        else state.redLocked = true;
      } else if (op === "undoLast") {
        const lastIdx = state.currentTurn - 1;
        if (lastIdx < 0)
          return void res.status(409).json({ error: "Nothing to undo" });

        if (Number.isInteger(index) && index !== lastIdx) {
          return void res
            .status(400)
            .json({ error: "Index must equal last turn" });
        }

        if (sideLocked(state, playerSide))
          return void res.status(409).json({ error: "Side locked" });

        const lastTok = state.draftSequence[lastIdx];
        const lastSide = sideOfToken(lastTok);
        if (lastSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for undo" });

        if (!state.picks[lastIdx])
          return void res.status(409).json({ error: "Slot already empty" });
        state.picks[lastIdx] = null;
        state.currentTurn = lastIdx;
      } else {
        return void res.status(400).json({ error: "Invalid op" });
      }

      const upd = await pool.query(
        `UPDATE zzz_draft_sessions
            SET state = $2::jsonb,
                last_activity_at = now()
          WHERE session_key = $1::text
          RETURNING mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
                    cost_profile_id, cost_limit, penalty_per_point`,
        [key, JSON.stringify(state)]
      );

      if (upd.rows.length) await snapshotAndPush(key);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to apply action" });
    }
  }
);

/* ───────────────── Cost Presets: list mine (max 2) ───────────────── */
router.get("/api/zzz/cost-presets/my", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  try {
    const q = await pool.query(
      `SELECT id, owner_user_id, name, char_ms, we_phase, created_at, updated_at
         FROM zzz_cost_presets
        WHERE owner_user_id = $1::text
        ORDER BY created_at ASC
        LIMIT 2`,
      [viewer.id]
    );
    const data = q.rows.map((r) => ({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      wePhase: r.we_phase,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load presets" });
  }
});

/* ───────────────── Cost Presets: get one (owner only) ───────────────── */
router.get("/api/zzz/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  try {
    const q = await pool.query(
      `SELECT id, owner_user_id, name, char_ms, we_phase, created_at, updated_at
         FROM zzz_cost_presets
        WHERE id = $1::uuid`,
      [id]
    );
    if (q.rows.length === 0) return void res.status(404).json({ error: "Not found" });
    const r = q.rows[0];
    if (r.owner_user_id !== viewer.id) return void res.status(403).json({ error: "Forbidden" });
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      wePhase: r.we_phase,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load preset" });
  }
});

/* ───────────────── Cost Presets: create ───────────────── */
router.post("/api/zzz/cost-presets", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const body = sanitizeCostBody(req.body);
  if (!body) return void res.status(400).json({ error: "Invalid body" });

  try {
    // enforce max 2
    const cnt = await pool.query(
      `SELECT COUNT(*)::int AS c FROM zzz_cost_presets WHERE owner_user_id = $1::text`,
      [viewer.id]
    );
    if ((cnt.rows[0]?.c ?? 0) >= 2) {
      return void res.status(409).json({ error: "Preset limit reached (2)" });
    }

    const ins = await pool.query(
      `INSERT INTO zzz_cost_presets (owner_user_id, name, char_ms, we_phase)
       VALUES ($1::text, $2::text, $3::jsonb, $4::jsonb)
       RETURNING id, owner_user_id, name, char_ms, we_phase, created_at, updated_at`,
      [viewer.id, body.name, JSON.stringify(body.char_ms), JSON.stringify(body.we_phase)]
    );

    const r = ins.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      wePhase: r.we_phase,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create preset" });
  }
});

/* ───────────────── Cost Presets: update ───────────────── */
router.put("/api/zzz/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  const body = sanitizeCostBody(req.body);
  if (!body) return void res.status(400).json({ error: "Invalid body" });

  try {
    const own = await pool.query(
      `SELECT owner_user_id FROM zzz_cost_presets WHERE id = $1::uuid`,
      [id]
    );
    if (own.rows.length === 0) return void res.status(404).json({ error: "Not found" });
    if (own.rows[0].owner_user_id !== viewer.id)
      return void res.status(403).json({ error: "Forbidden" });

    const upd = await pool.query(
      `UPDATE zzz_cost_presets
          SET name = $2::text,
              char_ms = $3::jsonb,
              we_phase = $4::jsonb,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, name, char_ms, we_phase, created_at, updated_at`,
      [id, body.name, JSON.stringify(body.char_ms), JSON.stringify(body.we_phase)]
    );

    const r = upd.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      wePhase: r.we_phase,
      createdAt: r.created_at,
      UpdatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update preset" });
  }
});

/* ───────────────── Cost Presets: delete ───────────────── */
router.delete("/api/zzz/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  try {
    const own = await pool.query(
      `SELECT owner_user_id FROM zzz_cost_presets WHERE id = $1::uuid`,
      [id]
    );
    if (own.rows.length === 0) return void res.status(404).json({ error: "Not found" });
    if (own.rows[0].owner_user_id !== viewer.id)
      return void res.status(403).json({ error: "Forbidden" });

    await pool.query(`DELETE FROM zzz_cost_presets WHERE id = $1::uuid`, [id]);
    // Sessions referencing this preset will see cost_profile_id = NULL (due to FK ON DELETE SET NULL)
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete preset" });
  }
});

/* ───────────────── DELETE unfinished session (owner only) ───────────────── */
router.delete(
  "/api/zzz/sessions/:key",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };
    const { key } = req.params as { key: string };

    try {
      const chk = await pool.query(
        `SELECT owner_user_id, is_complete
           FROM zzz_draft_sessions
          WHERE session_key = $1::text`,
        [key]
      );

      if (chk.rows.length === 0) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const row = chk.rows[0];
      if (row.owner_user_id !== viewer.id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (row.is_complete === true) {
        res.status(409).json({ error: "Cannot delete a completed session" });
        return;
      }

      const del = await pool.query(
        `DELETE FROM zzz_draft_sessions
          WHERE session_key = $1::text
            AND owner_user_id = $2::text
            AND (is_complete IS NOT TRUE)
          RETURNING session_key`,
        [key, viewer.id]
      );

      if (del.rows.length === 0) {
        res
          .status(404)
          .json({ error: "Session not found or already finalized" });
        return;
      }

      push(key, "deleted", { key });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to delete session" });
    }
  }
);

export default router;
