import { eq } from "drizzle-orm";

import { hashPassword } from "../lib/password.js";
import { db, pool } from "./client.js";
import {
  PERMISSION_KEYS,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
  type PermissionKey,
  type RoleKey,
} from "./schema.js";

/**
 * Seed — §5.2 of the migration spec.
 *
 * This is not optional garnish. The RBAC tables are inert without it and
 * messages.sender_user_id has nothing to point at for bot messages. Safe to
 * re-run: every step is idempotent.
 */

const ROLE_ROWS: Array<{ key: RoleKey; name: string; description: string }> = [
  { key: "tutor", name: "Tutor", description: "The paying customer. Full read/write on their own roster." },
  { key: "guardian", name: "Parent / Guardian", description: "Read-only, scoped to the student(s) they guard." },
  { key: "student", name: "Student", description: "No app login. Interacts with the AI via Telegram only." },
  { key: "bot", name: "Kusoma Bot", description: "The AI assistant. No login, no permissions." },
];

/**
 * Guardians get :read keys and nothing else — no :write, no :send. That is
 * what makes parents read-only at the data layer rather than by hiding
 * buttons (§15).
 *
 * dashboard:read is included deliberately: GET /dashboard/summary is computed
 * across whatever students the caller is related to, so for a guardian it
 * degrades to their own child's numbers rather than 403-ing (§8.2). That is
 * the parent's landing screen, and it needs no special case on either side.
 *
 * Students and the bot get none; neither has an app session.
 */
const GRANTS: Record<RoleKey, readonly PermissionKey[]> = {
  tutor: PERMISSION_KEYS,
  guardian: ["students:read", "assignments:read", "messages:read", "dashboard:read"],
  student: [],
  bot: [],
};

export const DEV_TUTOR = { phone: "0700000000", password: "kusoma-dev", displayName: "Dev Tutor" };

export async function seed(): Promise<void> {
  await db.transaction(async (tx) => {
    // Roles
    await tx.insert(roles).values(ROLE_ROWS).onConflictDoNothing({ target: roles.key });

    // Permissions
    await tx
      .insert(permissions)
      .values(PERMISSION_KEYS.map((key) => ({ key })))
      .onConflictDoNothing({ target: permissions.key });

    const roleRows = await tx.select().from(roles);
    const permRows = await tx.select().from(permissions);
    const roleId = new Map(roleRows.map((r) => [r.key, r.id]));
    const permId = new Map(permRows.map((p) => [p.key, p.id]));

    // Grants
    const grantRows = Object.entries(GRANTS).flatMap(([role, keys]) =>
      keys.map((key) => ({ roleId: roleId.get(role)!, permissionId: permId.get(key)! })),
    );
    if (grantRows.length > 0) {
      await tx.insert(rolePermissions).values(grantRows).onConflictDoNothing();
    }

    // The bot user. Giving the bot a real users row is what lets
    // messages.sender_user_id be NOT NULL and chat_participants stay uniform.
    const existingBot = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(eq(userRoles.roleId, roleId.get("bot")!))
      .limit(1);

    if (existingBot.length === 0) {
      const [bot] = await tx
        .insert(users)
        .values({ displayName: "Kusoma Bot", phone: null, passwordHash: null })
        .returning({ id: users.id });
      await tx.insert(userRoles).values({ userId: bot!.id, roleId: roleId.get("bot")! });
    }

    // The dev tutor (§11) — exercises the real /auth/login path.
    const existingDev = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, DEV_TUTOR.phone))
      .limit(1);

    if (existingDev.length === 0) {
      const [dev] = await tx
        .insert(users)
        .values({
          displayName: DEV_TUTOR.displayName,
          phone: DEV_TUTOR.phone,
          passwordHash: await hashPassword(DEV_TUTOR.password),
          onboarded: false,
        })
        .returning({ id: users.id });
      await tx.insert(userRoles).values({ userId: dev!.id, roleId: roleId.get("tutor")! });
    }
  });
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isEntrypoint) {
  seed()
    .then(() => {
      console.log("seed: ok");
      console.log(`seed: dev tutor ${DEV_TUTOR.phone} / ${DEV_TUTOR.password}`);
    })
    .catch((err) => {
      console.error("seed: failed", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
