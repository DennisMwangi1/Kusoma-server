import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * TLS for managed Postgres (Neon, Supabase, RDS, Cloud SQL).
 *
 * Every managed provider requires TLS, and most present a certificate chain
 * Node does not trust out of the box — so `sslmode=require` in the URL alone
 * throws SELF_SIGNED_CERT_IN_CHAIN. Providers differ in whether they publish a
 * CA bundle, so:
 *
 *   - Local/Docker (no sslmode, or sslmode=disable) -> no TLS.
 *   - sslmode=require|prefer                        -> TLS, chain not verified.
 *   - DATABASE_CA_CERT set                          -> TLS, chain verified.
 *
 * The middle case is what nearly every managed provider's copy-paste URL
 * needs. It encrypts the connection but does not authenticate the server, so
 * set DATABASE_CA_CERT in production if your provider publishes a root.
 */
function sslConfig(url: string): PoolConfig["ssl"] {
  const mode = new URL(url).searchParams.get("sslmode");
  if (!mode || mode === "disable") return undefined;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: sslConfig(env.databaseUrl),
  // Managed providers cap connections far lower than a local instance, and
  // several close idle sockets server-side.
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // A pooled socket dropped while idle — common with managed Postgres. The
  // pool replaces it; log rather than let it reach the unhandled handler.
  console.error("db: idle client error", err.message);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
