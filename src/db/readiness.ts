import { sql } from "drizzle-orm";

import { db } from "./client.js";
import { PERMISSION_KEYS, ROLE_KEYS } from "./schema.js";

/**
 * Boot-time readiness check.
 *
 * Without this, a database that is reachable but un-migrated or un-seeded only
 * fails later, at the first real request, as a generic 500 — which is
 * miserable to debug when the server and the database are on different
 * machines. Fail loudly at startup instead, naming the exact fix.
 *
 * Deliberately does NOT exit the process: a scaffold should still boot so you
 * can hit /health and see the diagnosis, rather than crash-looping.
 */
export interface Readiness {
  ok: boolean;
  problems: string[];
}

export async function checkReadiness(): Promise<Readiness> {
  const problems: string[] = [];

  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      problems: [
        `Cannot reach the database: ${message}`,
        "Check DATABASE_URL. A managed provider usually needs ?sslmode=require;",
        "an internal platform hostname only resolves from inside that network.",
      ],
    };
  }

  // Schema present?
  const tables = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const present = new Set(tables.rows.map((r) => r.table_name));
  const expected = [
    "users",
    "roles",
    "user_roles",
    "permissions",
    "role_permissions",
    "user_relationships",
    "chat_groups",
    "chat_participants",
    "messages",
    "assignments",
    "student_performance",
  ];
  const missing = expected.filter((t) => !present.has(t));

  if (missing.length > 0) {
    problems.push(
      `Schema not applied — missing ${missing.length}/${expected.length} tables (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}).`,
      "Fix: npm run db:push",
    );
    return { ok: false, problems };
  }

  // Seed present? The RBAC tables are inert without it and every login that
  // resolves grants will fail (§5.2).
  const roleCount = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM roles`);
  const permCount = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM permissions`);
  const grantCount = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM role_permissions`,
  );

  const roles = Number(roleCount.rows[0]?.n ?? 0);
  const perms = Number(permCount.rows[0]?.n ?? 0);
  const grants = Number(grantCount.rows[0]?.n ?? 0);

  if (roles < ROLE_KEYS.length || perms < PERMISSION_KEYS.length || grants === 0) {
    problems.push(
      `Seed not applied — roles=${roles}/${ROLE_KEYS.length}, permissions=${perms}/${PERMISSION_KEYS.length}, grants=${grants}.`,
      "Every /auth/login will 500 until this runs.",
      "Fix: npm run db:seed",
    );
  }

  return { ok: problems.length === 0, problems };
}

export function reportReadiness(r: Readiness): void {
  if (r.ok) {
    console.log("db: schema and seed OK");
    return;
  }
  console.error("\n  ⚠  DATABASE NOT READY");
  for (const p of r.problems) console.error(`     ${p}`);
  console.error("");
}
