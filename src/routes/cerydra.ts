import express from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/requireAdmin";

const router = express.Router();

/* ─────────── GET /api/cerydra/balance ─────────── */
router.get("/api/cerydra/balance", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, costs
      FROM cerydra_costs
      ORDER BY name ASC
    `);

    const characters = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      costs: row.costs,
    }));

    res.json({ characters });
  } catch (err) {
    console.error("DB error (cerydra balance)", err);
    res.status(500).json({ error: "Failed to fetch Cerydra balance data" });
  }
});

/* ─────────── PUT /api/admin/cerydra-balance ─────────── */
router.put("/api/admin/cerydra-balance", requireAdmin, async (req, res) => {
  const { characters } = req.body;

  if (!Array.isArray(characters)) {
    res.status(400).json({ error: "Missing characters array" });
    return;
  }

  try {
    await pool.query("BEGIN");
    await pool.query("DELETE FROM cerydra_costs");

    for (const c of characters) {
      if (!c.id || !c.name || !Array.isArray(c.costs) || c.costs.length !== 7) {
        throw new Error(`Invalid character entry for id ${c.id || "unknown"}`);
      }

      await pool.query(
        `INSERT INTO cerydra_costs (id, name, costs)
         VALUES ($1, $2, $3)
         ON CONFLICT (id)
         DO UPDATE SET name = $2, costs = $3`,
        [c.id, c.name, JSON.stringify(c.costs)]
      );
    }

    await pool.query("COMMIT");
    res.status(200).json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (cerydra balance PUT)", err);
    res.status(500).json({ error: "Failed to update Cerydra balance data" });
  }
});

/* ─────────── GET /api/cerydra/cone-balance ─────────── */
router.get("/api/cerydra/cone-balance", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, costs, image_url as "imageUrl", subname, rarity, limited
      FROM cerydra_cone_costs
      ORDER BY rarity DESC, name ASC
    `);

    const cones = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      costs: row.costs,
      imageUrl: row.imageUrl,
      subname: row.subname,
      rarity: row.rarity,
      limited: row.limited,
    }));

    res.json({ cones });
  } catch (err) {
    console.error("DB error (cerydra cone balance)", err);
    res.status(500).json({ error: "Failed to fetch Cerydra cone balance data" });
  }
});


/* ─────────── PUT /api/admin/cerydra-cone-balance ─────────── */
router.put("/api/admin/cerydra-cone-balance", requireAdmin, async (req, res) => {
  const { cones } = req.body;

  if (!Array.isArray(cones)) {
    res.status(400).json({ error: "Missing cones array" });
    return;
  }

  try {
    await pool.query("BEGIN");

    for (const c of cones) {
      if (!c.id || !c.name || !Array.isArray(c.costs) || c.costs.length !== 5) {
        throw new Error(`Invalid cone entry for id ${c.id || "unknown"}`);
      }

      await pool.query(
        `INSERT INTO cerydra_cone_costs (id, name, costs, image_url, subname, rarity)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id)
         DO UPDATE SET 
           name = $2, 
           costs = $3,
           image_url = $4,
           subname = $5,
           rarity = $6`,
        [
          c.id,
          c.name,
          JSON.stringify(c.costs),
          c.imageUrl,
          c.subname || null,
          c.rarity,
        ]
      );
    }

    await pool.query("COMMIT");
    res.status(200).json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (cerydra cone balance PUT)", err);
    res.status(500).json({ error: "Failed to update Cerydra cone balance data" });
  }
});

export default router;
