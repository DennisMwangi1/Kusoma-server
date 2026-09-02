import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.js";
import {
  assignments,
  chatGroups,
  chatParticipants,
  messages,
  roles,
  studentPerformance,
  userRelationships,
  userRoles,
  users,
} from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { param } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { isTutorOf, listRelatedStudentIds, scopeStudent } from "../middleware/scope-student.js";
import { buildDeepLink, leaveChat } from "../services/telegram.js";

export const studentsRouter = Router();
studentsRouter.use(authenticate);

const createBody = z.object({
  firstName: z.string().min(1).max(120),
  grade: z.number().int().min(1).max(13),
  phone: z.string().min(6).max(20),
});

const patchBody = z.object({
  firstName: z.string().min(1).max(120).optional(),
  grade: z.number().int().min(1).max(13).optional(),
  phone: z.string().min(6).max(20).optional(),
});

async function roleIdFor(key: string): Promise<number> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1);
  if (!row) throw new Error(`Role '${key}' is not seeded — run \`npm run db:seed\``);
  return row.id;
}

/** The seeded bot user, which every room gets as a participant (§5.2). */
async function botUserId(): Promise<string> {
  const botRole = await roleIdFor("bot");
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(eq(userRoles.roleId, botRole))
    .limit(1);
  if (!row) throw new Error("Bot user is not seeded — run `npm run db:seed`");
  return row.id;
}

/**
 * GET /students — students the caller is related to.
 *
 * Tutor gets their roster, guardian gets their own child(ren). Same query,
 * different rows — no role branch (§8.2).
 */
studentsRouter.get("/", requirePermission("students:read"), async (req, res, next) => {
  try {
    const ids = await listRelatedStudentIds(req.user!);
    if (ids.length === 0) return res.json({ data: [] });

    const rows = await db.select().from(users).where(
      and(inArray(users.id, ids), eq(users.isActive, true)),
    );

    // Active assignment per student, for the dashboard's "current topic".
    const active = await db
      .select()
      .from(assignments)
      .where(and(inArray(assignments.studentUserId, ids), eq(assignments.status, "active")));
    const activeByStudent = new Map(active.map((a) => [a.studentUserId, a]));

    res.json({
      data: rows.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        grade: s.grade,
        phone: s.phone,
        isActive: s.isActive,
        telegramLinked: s.telegramUserId !== null,
        activeAssignment: activeByStudent.get(s.id) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /students — creates, in ONE transaction: the student users row, its
 * 'student' role, the 'tutor_of' relationship, the chat_groups row (with
 * telegram_chat_id still NULL), and chat_participants rows for tutor
 * ('owner'), student ('student'), and the bot ('bot').
 *
 * The room existing before Telegram is involved is what removes Revision 1's
 * ordering hazard — the webhook now only *binds* the chat id (§7).
 */
studentsRouter.post("/", requirePermission("students:write"), async (req, res, next) => {
  try {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");
    const { firstName, grade, phone } = parsed.data;
    const tutor = req.user!;

    const studentRoleId = await roleIdFor("student");
    const bot = await botUserId();

    const student = await db.transaction(async (tx) => {
      // No passwordHash: a student can never log in, and that absence is also
      // what keeps them out of the login-phone unique index — so a student may
      // share their guardian's number (§5).
      const [created] = await tx
        .insert(users)
        .values({ displayName: firstName, grade, phone, passwordHash: null })
        .returning();

      await tx.insert(userRoles).values({ userId: created!.id, roleId: studentRoleId });
      await tx.insert(userRelationships).values({
        fromUserId: tutor.id,
        toUserId: created!.id,
        relationship: "tutor_of",
      });

      const [group] = await tx
        .insert(chatGroups)
        .values({
          ownerUserId: tutor.id,
          studentUserId: created!.id,
          telegramChatId: null,
          title: `${tutor.displayName} & ${firstName}`,
        })
        .returning();

      await tx.insert(chatParticipants).values([
        { chatGroupId: group!.id, userId: tutor.id, participantRole: "owner", canPost: true },
        { chatGroupId: group!.id, userId: created!.id, participantRole: "student", canPost: true },
        { chatGroupId: group!.id, userId: bot, participantRole: "bot", canPost: true },
      ]);

      return created!;
    });

    res.status(201).json({
      student: {
        id: student.id,
        displayName: student.displayName,
        grade: student.grade,
        phone: student.phone,
        isActive: student.isActive,
      },
      // The critical handoff between the Expo app and Telegram (§7).
      telegramDeepLink: buildDeepLink(student.id),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /students/:id — profile + active assignment + performance. */
studentsRouter.get("/:id", requirePermission("students:read"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, param(req, "id"));

    const [student] = await db.select().from(users).where(eq(users.id, param(req, "id"))).limit(1);
    if (!student) throw notFound("Student not found");

    const assignmentRows = await db
      .select()
      .from(assignments)
      .where(eq(assignments.studentUserId, student.id))
      .orderBy(desc(assignments.createdAt));

    const performance = await db
      .select()
      .from(studentPerformance)
      .where(eq(studentPerformance.studentUserId, student.id));

    const [group] = await db
      .select({ id: chatGroups.id, telegramChatId: chatGroups.telegramChatId })
      .from(chatGroups)
      .where(eq(chatGroups.studentUserId, student.id))
      .limit(1);

    res.json({
      student: {
        id: student.id,
        displayName: student.displayName,
        grade: student.grade,
        phone: student.phone,
        isActive: student.isActive,
        telegramLinked: student.telegramUserId !== null,
      },
      activeAssignment: assignmentRows.find((a) => a.status === "active") ?? null,
      suggestedAssignments: assignmentRows.filter((a) => a.status === "suggested"),
      performance,
      chatGroup: group ? { id: group.id, telegramLinked: group.telegramChatId !== null } : null,
      // The client re-renders the group-creation steps here whenever the link
      // is still pending, so the tutor is never stuck with a toast they
      // dismissed at creation time being the only place the /start lives.
      telegramDeepLink: buildDeepLink(student.id),
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /students/:id — a guardian's token cannot reach this (no :write). */
studentsRouter.patch("/:id", requirePermission("students:write"), async (req, res, next) => {
  try {
    const kinds = await scopeStudent(req.user!, param(req, "id"));
    if (!isTutorOf(kinds)) throw badRequest("Only the owning tutor can edit a student");

    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");
    const { firstName, grade, phone } = parsed.data;

    const [updated] = await db
      .update(users)
      .set({
        ...(firstName !== undefined && { displayName: firstName }),
        ...(grade !== undefined && { grade }),
        ...(phone !== undefined && { phone }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, param(req, "id")))
      .returning();

    res.json({
      student: {
        id: updated!.id,
        displayName: updated!.displayName,
        grade: updated!.grade,
        phone: updated!.phone,
        isActive: updated!.isActive,
        telegramLinked: updated!.telegramUserId !== null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /students/:id — removes the student and everything hanging off them.
 *
 * Deliberately a hard delete, not the is_active flag it used to set: a tutor
 * who removes a student expects the roster row, the chat, the transcript and
 * the performance history to be gone, and a soft-deleted student still holds
 * the unique (owner, student) chat room and their Telegram user id hostage.
 *
 * Every child table cascades from users.id, so the DELETE alone would do it —
 * but messages.sender_user_id has no ON DELETE clause, which only happens to
 * work because those messages are also cascaded from the group. That is too
 * subtle to rely on, so the rows come out explicitly, in FK order, in one
 * transaction.
 *
 * Guardians are users in their own right and may guard other students, so they
 * survive — only the relationship rows linking them here are removed.
 */
studentsRouter.delete("/:id", requirePermission("students:write"), async (req, res, next) => {
  try {
    const studentId = param(req, "id");
    const kinds = await scopeStudent(req.user!, studentId);
    if (!isTutorOf(kinds)) throw badRequest("Only the owning tutor can remove a student");

    const groups = await db
      .select({ id: chatGroups.id, telegramChatId: chatGroups.telegramChatId })
      .from(chatGroups)
      .where(eq(chatGroups.studentUserId, studentId));
    const groupIds = groups.map((g) => g.id);

    await db.transaction(async (tx) => {
      if (groupIds.length > 0) {
        await tx.delete(messages).where(inArray(messages.chatGroupId, groupIds));
        await tx
          .delete(chatParticipants)
          .where(inArray(chatParticipants.chatGroupId, groupIds));
        await tx.delete(chatGroups).where(inArray(chatGroups.id, groupIds));
      }
      await tx.delete(assignments).where(eq(assignments.studentUserId, studentId));
      await tx
        .delete(studentPerformance)
        .where(eq(studentPerformance.studentUserId, studentId));
      await tx
        .delete(userRelationships)
        .where(eq(userRelationships.toUserId, studentId));
      await tx.delete(userRoles).where(eq(userRoles.userId, studentId));
      await tx.delete(users).where(eq(users.id, studentId));
    });

    // After the commit — a Telegram hiccup must not roll back a delete that
    // already succeeded, and the webhook has nothing left to bind to anyway.
    for (const g of groups) {
      if (g.telegramChatId !== null) await leaveChat(g.telegramChatId);
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { botUserId, roleIdFor };
