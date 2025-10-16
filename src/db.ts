import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// --- Force connection to Supabase pooled port (6543) ---
const url = new URL(process.env.DATABASE_URL);
if (!url.port) url.port = "6543"; 
url.searchParams.set("sslmode", "require"); 

// --- SSL config (keep yours) ---
const ssl =
  process.env.PGSSL_CA
    ? { rejectUnauthorized: true, ca: process.env.PGSSL_CA.replace(/\\n/g, "\n") }
    : { rejectUnauthorized: false };

// --- Prevent multiple pools ---
import type { PoolConfig } from "pg";
declare global {
  var __pgPool__: Pool | undefined;
}

const poolConfig: PoolConfig = {
  connectionString: url.toString(),
  ssl,
  max: 4, 
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  application_name: "cipher-backend",
};

export const pool = global.__pgPool__ ?? new Pool(poolConfig);
if (process.env.NODE_ENV !== "production") {
  global.__pgPool__ = pool;
}

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});
