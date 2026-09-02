import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { PermissionKey } from "../db/schema.js";
import { forbidden, unauthorized } from "../lib/errors.js";

/**
 * Gate a route on a permission key, never on a role name (§8.2).
 *
 * A new role that is granted 'students:write' needs no route changes — that is
 * the whole point of role_permissions existing. If you find yourself wanting
 * `requireRole('tutor')` here, the grant is probably missing from the seed.
 */
export function requirePermission(...required: PermissionKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(unauthorized());

    const missing = required.filter((key) => !user.permissions.includes(key));
    if (missing.length > 0) {
      return next(forbidden(`Missing permission: ${missing.join(", ")}`));
    }
    next();
  };
}
