import { Pool, type PoolConfig } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

/** Build a safe connection URL:
 * - In production: force the Transaction pooler port (6543)
 * - In dev: keep whatever you have (likely 5432)
 * - Always keep sslmode=require
 */
let connectUrl = process.env.DATABASE_URL;
try {
  const u = new URL(process.env.DATABASE_URL);
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    // In prod we force the pooled port; host should be *.pooler.supabase.com
    u.port = "6543";
    u.searchParams.set("sslmode", "require");
  } else {
    // local dev is fine on 5432
    if (!u.searchParams.get("sslmode")) {
      u.searchParams.set("sslmode", "require");
    }
  }
  connectUrl = u.toString();

  // Helpful visibility in logs
  // (username may be 'postgres.<project-ref>' on the pooler)
  // Do NOT log password.
  // eslint-disable-next-line no-console
  console.log(
    "[DB] Using host:", u.hostname,
    "port:", u.port || "(default)",
    "user:", u.username || "(none)"
  );
} catch {
  console.warn("[DB] DATABASE_URL is not a valid URL; using raw string as-is.");
}

/** IMPORTANT:
 * Supabase pooler commonly requires skipping CA verification in hosted envs like Render.
 * Traffic is still encrypted. This eliminates SELF_SIGNED_CERT_IN_CHAIN.
 */
const ssl: PoolConfig["ssl"] = { rejectUnauthorized: false };

const poolConfig: PoolConfig = {
  connectionString: connectUrl,
  ssl,
  max: Number(process.env.PG_POOL_MAX ?? (process.env.NODE_ENV === "production" ? 4 : 8)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  application_name: "cipher-backend",
};

// Prevent duplicate pools during hot-reload in dev
declare global {
  // eslint-disable-next-line no-var
  var __pgPool__: Pool | undefined;
}
export const pool = global.__pgPool__ ?? new Pool(poolConfig);
if (process.env.NODE_ENV !== "production") {
  global.__pgPool__ = pool;
}

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

// Quick connectivity check (remove later if you want)
(async () => {
  try {
    const r = await pool.query<{ port: number }>("select inet_server_port() as port");
    console.log("[DB] Connected on server port:", r.rows?.[0]?.port ?? "(unknown)");
  } catch (e) {
    console.error("[DB] Startup test failed:", e);
  }
})();
