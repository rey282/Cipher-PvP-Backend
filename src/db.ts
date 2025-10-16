// db.ts
import { Pool, type PoolConfig } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// ── Build a URL so we can enforce pooled port (6543) in production only.
let connectUrl: string;
try {
  const u = new URL(process.env.DATABASE_URL);

  const isProd = process.env.NODE_ENV === "production";
  // In prod, force the Transaction pooler port (6543).
  if (isProd) {
    if (!u.hostname.includes("pooler.supabase.com")) {
      console.warn("[DB] Warning: Host does not look like the pooler (expected *.pooler.supabase.com).");
    }
    u.port = "6543";
    u.searchParams.set("sslmode", "require");
  }

  connectUrl = u.toString();
} catch {
  // If DATABASE_URL isn't a valid URL string, keep as-is (but likely misconfigured)
  connectUrl = process.env.DATABASE_URL!;
  console.warn("[DB] DATABASE_URL is not a valid URL; using raw string.");
}

const poolConfig: PoolConfig = {
  connectionString: connectUrl,
  // Supabase pooler works with rejectUnauthorized: false; keep CA path if you use it
  ssl: process.env.PGSSL_CA
    ? { rejectUnauthorized: true, ca: process.env.PGSSL_CA.replace(/\\n/g, "\n") }
    : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX ?? (process.env.NODE_ENV === "production" ? 4 : 8)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  application_name: "cipher-backend",
};

// Prevent duplicate pools in dev/hot-reload
declare global {
  // eslint-disable-next-line no-var
  var __pgPool__: Pool | undefined;
}
export const pool = global.__pgPool__ ?? new Pool(poolConfig);
if (process.env.NODE_ENV !== "production") global.__pgPool__ = pool;

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

// Optional: quick startup check (remove later)
(async () => {
  try {
    const r = await pool.query<{ port: number }>("select inet_server_port() as port");
    console.log("[DB] connected on port", r.rows[0].port); // expect 6543 in prod, 5432 locally
  } catch (e) {
    console.error("[DB] startup test failed:", e);
  }
})();
