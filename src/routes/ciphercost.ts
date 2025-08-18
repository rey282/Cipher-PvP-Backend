// src/routes/cipherCost.ts
import express from "express";
import NodeCache from "node-cache";
import { pool } from "../db";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });

/** Helpers */
function toFloat(n: any): number {
  if (n == null) return 0;
  if (typeof n === "number") return n;
  if (typeof n === "string") return parseFloat(n);
  if (typeof n === "object" && "$numberDecimal" in n) {
    return parseFloat((n as any)["$numberDecimal"]);
  }
  return Number(n) || 0;
}
function padToLen(arr: number[], len: number, fill = 0): number[] {
  const out = arr.slice(0, len);
  while (out.length < len) out.push(fill);
  return out;
}

/* ─────────────────────────────────────────────────────────
   GET /api/cipher/balance
   Pull characters from YANYAN API and normalize costs [E0..E6]
   ───────────────────────────────────────────────────────── */
router.get("/api/cipher/balance", async (req, res): Promise<void> => {
  const cacheKey = "cipher_char_balance";
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const base = process.env.YANYAN_API_URL;
  if (!base) {
    res.status(500).json({ error: "YANYAN_API_URL not set in environment" });
    return;
  }

  try {
    // If on Node < 18, polyfill fetch (node-fetch) instead.
    const r = await fetch(`${base.replace(/\/+$/, "")}/getCharacters`);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`YANYAN getCharacters failed: ${r.status} ${text}`);
    }

    const raw = await r.json();
    const characters = (Array.isArray(raw) ? raw : []).map((c: any) => {
      const costs = padToLen((c.cost || []).map((x: any) => toFloat(x)), 7, 0);
      return {
        code: String(c.code || "").trim().toLowerCase(),
        name: String(c.name || ""),
        subname: String(c.subname || ""),
        rarity:
          typeof c.rarity === "string"
            ? parseInt(c.rarity, 10)
            : Number(c.rarity || 0),
        imageUrl: String(c.imageUrl || c.imageURL || c.img || ""),
        imageId: String(c.imageId || ""),
        costs, // [E0..E6]
      };
    });

    const payload = { characters };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("Cipher balance error:", err);
    res.status(500).json({ error: "Failed to fetch cipher character costs" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/cipher/cone-balance
// Uses cerydra_cone_balance table. Costs come from `limited`:
//   limited=true  -> [0.25, 0.25, 0.5, 0.5, 0.75]  (S1..S5)
//   limited=false -> [0, 0, 0, 0, 0]
// ─────────────────────────────────────────────────────────
router.get("/api/cipher/cone-balance", async (req, res): Promise<void> => {
  const cacheKey = "cipher_cone_balance";
  const cached = cache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  // S1..S5 schedule for limited cones
  const LIMITED_SCHEDULE = [0.25, 0.25, 0.5, 0.5, 0.75];

  try {
    const { rows } = await pool.query(
      `SELECT id, name, subname, rarity, image_url, limited
         FROM cerydra_cone_costs
        ORDER BY (NULLIF(rarity, '')::int) DESC NULLS LAST, name ASC`
    );

    const cones = rows.map((r: any) => {
      const rarityNum =
        typeof r.rarity === "string" ? parseInt(r.rarity, 10) || 0 : Number(r.rarity || 0);

      return {
        id: String(r.id),
        name: String(r.name),
        subname: String(r.subname || ""),
        rarity: rarityNum,
        imageUrl: String(r.image_url || ""),
        limited: !!r.limited,
        // derive cipher costs from `limited`
        costs: r.limited ? [...LIMITED_SCHEDULE] : [0, 0, 0, 0, 0],
      };
    });

    const payload = { cones };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("Cipher cone-balance error:", err);
    res.status(500).json({ error: "Failed to fetch cipher cone costs" });
  }
});


export default router;
