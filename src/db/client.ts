import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = new Pool({ connectionString: env.databaseUrl });

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
