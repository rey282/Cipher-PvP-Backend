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
    return; // return void, not Response
  }
  next();
};

// Shared draft JSON shapes (match what the frontend sends/stores)
type ZzzMode = "2v2" | "3v3";

interface ServerPick {
  characterCode: string;
  eidolon: number;        // 0..6
  wengineId: string | null;
  superimpose: number;    // 1..5
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
    `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
       FROM zzz_draft_sessions
      WHERE session_key = $1::text`,
    [key]
  );
  if (rows.length) push(key, "update", rows[0]);
}

/* ───────────────── Helpers ───────────────── */
function isValidState(s: any): boolean {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!Array.isArray(s.draftSequence) || s.draftSequence.length === 0) return false;
  if (!Number.isInteger(s.currentTurn) || s.currentTurn < 0) return false;
  if (!Array.isArray(s.picks) || s.picks.length !== s.draftSequence.length) return false;
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

// ───────── helpers (put near your other helpers)
const isBanToken = (tok: string) => tok === "BB" || tok === "RR";
const sideOfToken = (tok: string) =>
  tok?.startsWith("B") ? "B" : tok?.startsWith("R") ? "R" : "";
const sideLocked = (s: SpectatorState, side: "B" | "R") =>
  side === "B" ? !!s.blueLocked : !!s.redLocked;


/* ───────────────── CREATE session ───────────────── */
router.post("/api/zzz/sessions", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { team1, team2, mode, state } = req.body || {};

  if (!team1 || !team2 || (mode !== "2v2" && mode !== "3v3") || !state || !isValidState(state)) {
    res.status(400).json({ error: "Missing or invalid body" });
    return;
  }
  // BEFORE generating a new key, check if the owner already has an unfinished session.
  const existing = await pool.query(
    `SELECT session_key, mode, team1, team2, state, is_complete, last_activity_at, completed_at
      FROM zzz_draft_sessions
      WHERE owner_user_id = $1::text
        AND is_complete IS NOT TRUE
      ORDER BY last_activity_at DESC
      LIMIT 1`,
    [viewer.id]
  );

  if (existing.rows.length) {
    const ex = existing.rows[0];
    const url = `${process.env.PUBLIC_BASE_URL || "https://cipher.uno"}/zzz/s/${ex.session_key}`;
    // Return the existing session instead of creating a new one
    res.json({ key: ex.session_key, url, reused: true });
    return;
  }

  const key = genKey(22);

  try {
    const { rows } = await pool.query(
      `INSERT INTO zzz_draft_sessions
         (session_key, owner_user_id, mode, team1, team2, state)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb)
       RETURNING mode, team1, team2, state, is_complete, last_activity_at, completed_at`,
      [key, viewer.id, mode, team1, team2, JSON.stringify(state)]
    );

    // Notify any early spectators (rare, but harmless)
    push(key, "update", rows[0]);

    const url = `${process.env.PUBLIC_BASE_URL || "https://cipher.uno"}/zzz/s/${key}`;
    res.json({ key, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* ───────────────── UPDATE session ───────────────── */
router.put("/api/zzz/sessions/:key", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };
  const { key } = req.params as { key: string };
  const { state, isComplete } = req.body || {};

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

  // Only update state if the key is present and the shape is valid
  const hasStateKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "state");
  const shouldUpdateState = hasStateKey && isValidState(state);
  const stateJson = shouldUpdateState ? JSON.stringify(state) : null;
  const isCompleteParam = typeof isComplete === "boolean" ? isComplete : null;

  try {
    const { rows } = await pool.query(
      `UPDATE zzz_draft_sessions
          SET state = COALESCE($2::jsonb, state),
              is_complete = COALESCE($3::boolean, is_complete),
              completed_at = CASE
                               WHEN $3::boolean IS TRUE AND completed_at IS NULL
                                 THEN now()
                               ELSE completed_at
                             END,
              last_activity_at = now()
        WHERE session_key = $1::text
        RETURNING mode, team1, team2, state, is_complete, last_activity_at, completed_at`,
      [key, stateJson, isCompleteParam]
    );

    if (rows.length) push(key, "update", rows[0]);
    res.json({ ok: true, stateUpdated: shouldUpdateState });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update session" });
  }
});

/* ───────────────── OWNER: fetch my open (unfinished) session ───────────────── */
router.get("/api/zzz/sessions/open", requireLogin, async (req, res): Promise<void> => {
  const viewer = (req as any).user as { id: string };

  try {
    const { rows } = await pool.query(
      `SELECT session_key, mode, team1, team2, state, is_complete, last_activity_at, completed_at
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
      is_complete: r.is_complete,
      last_activity_at: r.last_activity_at,
      completed_at: r.completed_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load open session" });
  }
});


/* ───────────────── READ one session (public) ───────────────── */
router.get("/api/zzz/sessions/:key", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };
  try {
    const { rows } = await pool.query(
      `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
         FROM zzz_draft_sessions
        WHERE session_key = $1::text`,
      [key]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load session" });
  }
});

/* ───────────────── RECENT completed matches (public) ───────────────── */
router.get("/api/zzz/matches/recent", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 12;

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
        last_activity_at
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
    }));

    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch recent matches" });
  }
});

/* ───────────────── LIVE drafts (public) ───────────────── */
router.get("/api/zzz/matches/live", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(25, rawLimit)) : 8;

  const rawMinutes = Number(req.query.minutes);
  const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 2;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        session_key,
        mode,
        team1,
        team2,
        state,
        last_activity_at
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
    }));

    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch live drafts" });
  }
});

/* ───────────────── SSE stream (public) ───────────────── */
router.get("/api/zzz/sessions/:key/stream", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // avoid proxy buffering (nginx etc.)
  (res as any).flushHeaders?.(); // if available

  // Initial snapshot or not_found
  const { rows } = await pool.query(
    `SELECT mode, team1, team2, state, is_complete, last_activity_at, completed_at
       FROM zzz_draft_sessions
      WHERE session_key = $1::text`,
    [key]
  );
  if (rows.length === 0) {
    res.write("event: not_found\ndata: {}\n\n");
    res.end();
    return;
  }

  // Register client, send initial snapshot
  addClient(key, res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(rows[0])}\n\n`);

  // Heartbeat
  const ping = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
});

// ───────────────── PLAYER ACTIONS (public) ─────────────────
// Body: { op: 'pick'|'ban'|'setMindscape'|'setSuperimpose'|'setWengine'|'setLock'|'undoLast',
//         side: 'B'|'R',
//         index?: number,
//         characterCode?: string,
//         eidolon?: number,
//         superimpose?: number,
//         wengineId?: string|null,
//         locked?: boolean }
router.post("/api/zzz/sessions/:key/actions", async (req, res): Promise<void> => {
  const { key } = req.params as { key: string };
  const { op, side, index, characterCode, eidolon, superimpose, wengineId } = req.body || {};

  if (side !== "B" && side !== "R") {
    return void res.status(400).json({ error: "Invalid side" });
  }

  // helpers (same as elsewhere)
  const sideOfToken = (tok: string) => (tok?.startsWith("B") ? "B" : tok?.startsWith("R") ? "R" : "");
  const isBanToken  = (tok: string) => tok === "BB" || tok === "RR";
  const sideLocked  = (state: SpectatorState, s: "B" | "R") => (s === "B" ? !!state.blueLocked : !!state.redLocked);

  // Only some ops need an index (now includes 'ban')
  const opsThatNeedIndex = new Set<string>([
    "pick",
    "ban",
    "setMindscape",
    "setSuperimpose",
    "setWengine",
  ]);
  const opNeedsIndex = opsThatNeedIndex.has(op);

  if (opNeedsIndex) {
    if (!Number.isInteger(index) || (index as number) < 0) {
      return void res.status(400).json({ error: "Invalid index" });
    }
  }

  try {
    const q = await pool.query(
      `SELECT mode, team1, team2, state, is_complete
         FROM zzz_draft_sessions
        WHERE session_key = $1::text`,
      [key]
    );
    if (q.rows.length === 0) {
      return void res.status(404).json({ error: "Session not found" });
    }

    const row = q.rows[0];
    if (row.is_complete === true) {
      return void res.status(409).json({ error: "Draft already completed" });
    }

    const state = row.state as SpectatorState;
    if (!isValidState(state)) {
      return void res.status(500).json({ error: "Corrupt state" });
    }

    // accessors for index ops
    const slotToken = opNeedsIndex ? state.draftSequence[index as number] : "";
    const slotSide  = opNeedsIndex ? sideOfToken(slotToken) : "";
    const isBan     = opNeedsIndex ? isBanToken(slotToken) : false;

    // quickly derive convenience sets
    const pickedCodes = state.picks
      .map((p) => (p ? p.characterCode : null))
      .filter(Boolean) as string[];

    const bannedCodes = state.picks
      .map((p, i) => (p && isBanToken(state.draftSequence[i]) ? p.characterCode : null))
      .filter(Boolean) as string[];

    // ── Ops ──────────────────────────────────────────────────────────────
    if (op === "pick") {
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      if (index !== state.currentTurn) return void res.status(409).json({ error: "Not current turn" });
      if (isBan) return void res.status(400).json({ error: "Cannot pick on ban slot" });
      if (slotSide !== side) return void res.status(403).json({ error: "Wrong side for this turn" });
      if (typeof characterCode !== "string" || !characterCode) {
        return void res.status(400).json({ error: "Missing characterCode" });
      }
      // cannot pick something that is banned
      if (bannedCodes.includes(characterCode)) {
        return void res.status(409).json({ error: "Character is banned" });
      }
      // enforce unique per side
      const mySideCodes = state.picks
        .map<string | null>((p, i) =>
          state.draftSequence[i]?.startsWith(side) ? (p ? p.characterCode : null) : null
        )
        .filter((v): v is string => typeof v === "string");
      if (mySideCodes.includes(characterCode)) {
        return void res.status(409).json({ error: "Character already picked by this side" });
      }

      state.picks[index as number] = {
        characterCode,
        eidolon: 0,
        wengineId: null,
        superimpose: 1,
      };
      state.currentTurn = Math.min(state.currentTurn + 1, state.draftSequence.length);

    } else if (op === "ban") {
      // NEW: proper ban op (server persists bans)
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      if (index !== state.currentTurn) return void res.status(409).json({ error: "Not current turn" });
      if (!isBan) return void res.status(400).json({ error: "This slot is not a ban slot" });
      if (slotSide !== side) return void res.status(403).json({ error: "Wrong side for this turn" });
      if (typeof characterCode !== "string" || !characterCode) {
        return void res.status(400).json({ error: "Missing characterCode" });
      }

      // cannot ban something that is already picked by either side
      if (pickedCodes.includes(characterCode)) {
        return void res.status(409).json({ error: "Character already picked" });
      }
      // cannot ban something already banned
      if (bannedCodes.includes(characterCode)) {
        return void res.status(409).json({ error: "Character already banned" });
      }

      state.picks[index as number] = {
        characterCode,
        // values below are placeholders; frontend renders ban slots specially anyway
        eidolon: 0,
        wengineId: null,
        superimpose: 1,
      };
      state.currentTurn = Math.min(state.currentTurn + 1, state.draftSequence.length);

    } else if (op === "setMindscape") {
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      if (slotSide !== side || isBan) return void res.status(403).json({ error: "Cannot edit opponent or ban slot" });
      const slot = state.picks[index as number];
      if (!slot) return void res.status(409).json({ error: "No character in slot" });
      slot.eidolon = Math.max(0, Math.min(6, Number(eidolon ?? 0)));

    } else if (op === "setSuperimpose") {
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      if (slotSide !== side || isBan) return void res.status(403).json({ error: "Cannot edit opponent or ban slot" });
      const slot = state.picks[index as number];
      if (!slot) return void res.status(409).json({ error: "No character in slot" });
      slot.superimpose = Math.max(1, Math.min(5, Number(superimpose ?? 1)));

    } else if (op === "setWengine") {
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      if (slotSide !== side || isBan) return void res.status(403).json({ error: "Cannot edit opponent or ban slot" });
      const slot = state.picks[index as number];
      if (!slot) return void res.status(409).json({ error: "No character in slot" });
      slot.wengineId = wengineId == null || wengineId === "" ? null : String(wengineId);

    } else if (op === "setLock") {
      const { locked } = req.body || {};
      if (typeof locked !== "boolean") return void res.status(400).json({ error: "Missing 'locked' boolean" });
      if (locked === false) return void res.status(403).json({ error: "Unlock not allowed here" });
      if (state.currentTurn < state.draftSequence.length) {
        return void res.status(409).json({ error: "Draft not complete" });
      }
      if (side === "B") state.blueLocked = true;
      else state.redLocked = true;

    } else if (op === "undoLast") {
      const lastIdx = state.currentTurn - 1;
      if (lastIdx < 0) return void res.status(409).json({ error: "Nothing to undo" });
      if (Number.isInteger(index) && index !== lastIdx) {
        return void res.status(400).json({ error: "Index must equal last turn" });
      }
      const lastTok = state.draftSequence[lastIdx];
      if (isBanToken(lastTok)) return void res.status(400).json({ error: "Cannot undo a ban slot" });
      if (sideLocked(state, side)) return void res.status(409).json({ error: "Side locked" });
      const lastSide = sideOfToken(lastTok);
      if (lastSide !== side) return void res.status(403).json({ error: "Wrong side for undo" });
      if (!state.picks[lastIdx]) return void res.status(409).json({ error: "Slot already empty" });
      state.picks[lastIdx] = null;
      state.currentTurn = lastIdx;

    } else {
      return void res.status(400).json({ error: "Invalid op" });
    }

    // persist + notify
    const upd = await pool.query(
      `UPDATE zzz_draft_sessions
          SET state = $2::jsonb,
              last_activity_at = now()
        WHERE session_key = $1::text
        RETURNING mode, team1, team2, state, is_complete, last_activity_at, completed_at`,
      [key, JSON.stringify(state)]
    );

    if (upd.rows.length) push(key, "update", upd.rows[0]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to apply action" });
  }
});

/* ───────────────── DELETE unfinished session (owner only) ───────────────── */
router.delete("/api/zzz/sessions/:key", requireLogin, async (req, res): Promise<void> => {
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
      res.status(404).json({ error: "Session not found or already finalized" });
      return;
    }

    push(key, "deleted", { key });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete session" });
  }
});


export default router;
