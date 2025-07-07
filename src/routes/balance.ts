import express from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/requireAdmin";

const router = express.Router();

// GET /api/balance
router.get("/api/balance", async (_req, res) => {
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

// PUT /api/admin/balance
router.put("/api/admin/balance", requireAdmin, async (req, res) => {
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
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("DB error (balance PUT)", err);
    res.status(500).json({ error: "Failed to update balance data" });
  }
});

// ────────────────────────────────
// Internal: Recalculate points
// ────────────────────────────────
async function recomputePlayerPoints() {
  const res = await fetch(`${process.env.YANYAN_API_URL}/getUsers`);
  if (!res.ok) {
    throw new Error(`getUsers fetch failed: ${res.status}`);
  }
  const users: {
    discordId: string;
    profileCharacters: { id: string; eidolon: number }[];
  }[] = await res.json();

  const { rows } = await pool.query<{ id: string; costs: number[] }>(
    "SELECT id, costs FROM balance_costs"
  );

  const costMap: Record<string, number[]> = {};
  rows.forEach((r) => (costMap[r.id] = r.costs));

  const updates = users.map((u) => {
    const total = u.profileCharacters.reduce((sum, pc) => {
      const costs = costMap[pc.id];
      if (!costs) return sum;
      const e = Math.min(Math.max(pc.eidolon, 0), 6);
      return sum + costs[e];
    }, 0);
    return { id: u.discordId, points: total };
  });

  const ids = updates.map((u) => u.id);
  const pts = updates.map((u) => u.points);

  await pool.query(
    `
    UPDATE players AS p
       SET points = u.points
      FROM (SELECT UNNEST($1::text[]) AS id,
                   UNNEST($2::int[])  AS points) AS u
     WHERE p.discord_id = u.id;
    `,
    [ids, pts]
  );
}

export default router;
