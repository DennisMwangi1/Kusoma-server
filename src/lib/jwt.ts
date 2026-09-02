import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import type { RoleKey } from "../db/schema.js";

/**
 * One token shape for every principal (§8). Revision 1 used a discriminated
 * union of two shapes; that is gone.
 *
 * Permissions are deliberately NOT in the token — they are resolved per
 * request from role_permissions, so revoking a grant takes effect immediately
 * instead of when the token expires.
 */
export interface TokenClaims {
  sub: string;
  roles: RoleKey[];
}

const TTL = "30d";

export const signToken = (claims: TokenClaims): string =>
  jwt.sign(claims, env.jwtSecret, { expiresIn: TTL });

export function verifyToken(token: string): TokenClaims | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === "string" || !decoded.sub) return null;
    return { sub: String(decoded.sub), roles: (decoded as { roles?: RoleKey[] }).roles ?? [] };
  } catch {
    return null;
  }
}
