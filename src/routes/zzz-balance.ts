// src/routes/zzz-balance.ts
import express from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/requireAdmin";

const router = express.Router();

/* ─────────────────────────────────────────────── */
/* GET /api/zzz/balance  → characters + costs       */
/* ─────────────────────────────────────────────── */
router.get("/api/zzz/balance", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT code, name, subname, rarity, image_url, costs
      FROM zzz_characters
      ORDER BY rarity DESC, name ASC
    `);

    const characters = rows.map((row: any) => ({
      id: row.code,
      name: row.name,
      subname: row.subname,
      rarity: row.rarity,
      imageUrl: row.image_url,  
      costs: row.costs ?? [0, 0, 0, 0, 0, 0, 0],
    }));

    res.json({ characters });
  } catch (err) {
    console.error("DB error (zzz balance)", err);
    res.status(500).json({ error: "Failed to fetch ZZZ character balance" });
  }
});


/* ─────────────────────────────────────────────── */
/* PUT /api/admin/zzz-balance  → save characters   */
/* ─────────────────────────────────────────────── */
router.put("/api/admin/zzz-balance", requireAdmin, async (req, res) => {
  const { characters } = req.body;

  if (!Array.isArray(characters)) {
    res.status(400).json({ error: "Missing characters array" });
    return;
    }


  try {
    await pool.query("BEGIN");

    for (const c of characters) {
      if (!c.id || !Array.isArray(c.costs) || c.costs.length !== 7) {
        throw new Error(`Invalid ZZZ character entry for ${c.id}`);
      }

      await pool.query(
        `UPDATE zzz_characters
         SET costs = $1
         WHERE code = $2`,
        [JSON.stringify(c.costs), c.id]
      );
    }

    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (zzz balance PUT)", err);
    res.status(500).json({ error: "Failed to update ZZZ balance data" });
  }
});


/* ─────────────────────────────────────────────── */
/* GET /api/zzz/wengine-balance                   */
/* ─────────────────────────────────────────────── */
router.get("/api/zzz/wengine-balance", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, subname, rarity, image_url, costs
      FROM zzz_wengine
      ORDER BY rarity DESC, name ASC
    `);

    const wengines = rows.map((row: any) => ({
      id: String(row.id),
      name: row.name,
      subname: row.subname,
      rarity: Number(row.rarity) || 5,
      imageUrl: row.image_url,
      costs: row.costs ?? [0,0,0,0,0],
    }));

    res.json({ wengines });
  } catch (err) {
    console.error("DB error (zzz wengine balance)", err);
    res.status(500).json({
      error: "Failed to fetch ZZZ W-Engine balance data",
    });
  }
});


/* ─────────────────────────────────────────────── */
/* PUT /api/admin/zzz-wengine-balance             */
/* ─────────────────────────────────────────────── */
router.put("/api/admin/zzz-wengine-balance", requireAdmin, async (req, res) => {
  const { wengines } = req.body;

  if (!Array.isArray(wengines)) {
    res.status(400).json({ error: "Missing wengines array" });
    return;
    }


  try {
    await pool.query("BEGIN");

    for (const w of wengines) {
      if (!w.id || !Array.isArray(w.costs) || w.costs.length !== 5) {
        throw new Error(`Invalid W-Engine entry for id ${w.id}`);
      }

      await pool.query(
        `UPDATE zzz_wengine
         SET costs = $1
         WHERE id = $2`,
        [JSON.stringify(w.costs), w.id]
      );
    }

    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (zzz wengine balance PUT)", err);
    res.status(500).json({ error: "Failed to update ZZZ W-Engine balance" });
  }
});

export default router;
