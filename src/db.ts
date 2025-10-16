import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const ssl =
  process.env.PGSSL_CA
    ? { rejectUnauthorized: true, ca: process.env.PGSSL_CA.replace(/\\n/g, "\n") }
    : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 8,                      
  idleTimeoutMillis: 30_000,  
  connectionTimeoutMillis: 10_000,
  keepAlive: true,             
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});
