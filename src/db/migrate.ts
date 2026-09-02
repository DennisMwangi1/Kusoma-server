import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "./client.js";

/**
 * Apply SQL files in /drizzle. Safe to re-run — already-applied tags are skipped.
 * Used by the Docker entrypoint so Dokploy deploys do not require a manual
 * `db:push` against production.
 */
async function main(): Promise<void> {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder });
  console.log("migrate: ok");
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isEntrypoint) {
  main()
    .catch((err) => {
      console.error("migrate: failed", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
