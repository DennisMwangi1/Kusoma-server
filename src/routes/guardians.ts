import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.js";
import { chatGroups, chatParticipants, userRelationships, userRoles, users } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { param } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { isTutorOf, scopeStudent } from "../middleware/scope-student.js";
import { roleIdFor } from "./students.js";

export const guardiansRouter = Router({ mergeParams: true });
guardiansRouter.use(authenticate);

const createBody = z.object({
  displayName: z.string().min(1).max(120),
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(200),
});

/**
 * POST /students/:id/guardians — the tutor adds a parent.
 *
 * Creates the users row + 'guardian' role + the 'guardian_of' relationship +
 * a chat_participants row as 'observer' with can_post = false. That last row
 * is what makes the parent read-only at the *room* level, alongside the
 * permission check at the route level (§15 — both, not either).
 */
guardiansRouter.post("/", requirePermission("guardians:write"), async (req, res, next) => {
  try {
    const studentUserId = param(req, "id");
    const kinds = await scopeStudent(req.user!, studentUserId);
    if (!isTutorOf(kinds)) throw badRequest("Only the owning tutor can add a guardian");

    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");
    const { displayName, phone, password } = parsed.data;

    const [student] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, studentUserId))
      .limit(1);
    if (!student) throw notFound("Student not found");

    const [group] = await db
      .select({ id: chatGroups.id })
      .from(chatGroups)
      .where(eq(chatGroups.studentUserId, studentUserId))
      .limit(1);
    if (!group) throw notFound("Chat group not found for this student");

    const guardianRoleId = await roleIdFor("guardian");
    const { hashPassword } = await import("../lib/password.js");

    // A guardian is a login account, so their phone must be unique among
    // accounts that can log in — that is exactly what the partial index
    // enforces, and why this check looks at password_hash too.
    const existing = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.phone, phone));
    if (existing.some((u) => u.passwordHash !== null)) {
      throw conflict("That phone number already belongs to an account");
    }

    const guardian = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ displayName, phone, passwordHash: await hashPassword(password) })
        .returning();

      await tx.insert(userRoles).values({ userId: created!.id, roleId: guardianRoleId });
      await tx.insert(userRelationships).values({
        fromUserId: created!.id,
        toUserId: studentUserId,
        relationship: "guardian_of",
      });
      await tx.insert(chatParticipants).values({
        chatGroupId: group.id,
        userId: created!.id,
        participantRole: "observer",
        canPost: false,
      });

      return created!;
    });

    res.status(201).json({
      guardian: { id: guardian.id, displayName: guardian.displayName, phone: guardian.phone },
    });
  } catch (err) {
    next(err);
  }
});
