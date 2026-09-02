import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.js";
import { roles, userRoles, users } from "../db/schema.js";
import { badRequest, conflict, unauthorized } from "../lib/errors.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { resolveGrants } from "../middleware/authenticate.js";

export const authRouter = Router();

const registerBody = z.object({
  displayName: z.string().min(1).max(120),
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(200),
});

const loginBody = z.object({
  phone: z.string().min(6).max(20),
  password: z.string().min(1).max(200),
});

const publicUser = (u: { id: string; displayName: string; phone: string | null; onboarded: boolean }) => ({
  id: u.id,
  displayName: u.displayName,
  phone: u.phone,
  onboarded: u.onboarded,
});

/** POST /auth/register — creates a users row + the 'tutor' role. */
authRouter.post("/register", async (req, res, next) => {
  try {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");
    const { displayName, phone, password } = parsed.data;

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
    if (existing.length > 0) throw conflict("That phone number is already registered");

    const [tutorRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, "tutor")).limit(1);
    if (!tutorRole) throw new Error("Roles are not seeded — run `npm run db:seed`");

    const user = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ displayName, phone, passwordHash: await hashPassword(password) })
        .returning();
      await tx.insert(userRoles).values({ userId: created!.id, roleId: tutorRole.id });
      return created!;
    });

    const grants = await resolveGrants(user.id);
    res.status(201).json({
      token: signToken({ sub: user.id, roles: grants.roles }),
      user: publicUser(user),
      ...grants,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/login — ONE endpoint for tutors and guardians alike (§8.2).
 *
 * There is no /auth/guardian/login; the client routes on the roles array that
 * comes back. roles and permissions travel in the response body, not only in
 * the token, because nothing on the Expo side decodes JWTs.
 */
authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");
    const { phone, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);

    // Same error for "no such phone" and "wrong password" — don't leak which.
    // verifyPassword short-circuits on a null hash, so students and the bot
    // can never authenticate even if someone guesses their number.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized("Invalid phone or password");
    }
    if (!user.isActive) throw unauthorized("Account is inactive");

    const grants = await resolveGrants(user.id);
    res.json({
      token: signToken({ sub: user.id, roles: grants.roles }),
      user: publicUser(user),
      ...grants,
    });
  } catch (err) {
    next(err);
  }
});
