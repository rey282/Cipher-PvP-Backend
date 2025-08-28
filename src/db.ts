// db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, 
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
