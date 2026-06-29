import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Log a warning but don't throw — let the server start so the healthcheck
  // can respond. Routes that use the DB will fail at request time with a clear error.
  console.warn(
    "[db] WARNING: DATABASE_URL is not set. Database operations will fail.",
  );
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
