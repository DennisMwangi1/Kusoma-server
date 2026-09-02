import { eq, inArray } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { db } from "../db/client.js";
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
  type PermissionKey,
  type RoleKey,
} from "../db/schema.js";
import { unauthorized } from "../lib/errors.js";
import { verifyToken } from "../lib/jwt.js";

export interface AuthedUser {
  id: string;
  displayName: string;
  onboarded: boolean;
  roles: RoleKey[];
  permissions: PermissionKey[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Resolve a user's roles and the permissions those roles grant.
 *
 * Read fresh per request rather than baked into the JWT, so revoking a grant
 * takes effect immediately. At prototype scale this is two indexed joins; if
 * it ever shows up in a profile, cache it per-request, not per-token.
 */
export async function resolveGrants(
  userId: string,
): Promise<{ roles: RoleKey[]; permissions: PermissionKey[] }> {
  const roleRows = await db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));

  const roleKeys = roleRows.map((r) => r.key as RoleKey);
  if (roleKeys.length === 0) return { roles: [], permissions: [] };

  const permRows = await db
    .selectDistinct({ key: permissions.key })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));

  return { roles: roleKeys, permissions: permRows.map((p) => p.key as PermissionKey) };
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");

    const claims = verifyToken(header.slice("Bearer ".length));
    if (!claims) throw unauthorized("Invalid or expired token");

    const [row] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        onboarded: users.onboarded,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!row || !row.isActive) throw unauthorized("Account not found or inactive");

    const grants = await resolveGrants(row.id);
    req.user = {
      id: row.id,
      displayName: row.displayName,
      onboarded: row.onboarded,
      roles: grants.roles,
      permissions: grants.permissions,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Used by the WS hub, which authenticates a token from the query string. */
export async function authenticateToken(token: string): Promise<AuthedUser | null> {
  const claims = verifyToken(token);
  if (!claims) return null;

  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      onboarded: users.onboarded,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!row || !row.isActive) return null;

  const grants = await resolveGrants(row.id);
  return { id: row.id, displayName: row.displayName, onboarded: row.onboarded, ...grants };
}

/** Convenience for the seed/tests: does this user hold any of these roles? */
export const hasRole = (user: AuthedUser, ...keys: RoleKey[]): boolean =>
  user.roles.some((r) => keys.includes(r));

export { inArray };
