// routes/hsrSpectator.ts
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

/* ───────────────── Mode/type defs ───────────────── */
type HsrMode = "2ban" | "3ban" | "6ban";
const VALID_MODES: ReadonlySet<HsrMode> = new Set(["2ban","3ban","6ban"]);

/* ───────────────── Timer helpers (authoritative on server) ───────────────── */
const MOVE_GRACE = 30;

const isBanTok = (t: string) => t === "BB" || t === "RR";
const sideOfTok = (t: string) => (t?.startsWith("B") ? "B" : t?.startsWith("R") ? "R" : null);

function isFirstBanForSide(idx: number, seq: string[]) {
  const tok = seq[idx] || "";
  if (!isBanTok(tok)) return false;
  for (let i = 0; i < idx; i++) if (seq[i] === tok) return false;
  return true;
}

/** Ensure timer fields exist */
function initTimerFields(s: any) {
  if (!s) return s;
  if (typeof s.timerEnabled !== "boolean") s.timerEnabled = false;
  if (!Number.isFinite(Number(s.reserveSeconds))) s.reserveSeconds = 0;
  if (!s.paused) s.paused = { B: false, R: false };
  const seed = Math.max(0, Number(s.reserveSeconds) || 0);
  if (!s.reserveLeft || typeof s.reserveLeft.B !== "number" || typeof s.reserveLeft.R !== "number") {
    s.reserveLeft = { B: seed, R: seed };
  }
  if (!Number.isFinite(Number(s.graceLeft))) s.graceLeft = MOVE_GRACE;
  if (!Number.isFinite(Number(s.timerUpdatedAt))) s.timerUpdatedAt = Date.now();
  return s;
}

/** Burn once from timerUpdatedAt → now, mutating a shallow copy (used for persist & live ticks) */
function burnToNow(raw: any, nowMs: number) {
  const s = { ...raw };
  initTimerFields(s);
  if (!s.timerEnabled) { s.timerUpdatedAt = nowMs; return s; }

  const tok = s.draftSequence?.[s.currentTurn] || "";
  const side = sideOfTok(tok);
  const frozen = isFirstBanForSide(s.currentTurn, s.draftSequence || []);
  const last = Number(s.timerUpdatedAt) || nowMs;

  if (!side || s.paused?.[side] || frozen) { s.timerUpdatedAt = nowMs; return s; }

  let dt = Math.max(0, (nowMs - last) / 1000);
  let grace = Math.max(0, Number(s.graceLeft ?? MOVE_GRACE));
  let resB = Math.max(0, Number(s.reserveLeft?.B ?? s.reserveSeconds ?? 0));
  let resR = Math.max(0, Number(s.reserveLeft?.R ?? s.reserveSeconds ?? 0));

  const g = Math.min(grace, dt);
  grace -= g; dt -= g;

  if (dt > 0) {
    if (side === "B") resB = Math.max(0, resB - dt);
    else if (side === "R") resR = Math.max(0, resR - dt);
  }

  s.graceLeft = Number(grace.toFixed(3));
  s.reserveLeft = { B: Number(resB.toFixed(3)), R: Number(resR.toFixed(3)) };
  s.timerUpdatedAt = nowMs;
  return s;
}

/** Reset grace on turn change (call immediately after incrementing currentTurn) */
function resetGraceForNewTurn(raw: any, nowMs: number) {
  const s = { ...raw };
  initTimerFields(s);
  s.graceLeft = MOVE_GRACE;
  s.timerUpdatedAt = nowMs;
  return s;
}

/* ───────────────── Shared shape helpers ───────────────── */
function shapeSessionRow(row: any) {
  const costLimit = row.cost_limit == null ? null : Number(row.cost_limit);
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
    costLimit,
    penaltyPerPoint,
  };

  if (row.cost_profile_id) {
    payload.costProfile = {
      name: row.cp_name || "Preset",
      charMs: row.cp_char_ms || {},
      lcPhase: row.cp_lc_phase || {},
    };
  }

  // ⬇️ expose timer settings at top-level (while still keeping them in state)
  try {
    const st = row.state || {};
    if (typeof st.timerEnabled === "boolean")
      payload.timerEnabled = !!st.timerEnabled;
    if (Number.isFinite(Number(st.reserveSeconds))) {
      payload.reserveSeconds = Math.max(0, Number(st.reserveSeconds));
    }
  } catch {}

  return normalizeStateForHsr(payload);
}

function normalizeIncomingState(s: any): any {
  if (!s || typeof s !== "object" || !Array.isArray(s.picks)) return s;

  const picks = s.picks.map((p: any) => {
    if (!p) return null;
    const sup = Number.isInteger(p.superimpose)
      ? p.superimpose
      : Number.isInteger(p.phase)
      ? p.phase
      : 1;

    const eid = Number.isInteger(p.eidolon) ? p.eidolon : 0;
    const lc =
      p.lightconeId == null || String(p.lightconeId) === ""
        ? null
        : String(p.lightconeId);

    return {
      characterCode: String(p.characterCode),
      eidolon: Math.max(0, Math.min(6, eid)),
      lightconeId: lc,
      superimpose: Math.max(1, Math.min(5, sup)),
    };
  });

  return {
    ...s,
    currentTurn: Math.max(
      0,
      Math.min((s.draftSequence || []).length, Number(s.currentTurn) || 0)
    ),
    picks,
  };
}

/* ───────────────── Featured types ─────────────────
   Same as ZZZ, but "wengine" -> "lightcone".
   Server enforces only:
     - Characters: none/globalBan/globalPick
     - LightCones: none/globalBan
────────────────────────────────────────────────── */
type FeaturedCharacter = {
  kind: "character";
  code: string;
  rule: "none" | "globalBan" | "globalPick";
  customCost?: number | null;
};

type FeaturedLightCone = {
  kind: "lightcone";
  id: string; // stringified LC ID
  rule: "none" | "globalBan";
  customCost?: number | null;
};

type FeaturedItem = FeaturedCharacter | FeaturedLightCone;

function isChar(f: FeaturedItem): f is FeaturedCharacter {
  return f.kind === "character";
}
function isLC(f: FeaturedItem): f is FeaturedLightCone {
  return f.kind === "lightcone";
}

function sanitizeFeatured(raw: any): FeaturedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      // Characters (same as before)
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

      // Lightcones (supports legacy 'wengine' from ZZZ)
      const isLCKind =
        f?.kind === "lightcone" || f?.kind === "wengine"; // ← accept both
      const idVal = f?.id;
      if (isLCKind && (typeof idVal === "string" || typeof idVal === "number")) {
        const rule: FeaturedLightCone["rule"] =
          f.rule === "globalBan" ? "globalBan" : "none"; // only none/globalBan
        return {
          kind: "lightcone",
          id: String(idVal),
          rule,
          customCost: typeof f.customCost === "number" ? f.customCost : null,
        } as FeaturedLightCone;
      }

      return null;
    })
    .filter(Boolean) as FeaturedItem[];
}

function normalizeStateForHsr(out: any) {
  try {
    if (!out?.state?.picks || !Array.isArray(out.state.picks)) return out;
    out = { ...out, state: { ...out.state, picks: [...out.state.picks] } };
    out.state.picks = out.state.picks.map((p: any) => {
      if (!p || typeof p !== "object") return p;

      // legacy ZZZ → HSR id mapping
      if (p.wengineId != null && p.lightconeId == null) {
        p = { ...p, lightconeId: String(p.wengineId) };
      }

      // superimpose → phase for HSR client
      if (p.phase == null && Number.isInteger(p.superimpose)) {
        p = { ...p, phase: p.superimpose };
      }

      return p;
    });
  } catch {}
  return out;
}

/* ───────────────── Cost Preset types ───────────────── */
type CostProfileRow = {
  id: string;
  owner_user_id: string;
  name: string;
  char_ms: Record<string, number[]>; // code -> [M0..M6]
  lc_phase: Record<string, number[]>; // lightconeId -> [P1..P5]
  created_at?: string;
  updated_at?: string;
};

function sanitizeCostBody(
  raw: any
):
  | {
      name: string;
      char_ms: Record<string, number[]>;
      lc_phase: Record<string, number[]>;
    }
  | null {
  if (!raw || typeof raw !== "object") return null;

  const name = String(raw.name || "").trim();
  if (!name || name.length > 40) return null;

  const char_ms = raw.charMs ?? raw.char_ms;
  const lc_phase = raw.lcPhase ?? raw.lc_phase;

  if (!char_ms || typeof char_ms !== "object") return null;
  if (!lc_phase || typeof lc_phase !== "object") return null;

  const outChar: Record<string, number[]> = {};
  for (const [code, arr] of Object.entries(char_ms)) {
    if (!Array.isArray(arr) || arr.length !== 7) return null;
    const nums = arr.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    outChar[String(code)] = nums;
  }

  const outLC: Record<string, number[]> = {};
  for (const [id, arr] of Object.entries(lc_phase)) {
    if (!Array.isArray(arr) || arr.length !== 5) return null;
    const nums = arr.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
    outLC[String(id)] = nums;
  }

  return { name, char_ms: outChar, lc_phase: outLC };
}

/* ───────────────── Draft state & pick ───────────────── */
interface ServerPick {
  characterCode: string;
  eidolon: number; // 0..6
  lightconeId: string | null;
  superimpose: number; // 1..5
}

interface SpectatorState {
  draftSequence: string[]; // tokens incl. 'BB'/'RR' for bans; client decides full sequence
  currentTurn: number;
  picks: (ServerPick | null)[];
  blueScores: number[];
  redScores: number[];
  blueLocked?: boolean;
  redLocked?: boolean;
  paused?: { B: boolean; R: boolean };

  // Authoritative timer fields (optional)
  timerEnabled?: boolean;
  reserveSeconds?: number;
  reserveLeft?: { B: number; R: number };
  graceLeft?: number;
  timerUpdatedAt?: number;
}

/* ───────────────── SSE hub ───────────────── */
type Client = import("express").Response;
const clients = new Map<string, Set<Client>>();

// runtime cache for shaped sessions + per-session tickers
const sessionCache = new Map<string, any>();
const tickers = new Map<string, NodeJS.Timeout>();

function stopTickerIfNoClients(key: string) {
  const set = clients.get(key);
  if (set && set.size > 0) return;
  const h = tickers.get(key);
  if (h) clearInterval(h);
  tickers.delete(key);
  sessionCache.delete(key);
}

function addClient(key: string, res: Client) {
  let set = clients.get(key);
  if (!set) clients.set(key, (set = new Set()));
  set.add(res);
  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) {
      clients.delete(key);
      stopTickerIfNoClients(key);
    }
  });
}

function push(key: string, event: string, payload: any) {
  const set = clients.get(key);
  if (!set) return;
  if (event === "update" || event === "snapshot") {
    sessionCache.set(key, payload);
  }
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
}

function startTicker(key: string) {
  if (tickers.has(key)) return;
  const h = setInterval(() => {
    const payload = sessionCache.get(key);
    if (!payload) return;
    const base = payload.state || {};
    const now = Date.now();

    // compute *view* only; don't touch DB here
    const burned = burnToNow(base, now);

    // store in cache so next tick burns from this moment
    const nextPayload = { ...payload, state: burned };
    sessionCache.set(key, nextPayload);

    // stream minimal timer state
    push(key, "timer", {
      state: {
        timerEnabled: !!burned.timerEnabled,
        paused: burned.paused,
        reserveLeft: burned.reserveLeft,
        graceLeft: burned.graceLeft,
        timerUpdatedAt: burned.timerUpdatedAt,
        currentTurn: burned.currentTurn,
      },
    });
  }, 250);
  tickers.set(key, h);
}

async function snapshotAndPush(key: string) {
  const { rows } = await pool.query(
    `SELECT
        s.mode, s.team1, s.team2, s.state, s.featured, s.is_complete,
        s.last_activity_at, s.completed_at, s.cost_profile_id,
        s.cost_limit, s.penalty_per_point,
        cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.lc_phase AS cp_lc_phase
     FROM hsr_draft_sessions s
     LEFT JOIN hsr_cost_presets cp ON cp.id = s.cost_profile_id
    WHERE s.session_key = $1::text`,
    [key]
  );
  if (rows.length) {
    const shaped = shapeSessionRow(rows[0]);
    push(key, "update", shaped);
  }
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
        (Number.isInteger(p.superimpose) || Number.isInteger(p.phase)))
  );
  return okPicks;
}

const isBanToken = (tok: string) => tok === "BB" || tok === "RR";
const sideOfTokenStrict = (tok: string) =>
  tok?.startsWith("B") ? "B" : tok?.startsWith("R") ? "R" : "";
const sideLocked = (s: SpectatorState, side: "B" | "R") =>
  side === "B" ? !!s.blueLocked : !!s.redLocked;

/* ───────────────── CREATE session ───────────────── */
router.post(
  "/api/hsr/sessions",
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

    const modeStr = String(mode) as HsrMode;

    if (!team1 || !team2 || !VALID_MODES.has(modeStr) || !state || !isValidState(state)) {
    res.status(400).json({ error: "Missing or invalid body" });
    return;
  }

    // merge timer/paused into state we persist
    const normalizedState = normalizeIncomingState(state);
    const fromBodyTimerEnabled =
      typeof req.body?.timerEnabled === "boolean"
        ? !!req.body.timerEnabled
        : undefined;
    const fromBodyReserveSeconds = Number.isFinite(
      Number(req.body?.reserveSeconds)
    )
      ? Math.max(0, Number(req.body.reserveSeconds))
      : undefined;
    const fromBodyPaused = req.body?.paused;

    const mergedState: any = { ...normalizedState };
    if (fromBodyTimerEnabled !== undefined)
      mergedState.timerEnabled = fromBodyTimerEnabled;
    if (fromBodyReserveSeconds !== undefined)
      mergedState.reserveSeconds = fromBodyReserveSeconds;
    if (
      fromBodyPaused &&
      typeof fromBodyPaused.B === "boolean" &&
      typeof fromBodyPaused.R === "boolean"
    ) {
      mergedState.paused = { B: !!fromBodyPaused.B, R: !!fromBodyPaused.R };
    }
    // seed authoritative timer fields
    initTimerFields(mergedState);

    // Reuse unfinished session per owner
    const existing = await pool.query(
      `SELECT session_key, mode, team1, team2, state, is_complete, last_activity_at, completed_at,
              blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point
         FROM hsr_draft_sessions
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
      }/hsr/s/${ex.session_key}`;
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

    // Defaults analogous to ZZZ
    const parsedCL = Number(costLimitRaw);
    const finalCostLimit =
      Number.isFinite(parsedCL) && parsedCL > 0
        ? parsedCL
        : mode === "3ban"
        ? 9
        : 6;

    const parsedPenalty = Number(penaltyRaw);
    const finalPenaltyPerPoint =
      Number.isFinite(parsedPenalty) && parsedPenalty > 0
        ? Math.floor(parsedPenalty)
        : 2500;

    // Validate preset ownership (optional)
    let presetId: string | null = null;
    if (typeof costProfileId === "string" && costProfileId) {
      const q = await pool.query(
        `SELECT id FROM hsr_cost_presets WHERE id = $1::uuid AND owner_user_id = $2::text`,
        [costProfileId, viewer.id]
      );
      presetId = q.rows.length ? q.rows[0].id : null;
    }

    try {
      const featuredSan = sanitizeFeatured(featured ?? []);
      await pool.query(
        `INSERT INTO hsr_draft_sessions
          (session_key, owner_user_id, mode, team1, team2, state, featured,
           blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::jsonb,
                $8::text, $9::text, $10::uuid, $11::numeric, $12::int)`,
        [
          key,
          viewer.id,
          modeStr,
          team1,
          team2,
          JSON.stringify(mergedState),
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
      }/hsr/s/${key}`;
      res.json({
        key,
        url,
        blueToken,
        redToken,
        costProfileId: presetId,
        costLimit: finalCostLimit,
        penaltyPerPoint: finalPenaltyPerPoint,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to create session" });
    }
  }
);

/* ───────────────── UPDATE session ───────────────── */
router.put(
  "/api/hsr/sessions/:key",
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
      `SELECT owner_user_id FROM hsr_draft_sessions WHERE session_key = $1::text`,
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

    const hasStateKey =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "state");
    const shouldUpdateState = hasStateKey && isValidState(state);
    const normalizedState = shouldUpdateState ? normalizeIncomingState(state) : null;
    const fromBodyTimerEnabled =
      typeof req.body?.timerEnabled === "boolean" ? !!req.body.timerEnabled : undefined;
    const fromBodyReserveSeconds =
      Number.isFinite(Number(req.body?.reserveSeconds))
        ? Math.max(0, Number(req.body.reserveSeconds))
        : undefined;
    const fromBodyPaused = req.body?.paused;

    let stateJson = null;
    if (shouldUpdateState && normalizedState) {
      const merged: any = { ...normalizedState };
      if (fromBodyTimerEnabled !== undefined) merged.timerEnabled = fromBodyTimerEnabled;
      if (fromBodyReserveSeconds !== undefined) merged.reserveSeconds = fromBodyReserveSeconds;
      if (
        fromBodyPaused &&
        typeof fromBodyPaused.B === "boolean" &&
        typeof fromBodyPaused.R === "boolean"
      ) {
        merged.paused = { B: !!fromBodyPaused.B, R: !!fromBodyPaused.R };
      }
      // ensure timer fields exist
      initTimerFields(merged);
      stateJson = JSON.stringify(merged);
    }

    const isCompleteParam = typeof isComplete === "boolean" ? isComplete : null;

    // costProfileId handling
    let presetIdSql: string | null | undefined = undefined; // undefined => keep as-is
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "costProfileId")) {
      if (costProfileId === null) {
        presetIdSql = null; // explicit clear
      } else if (typeof costProfileId === "string" && costProfileId) {
        const chk = await pool.query(
          `SELECT id FROM hsr_cost_presets WHERE id = $1::uuid AND owner_user_id = $2::text`,
          [costProfileId, viewer.id]
        );
        presetIdSql = chk.rows.length ? chk.rows[0].id : null;
      } else {
        presetIdSql = null;
      }
    }

    // Optional cost updates
    const hasCL =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "costLimit");
    const hasPenalty =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "penaltyPerPoint");

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
        `UPDATE hsr_draft_sessions
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
router.get("/api/hsr/sessions/open", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };

  try {
    const { rows } = await pool.query(
      `SELECT session_key, mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
              blue_token, red_token, cost_profile_id, cost_limit, penalty_per_point
         FROM hsr_draft_sessions
        WHERE owner_user_id = $1::text
          AND is_complete IS NOT TRUE
        ORDER BY last_activity_at DESC
        LIMIT 1`,
      [viewer.id]
    );

    if (rows.length === 0) {
      res.json({ exists: false });
      return;
    }

    const r = rows[0];
    res.json({
      exists: true,
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
});

/* ───────────────── READ one session (public) ───────────────── */
router.get("/api/hsr/sessions/:key", async (req, res) => {
  const { key } = req.params as { key: string };
  try {
    const { rows } = await pool.query(
      `SELECT
          s.mode, s.team1, s.team2, s.state, s.featured, s.is_complete,
          s.last_activity_at, s.completed_at, s.cost_profile_id,
          s.cost_limit, s.penalty_per_point,
          cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.lc_phase AS cp_lc_phase
       FROM hsr_draft_sessions s
       LEFT JOIN hsr_cost_presets cp ON cp.id = s.cost_profile_id
      WHERE s.session_key = $1::text`,
      [key]
    );
    if (!rows.length)
      return void res.status(404).json({ error: "Session not found" });
    res.json(shapeSessionRow(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load session" });
  }
});

/* ───────────────── RECENT completed matches (public) ───────────────── */
router.get("/api/hsr/matches/recent", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(50, rawLimit))
    : 12;

  try {
    const { rows } = await pool.query(
      `SELECT
         session_key, mode, team1, team2, state, is_complete, completed_at,
         last_activity_at, cost_profile_id, cost_limit, penalty_per_point
       FROM hsr_draft_sessions
       WHERE is_complete IS TRUE
       ORDER BY completed_at DESC NULLS LAST, last_activity_at DESC
       LIMIT $1::int`,
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
});

/* ───────────────── LIVE drafts (public) ───────────────── */
router.get("/api/hsr/matches/live", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(25, rawLimit))
    : 8;

  const rawMinutes = Number(req.query.minutes);
  const minutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 120;

  try {
    const { rows } = await pool.query(
      `SELECT
         session_key, mode, team1, team2, state, last_activity_at,
         cost_profile_id, cost_limit, penalty_per_point
       FROM hsr_draft_sessions
       WHERE is_complete IS NOT TRUE
         AND last_activity_at >= now() - ($2::int * INTERVAL '1 minute')
       ORDER BY last_activity_at DESC
       LIMIT $1::int`,
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
});

/* ───────────────── SSE stream (public) ───────────────── */
router.get("/api/hsr/sessions/:key/stream", async (req, res) => {
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
        cp.name AS cp_name, cp.char_ms AS cp_char_ms, cp.lc_phase AS cp_lc_phase
     FROM hsr_draft_sessions s
     LEFT JOIN hsr_cost_presets cp ON cp.id = s.cost_profile_id
    WHERE s.session_key = $1::text`,
    [key]
  );

  if (rows.length === 0) {
    res.write("event: not_found\ndata: {}\n\n");
    res.end();
    return;
  }

  const shaped = shapeSessionRow(rows[0]);
  addClient(key, res);
  sessionCache.set(key, shaped);
  res.write(`event: snapshot\ndata: ${JSON.stringify(shaped)}\n\n`);
  startTicker(key);

  const ping = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
});

/* ───────────────── Resolve which side a player token belongs to ───────────────── */
router.get(
  "/api/hsr/sessions/:key/resolve-token",
  async (req, res): Promise<void> => {
    const { key } = req.params as { key: string };
    const pt = String(req.query.pt || "");

    if (!pt) {
      res.status(400).json({ error: "Missing pt" });
      return;
    }

    const q = await pool.query(
      `SELECT blue_token, red_token FROM hsr_draft_sessions WHERE session_key = $1::text`,
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
  op: 'pick'|'ban'|'setEidolon'|'setSuperimpose'|'setLightcone'|'setLock'|'undoLast',
  pt: string,
  index?: number,
  characterCode?: string,
  eidolon?: number,
  superimpose?: number,
  lightconeId?: string|null,
  locked?: boolean
}
*/
router.post(
  "/api/hsr/sessions/:key/actions",
  async (req, res): Promise<void> => {
    const { key } = req.params as { key: string };

    // Accept legacy ZZZ op names & body keys
    let {
      op,
      pt,
      index,
      characterCode,
      eidolon,
      superimpose,
      lightconeId,
      wengineId,
      phase,
    } = req.body || {};

    // Alias legacy ops to HSR ops
    if (op === "setMindscape") op = "setEidolon";
    if (op === "setWengine") op = "setLightcone";

    // Alias legacy field to HSR field
    if (lightconeId == null && wengineId != null) {
      lightconeId = String(wengineId);
    }

    if (!pt || typeof pt !== "string") {
      return void res.status(400).json({ error: "Missing pt" });
    }
    // NEW: accept `phase` from the HSR client
    if (superimpose == null && phase != null) {
      superimpose = phase;
    }

    try {
      const q = await pool.query(
        `SELECT mode, team1, team2, state, featured, is_complete, blue_token, red_token
           FROM hsr_draft_sessions
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

      // authoritative burn to *now* before applying any changes
      let st: any = state;
      const now = Date.now();
      st = burnToNow(st, now);

      // Featured (narrowed)
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
      const lightconeGlobalBan = new Set(
        featuredList
          .filter(isLC)
          .filter((f) => f.rule === "globalBan")
          .map((f) => String(f.id))
      );

      const opNeedsIndex = new Set([
        "pick",
        "ban",
        "setEidolon",
        "setSuperimpose",
        "setLightcone",
      ]).has(op);
      if (opNeedsIndex) {
        if (!Number.isInteger(index) || (index as number) < 0) {
          return void res.status(400).json({ error: "Invalid index" });
        }
        if ((index as number) >= st.draftSequence.length) {
          return void res.status(400).json({ error: "Index out of range" });
        }
      }

      const tokenAtIndex = opNeedsIndex ? st.draftSequence[index as number] : "";
      const slotSide = opNeedsIndex ? sideOfTokenStrict(tokenAtIndex) : "";
      const isBan = opNeedsIndex ? isBanToken(tokenAtIndex) : false;

      if (op === "pick") {
        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (index !== st.currentTurn)
          return void res.status(409).json({ error: "Not current turn" });
        if (isBan)
          return void res.status(400).json({ error: "Cannot pick on ban slot" });
        if (slotSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for this turn" });
        if (typeof characterCode !== "string" || !characterCode) {
          return void res.status(400).json({ error: "Missing characterCode" });
        }

        if (characterGlobalBan.has(characterCode)) {
          return void res
            .status(409)
            .json({ error: "Character is globally banned" });
        }

        // Unique per side (even if globalPick)
        const mySideCodes: string[] = (st.picks as (ServerPick | null)[])
          .map((p: ServerPick | null, i: number): string | null =>
            st.draftSequence[i]?.startsWith(playerSide) ? (p ? p.characterCode : null) : null
          )
          .filter((v): v is string => typeof v === "string");

        if (mySideCodes.includes(characterCode)) {
          return void res
            .status(409)
            .json({ error: "Character already picked by this side" });
        }

        st.picks[index as number] = {
          characterCode,
          eidolon: 0,
          lightconeId: null,
          superimpose: 1,
        };
        st.currentTurn = Math.min(
          st.currentTurn + 1,
          st.draftSequence.length
        );
        st = resetGraceForNewTurn(st, now);
      } else if (op === "ban") {
        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (index !== st.currentTurn)
          return void res.status(409).json({ error: "Not current turn" });
        if (!isBan) return void res.status(400).json({ error: "Not a ban slot" });
        if (slotSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for this turn" });
        if (typeof characterCode !== "string" || !characterCode) {
          return void res.status(400).json({ error: "Missing characterCode" });
        }

        if (characterGlobalPick.has(characterCode)) {
          return void res.status(409).json({
            error: "Cannot ban: character is globally allowed (globalPick)",
          });
        }

        st.picks[index as number] = {
          characterCode,
          eidolon: 0,
          lightconeId: null,
          superimpose: 1,
        };
        st.currentTurn = Math.min(
          st.currentTurn + 1,
          st.draftSequence.length
        );
        st = resetGraceForNewTurn(st, now);
      } else if (op === "setEidolon") {
        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = st.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });
        slot.eidolon = Math.max(0, Math.min(6, Number(eidolon ?? 0)));
      } else if (op === "setSuperimpose") {
        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = st.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });
        slot.superimpose = Math.max(1, Math.min(5, Number(superimpose ?? 1)));
      } else if (op === "setLightcone") {
        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });
        if (slotSide !== playerSide || isBan)
          return void res
            .status(403)
            .json({ error: "Cannot edit opponent or ban slot" });
        const slot = st.picks[index as number];
        if (!slot) return void res.status(409).json({ error: "No character in slot" });

        // Enforce universal ban for Light Cones
        if (lightconeId != null && String(lightconeId) !== "") {
          if (lightconeGlobalBan.has(String(lightconeId))) {
            return void res
              .status(409)
              .json({ error: "Light Cone is globally banned" });
          }
        }

        slot.lightconeId =
          lightconeId == null || String(lightconeId) === ""
            ? null
            : String(lightconeId);
      } else if (op === "setLock") {
        const { locked } = req.body || {};
        if (typeof locked !== "boolean")
          return void res.status(400).json({ error: "Missing 'locked' boolean" });
        if (locked === false)
          return void res.status(403).json({ error: "Unlock not allowed here" });
        if (st.currentTurn < st.draftSequence.length) {
          return void res.status(409).json({ error: "Draft not complete" });
        }
        if (playerSide === "B") st.blueLocked = true;
        else st.redLocked = true;
      } else if (op === "undoLast") {
        const lastIdx = st.currentTurn - 1;
        if (lastIdx < 0) return void res.status(409).json({ error: "Nothing to undo" });

        if (Number.isInteger(index) && index !== lastIdx) {
          return void res.status(400).json({ error: "Index must equal last turn" });
        }

        if (sideLocked(st, playerSide))
          return void res.status(409).json({ error: "Side locked" });

        const lastTok = st.draftSequence[lastIdx];
        const lastSide = sideOfTok(lastTok);
        if (lastSide !== playerSide)
          return void res.status(403).json({ error: "Wrong side for undo" });

        if (!st.picks[lastIdx])
          return void res.status(409).json({ error: "Slot already empty" });
        st.picks[lastIdx] = null;
        st.currentTurn = lastIdx;
        // after jumping back, give fresh grace for whoever is now active
        st = resetGraceForNewTurn(st, now);
      } else {
        return void res.status(400).json({ error: "Invalid op" });
      }

      const upd = await pool.query(
        `UPDATE hsr_draft_sessions
            SET state = $2::jsonb,
                last_activity_at = now()
          WHERE session_key = $1::text
          RETURNING mode, team1, team2, state, featured, is_complete, last_activity_at, completed_at,
                    cost_profile_id, cost_limit, penalty_per_point`,
        [key, JSON.stringify(st)]
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
router.get("/api/hsr/cost-presets/my", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  try {
    const q = await pool.query(
      `SELECT id, owner_user_id, name, char_ms, lc_phase, created_at, updated_at
         FROM hsr_cost_presets
        WHERE owner_user_id = $1::text
        ORDER BY created_at ASC
        LIMIT 2`,
      [viewer.id]
    );
    const data = q.rows.map((r) => ({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      lcPhase: r.lc_phase,
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
router.get("/api/hsr/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  try {
    const q = await pool.query(
      `SELECT id, owner_user_id, name, char_ms, lc_phase, created_at, updated_at
         FROM hsr_cost_presets
        WHERE id = $1::uuid`,
      [id]
    );
    if (q.rows.length === 0)
      return void res.status(404).json({ error: "Not found" });
    const r = q.rows[0];
    if (r.owner_user_id !== viewer.id)
      return void res.status(403).json({ error: "Forbidden" });
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      lcPhase: r.lc_phase,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load preset" });
  }
});

/* ───────────────── Cost Presets: create ───────────────── */
router.post("/api/hsr/cost-presets", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const body = sanitizeCostBody(req.body);
  if (!body) return void res.status(400).json({ error: "Invalid body" });

  try {
    // enforce max 2
    const cnt = await pool.query(
      `SELECT COUNT(*)::int AS c FROM hsr_cost_presets WHERE owner_user_id = $1::text`,
      [viewer.id]
    );
    if ((cnt.rows[0]?.c ?? 0) >= 2) {
      return void res.status(409).json({ error: "Preset limit reached (2)" });
    }

    const ins = await pool.query(
      `INSERT INTO hsr_cost_presets (owner_user_id, name, char_ms, lc_phase)
       VALUES ($1::text, $2::text, $3::jsonb, $4::jsonb)
       RETURNING id, owner_user_id, name, char_ms, lc_phase, created_at, updated_at`,
      [
        viewer.id,
        body.name,
        JSON.stringify(body.char_ms),
        JSON.stringify(body.lc_phase),
      ]
    );

    const r = ins.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      lcPhase: r.lc_phase,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create preset" });
  }
});

/* ───────────────── Cost Presets: update ───────────────── */
router.put("/api/hsr/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  const body = sanitizeCostBody(req.body);
  if (!body) return void res.status(400).json({ error: "Invalid body" });

  try {
    const own = await pool.query(
      `SELECT owner_user_id FROM hsr_cost_presets WHERE id = $1::uuid`,
      [id]
    );
    if (own.rows.length === 0)
      return void res.status(404).json({ error: "Not found" });
    if (own.rows[0].owner_user_id !== viewer.id)
      return void res.status(403).json({ error: "Forbidden" });

    const upd = await pool.query(
      `UPDATE hsr_cost_presets
          SET name = $2::text,
              char_ms = $3::jsonb,
              lc_phase = $4::jsonb,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, name, char_ms, lc_phase, created_at, updated_at`,
      [id, body.name, JSON.stringify(body.char_ms), JSON.stringify(body.lc_phase)]
    );

    const r = upd.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      charMs: r.char_ms,
      lcPhase: r.lc_phase,
      createdAt: r.created_at,
      UpdatedAt: r.updated_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update preset" });
  }
});

/* ───────────────── Cost Presets: delete ───────────────── */
router.delete("/api/hsr/cost-presets/:id", requireLogin, async (req, res) => {
  const viewer = (req as any).user as { id: string };
  const { id } = req.params as { id: string };
  try {
    const own = await pool.query(
      `SELECT owner_user_id FROM hsr_cost_presets WHERE id = $1::uuid`,
      [id]
    );
    if (own.rows.length === 0)
      return void res.status(404).json({ error: "Not found" });
    if (own.rows[0].owner_user_id !== viewer.id)
      return void res.status(403).json({ error: "Forbidden" });

    await pool.query(`DELETE FROM hsr_cost_presets WHERE id = $1::uuid`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete preset" });
  }
});

/* ───────────────── DELETE unfinished session (owner only) ───────────────── */
router.delete(
  "/api/hsr/sessions/:key",
  requireLogin,
  async (req, res): Promise<void> => {
    const viewer = (req as any).user as { id: string };
    const { key } = req.params as { key: string };

    try {
      const chk = await pool.query(
        `SELECT owner_user_id, is_complete
           FROM hsr_draft_sessions
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
        `DELETE FROM hsr_draft_sessions
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
