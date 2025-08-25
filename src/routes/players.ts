import express from "express";
import { pool } from "../db";
import NodeCache from "node-cache";
import { SEASONS, seasonFromQuery, SeasonKey } from "../utils/seasons";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });
const MAX_PRESET_DESC_LEN = 300;

/* ───────────── helper: ensure self OR superuser (no admin bypass) ───────────── */
const SUPERUSER_ID = process.env.SUPERUSER_DISCORD_ID;

async function ensureSelfOrSuperuser(
  req: express.Request,
  res: express.Response,
  targetId: string
): Promise<boolean> {
  const viewer = req.user as { id?: string } | undefined;

  if (!viewer?.id) {
    res.status(401).json({ error: "Not logged in" });
    return false;
  }
  if (!targetId) {
    res.status(400).json({ error: "Missing :id parameter" });
    return false;
  }

  // allow if self OR superuser
  if (viewer.id === targetId || viewer.id === SUPERUSER_ID) return true;

  // IMPORTANT: admins do NOT bypass here
  res.status(403).json({ error: "Unauthorized: presets are private" });
  return false;
}


function parseExpectedCycleInput(v: any): number | null {
  // allow explicit null to clear the value
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return NaN as any; // invalid
  return n;
}


/* ───────────── Team Preset helpers ───────────── */
type PresetSlot = {
  characterId: string;
  eidolon: number;        // 0..6
  lightConeId: string;    // "" allowed
  superimpose: number;    // 1..5
};

function isSlot(x: any): x is PresetSlot {
  return x &&
    typeof x.characterId === "string" && x.characterId.length > 0 &&
    Number.isInteger(x.eidolon) && x.eidolon >= 0 && x.eidolon <= 6 &&
    typeof x.lightConeId === "string" &&
    Number.isInteger(x.superimpose) && x.superimpose >= 1 && x.superimpose <= 5;
}
function isSlotsArray4(x: any): x is PresetSlot[] {
  return Array.isArray(x) && x.length === 4 && x.every(isSlot);
}
function sanitizeName(name: any): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim();
  if (t.length < 1 || t.length > 40) return null;
  return t;
}

/* ─────────────────────────────────────────────────────────
   GET /api/players
   ───────────────────────────────────────────────────────── */
router.get("/api/players", async (req, res) => {
  const seasonKey = String(req.query.season);
  const season = seasonFromQuery(seasonKey);
  const cacheKey = `player_stats_${season.table || "all"}`;

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
   LEFT JOiN discord_usernames d ON p.discord_id = d.discord_id
    ORDER BY p.elo DESC;
      `;

      const matchCount = await pool.query(
        season.start && !season.end
          ? `SELECT COUNT(*) FROM matches WHERE timestamp >= $1`
          : season.start && season.end
          ? `SELECT COUNT(*) FROM matches WHERE timestamp BETWEEN $1 AND $2`
          : `SELECT COUNT(*) FROM matches`,
        season.start
          ? season.end
            ? [season.start, season.end]
            : [season.start]
          : []
      );
      totalMatches = Number(matchCount.rows[0].count || 0);
    } else {
      const unionSQL = Object.values(SEASONS)
        .filter((s) => s.table)
        .map((s) => `SELECT * FROM ${s.table}`)
        .join(" UNION ALL ");

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
    ORDER BY elo DESC;
      `;

      const matchCount = await pool.query(`SELECT COUNT(*) FROM matches`);
      totalMatches = Number(matchCount.rows[0].count || 0);
    }

    const { rows } = await pool.query(q);
    const response = {
      data: rows,
      totalMatches,
      lastFetched: new Date().toISOString(),
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("DB error (players)", err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

/* ─────────────────────────────────────────────────────────
   GET /api/player/:id
   ───────────────────────────────────────────────────────── */
router.get("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const seasonKey = String(req.query.season ?? "players") as SeasonKey;
  const season = seasonFromQuery(seasonKey);
  const cacheKey = `player_profile_${id}_season_${seasonKey}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    let rows: any[] = [];

    if (season.table) {
      const sql = `
        SELECT
          pf.discord_id,
          COALESCE(d.global_name, d.username, pf.nickname) AS display_name,
          d.username,
          d.avatar,
          COALESCE(ps.elo, 0)           AS elo,
          COALESCE(ps.games_played, 0)  AS games_played,
          COALESCE(ps.win_rate, 0)      AS win_rate,
          pf.description,
          pf.banner_url,
          pf.color
        FROM players pf
   LEFT JOIN discord_usernames d  ON pf.discord_id = d.discord_id
   LEFT JOIN ${season.table} ps   ON pf.discord_id = ps.discord_id
       WHERE pf.discord_id = $1
       LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));
    } else {
      const unionSQL = Object.values(SEASONS)
        .filter((s) => s.table)
        .map((s) => `SELECT * FROM ${s.table}`)
        .join(" UNION ALL ");

      const sql = `
        WITH u AS (${unionSQL})
        SELECT p.discord_id,
               COALESCE(d.global_name, d.username, p.nickname) AS display_name,
               d.username,
               d.avatar,
               AVG(u.elo) AS elo,
               SUM(u.games_played)::int AS games_played,
               COALESCE(
                 SUM(u.win_rate * u.games_played)
                 / NULLIF(SUM(u.games_played), 0), 0) AS win_rate,
               p.description,
               p.banner_url,
               p.color
        FROM players p
   LEFT JOIN discord_usernames d ON p.discord_id = d.discord_id
   LEFT JOIN u ON p.discord_id = u.discord_id
       WHERE p.discord_id = $1
    GROUP BY p.discord_id, d.global_name, d.username, d.avatar,
             p.nickname, p.description, p.banner_url, p.color
       LIMIT 1;
      `;
      ({ rows } = await pool.query(sql, [id]));
    }

    if (!rows.length) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    cache.set(cacheKey, rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error("DB error (player)", err);
    res.status(500).json({ error: "Failed to fetch player" });
  }
});

/* ─────────────────────────────────────────────────────────
   PATCH /api/player/:id (self or admin)
   ───────────────────────────────────────────────────────── */
router.patch("/api/player/:id", async (req, res) => {
  const { id } = req.params;
  const { description, banner_url } = req.body as {
    description?: string;
    banner_url?: string;
  };

  const viewer = req.user as { id?: string } | undefined;

  if (!viewer || viewer.id !== id) {
    const result = await pool.query(
      `SELECT 1 FROM admin_users WHERE discord_id = $1`,
      [viewer?.id]
    );
    const isAdmin = ((result?.rowCount ?? 0) > 0);
    if (!isAdmin) {
      res.sendStatus(403);
      return;
    }
  }

  if (description === undefined && banner_url === undefined) {
    res.status(400).json({ error: "Nothing to update" });
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

    // Invalidate all seasonal cache versions
    (Object.keys(SEASONS) as SeasonKey[]).forEach((k) =>
      cache.del(`player_profile_${id}_season_${k}`)
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("DB error (patch player)", err);
    res.status(500).json({ error: "Failed to update player" });
  }
});

/* ─────────────────────────────────────────────────────────
   Team Presets (self-or-admin)
   GET    /api/player/:id/presets
   POST   /api/player/:id/presets           { name, slots[4] }
   PATCH  /api/player/:id/presets/:presetId { name?, slots?[4] }
   DELETE /api/player/:id/presets/:presetId
   ───────────────────────────────────────────────────────── */

// GET /api/player/:id/presets
router.get("/api/player/:id/presets", async (req, res) => {
  const userId = req.params.id;
  if (!(await ensureSelfOrSuperuser(req, res, userId))) return;

  try {
    const { rows: presets } = await pool.query(
    `SELECT id, name, description, expected_cycle, updated_at
      FROM team_presets
      WHERE user_id = $1
      ORDER BY updated_at DESC`,
    [userId]
  );

    if (presets.length === 0) {
      res.json({ presets: [] });
      return;
    }

    const ids = presets.map((p: any) => p.id);
    const { rows: slots } = await pool.query(
      `SELECT preset_id, slot_index, character_id, eidolon, light_cone_id, superimpose
         FROM team_preset_slots
        WHERE preset_id = ANY($1::text[])`,
      [ids]
    );

    const byPreset: Record<string, any[]> = {};
    for (const s of slots) (byPreset[s.preset_id] ||= []).push(s);

    const out = presets.map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description || "",
      updated_at: p.updated_at,
      expectedCycle: p.expected_cycle,
      slots: (byPreset[p.id] || [])
        .sort((a, b) => a.slot_index - b.slot_index)
        .map((s) => ({
          characterId: s.character_id,
          eidolon: s.eidolon,
          lightConeId: s.light_cone_id,
          superimpose: s.superimpose,
        })),
    }));

    res.json({ presets: out });
  } catch (err) {
    console.error("GET presets error", err);
    res.status(500).json({ error: "Failed to fetch presets" });
  }
});

// POST /api/player/:id/presets  (Promise chain only in this one to satisfy TS overload)
router.post("/api/player/:id/presets", (req, res) => {
  const userId = req.params.id;

  ensureSelfOrSuperuser(req, res, userId)
    .then((ok) => {
      if (!ok) return; // response already sent
      const name = sanitizeName(req.body?.name);
      const slots = req.body?.slots;
      const rawDesc = typeof req.body?.description === "string" ? req.body.description : "";
      const description = rawDesc.trim();
      if (description.length > MAX_PRESET_DESC_LEN) {
        res.status(400).json({ error: `Description too long (max ${MAX_PRESET_DESC_LEN} characters)` });
        return;
      }

      if (!name) {
        res.status(400).json({ error: "Invalid name" });
        return;
      }
      if (!isSlotsArray4(slots)) {
        res.status(400).json({ error: "slots must be an array of 4 valid slot objects" });
        return;
      }

      const expectedCycleRaw = req.body?.expectedCycle;
      let expectedCycle: number | null | undefined = undefined;
      if (expectedCycleRaw !== undefined) {
        expectedCycle = parseExpectedCycleInput(expectedCycleRaw);
        if (Number.isNaN(expectedCycle as any)) {
          res.status(400).json({ error: "Invalid expectedCycle (must be integer ≥ 0 or null)" });
          return;
        }
      }

      return pool
        .query(
          `SELECT COUNT(*)::int AS cnt FROM team_presets WHERE user_id = $1`,
          [userId]
        )
        .then(({ rows }) => {
          const cnt = rows?.[0]?.cnt ?? 0;
          if (cnt >= 50) {
            res.status(409).json({ error: "Max presets reached (50)" });
            return;
          }
          return pool.query("BEGIN").then(() =>
            pool
              .query(
                `INSERT INTO team_presets (user_id, name, description, expected_cycle)
                  VALUES ($1, $2, $3, $4)
                  RETURNING id, name, description, expected_cycle, updated_at`,
                  [ userId, name, description || "", expectedCycle ?? null ]
              )
              .then(({ rows: created }) => {
                const presetId = created[0].id as string;

                const values: any[] = [];
                const placeholders: string[] = [];
                for (let i = 0; i < 4; i++) {
                  const s = slots[i];
                  values.push(presetId, i, s.characterId, s.eidolon, s.lightConeId, s.superimpose);
                  const base = i * 6;
                  placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
                }

                return pool
                  .query(
                    `INSERT INTO team_preset_slots
                      (preset_id, slot_index, character_id, eidolon, light_cone_id, superimpose)
                     VALUES ${placeholders.join(",")}`,
                    values
                  )
                  .then(() =>
                    pool.query("COMMIT").then(() =>
                      res.status(201).json({
                        preset: {
                          id: presetId,
                          name: created[0].name,
                          description: created[0].description,
                          updated_at: created[0].updated_at,
                          expectedCycle: created[0].expected_cycle,
                          slots,
                        },
                      })
                    )
                  );
              })
              .catch((err) =>
                pool.query("ROLLBACK").finally(() => {
                  console.error("POST preset error", err);
                  if ((err as any)?.code === "23505") {
                    res.status(409).json({ error: "A preset with this name already exists." });
                  } else {
                    res.status(500).json({ error: "Failed to create preset" });
                  }
                })
              )
          );
        });
    })
    .catch((err) => {
      console.error("POST preset outer error", err);
      res.status(500).json({ error: "Failed to create preset" });
    });
});

// PATCH /api/player/:id/presets/:presetId
router.patch("/api/player/:id/presets/:presetId", async (req, res) => {
  const userId = req.params.id;
  const presetId = req.params.presetId;
  if (!(await ensureSelfOrSuperuser(req, res, userId))) return;

  // verify ownership
  const { rows: own } = await pool.query(
    `SELECT user_id FROM team_presets WHERE id = $1`,
    [presetId]
  );
  if (own.length === 0 || own[0].user_id !== userId) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  const expectedCycleRaw = req.body?.expectedCycle;
  let expectedCycleProvided = false;
  let expectedCycle: number | null = null;

  if (expectedCycleRaw !== undefined) {
    expectedCycleProvided = true;
    expectedCycle = parseExpectedCycleInput(expectedCycleRaw);
    if (Number.isNaN(expectedCycle as any)) {
      res.status(400).json({ error: "Invalid expectedCycle (must be integer ≥ 0 or null)" });
      return;
    }
  }


  const nameRaw = req.body?.name;
  const slots = req.body?.slots;
  const descriptionRaw = req.body?.description;

  const name = nameRaw === undefined ? undefined : sanitizeName(nameRaw);
  if (nameRaw !== undefined && !name) {
    res.status(400).json({ error: "Invalid name" });
    return;
  }
  if (slots !== undefined && !isSlotsArray4(slots)) {
    res
      .status(400)
      .json({ error: "slots must be an array of 4 valid slot objects" });
    return;
  }

  const description =
    descriptionRaw === undefined ? undefined : String(descriptionRaw).trim();

  if (typeof description === "string" && description.length > MAX_PRESET_DESC_LEN) {
    res.status(400).json({ error: `Description too long (max ${MAX_PRESET_DESC_LEN} characters)` });
    return;
  }



  try {
    await pool.query("BEGIN");

    if (name !== undefined) {
      await pool.query(
        `UPDATE team_presets SET name = $1, updated_at = now() WHERE id = $2`,
        [name, presetId]
      );
    }

    if (description !== undefined) {
      await pool.query(
        `UPDATE team_presets SET description = $1, updated_at = now() WHERE id = $2`,
        [description, presetId]
      );
    }

    if (expectedCycleProvided) {
      await pool.query(
        `UPDATE team_presets SET expected_cycle = $1, updated_at = now() WHERE id = $2`,
        [expectedCycle, presetId]
      );
    }


    if (slots !== undefined) {
      await pool.query(
        `DELETE FROM team_preset_slots WHERE preset_id = $1`,
        [presetId]
      );

      const values: any[] = [];
      const placeholders: string[] = [];
      for (let i = 0; i < 4; i++) {
        const s = slots[i];
        values.push(
          presetId,
          i,
          s.characterId,
          s.eidolon,
          s.lightConeId,
          s.superimpose
        );
        const base = i * 6;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
        );
      }

      await pool.query(
        `INSERT INTO team_preset_slots
          (preset_id, slot_index, character_id, eidolon, light_cone_id, superimpose)
         VALUES ${placeholders.join(",")}`,
        values
      );

      await pool.query(
        `UPDATE team_presets SET updated_at = now() WHERE id = $1`,
        [presetId]
      );
    }

    await pool.query("COMMIT");

    const { rows } = await pool.query(
      `SELECT p.id AS preset_id, p.name, p.description, p.expected_cycle, p.updated_at,
              s.slot_index, s.character_id, s.eidolon, s.light_cone_id, s.superimpose
        FROM team_presets p
    LEFT JOIN team_preset_slots s ON s.preset_id = p.id
        WHERE p.id = $1
        ORDER BY s.slot_index ASC`,
      [presetId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }

    const slotsOut = rows
      .filter((r) => r.slot_index !== null)
      .sort((a, b) => a.slot_index - b.slot_index)
      .map((r) => ({
        characterId: r.character_id,
        eidolon: r.eidolon,
        lightConeId: r.light_cone_id,
        superimpose: r.superimpose,
      }));

    res.json({
      preset: {
        id: rows[0].preset_id,
        name: rows[0].name,
        description: rows[0].description || "",
        updated_at: rows[0].updated_at,
        expectedCycle: rows[0].expected_cycle,
        slots: slotsOut,
      },
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("PATCH preset error", err);
    if ((err as any)?.code === "23505") {
      res.status(409).json({ error: "A preset with this name already exists." });
    } else {
      res.status(500).json({ error: "Failed to update preset" });
    }
  }
});

// DELETE /api/player/:id/presets/:presetId
router.delete("/api/player/:id/presets/:presetId", async (req, res) => {
  const userId = req.params.id;
  const presetId = req.params.presetId;
  if (!(await ensureSelfOrSuperuser(req, res, userId))) return;

  try {
    // verify ownership
    const { rows: own } = await pool.query(
      `SELECT user_id FROM team_presets WHERE id = $1`,
      [presetId]
    );
    if (own.length === 0 || own[0].user_id !== userId) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }

    await pool.query(`DELETE FROM team_presets WHERE id = $1`, [presetId]);
    res.status(204).end();
  } catch (err) {
    console.error("DELETE preset error", err);
    res.status(500).json({ error: "Failed to delete preset" });
  }
});

export default router;
