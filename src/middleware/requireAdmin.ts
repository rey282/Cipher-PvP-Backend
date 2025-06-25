import { Request, Response, NextFunction } from "express";
import { pool } from "../db";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user as any;
  if (!user || !user.id) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }

  pool.query(
    "SELECT 1 FROM admin_users WHERE discord_id = $1 LIMIT 1",
    [user.id]
  )
    .then((result) => {
      if (result.rowCount === 0) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      next();
    })
    .catch((err) => {
      console.error("Admin check failed:", err);
      res.status(500).json({ error: "Failed to check admin access" });
    });
}
