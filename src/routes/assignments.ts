import { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.js";
import { assignments, chatGroups } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { param } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { scopeStudent } from "../middleware/scope-student.js";
import { sendMessage } from "../services/telegram.js";

export const assignmentsRouter = Router({ mergeParams: true });
assignmentsRouter.use(authenticate);

const createBody = z.object({
  cbcNodeId: z.string().uuid(),
  strand: z.string().min(1),
  subStrand: z.string().min(1),
  learningOutcome: z.string().min(1),
});

/** Only one assignment is active at a time; the previous one is paused. */
async function activate(studentUserId: string, assignmentId: string) {
  return db.transaction(async (tx) => {
    await tx
      .update(assignments)
      .set({ status: "paused" })
      .where(
        and(
          eq(assignments.studentUserId, studentUserId),
          eq(assignments.status, "active"),
          ne(assignments.id, assignmentId),
        ),
      );
    const [row] = await tx
      .update(assignments)
      .set({ status: "active" })
      .where(eq(assignments.id, assignmentId))
      .returning();
    return row;
  });
}

/** Announce a new/accepted topic into the linked Telegram group (§7). */
async function announceToTelegram(studentUserId: string, assignment: { strand: string; subStrand: string; learningOutcome: string }): Promise<void> {
  try {
    const [group] = await db
      .select({ telegramChatId: chatGroups.telegramChatId })
      .from(chatGroups)
      .where(eq(chatGroups.studentUserId, studentUserId))
      .limit(1);
    if (!group?.telegramChatId) return;
    await sendMessage(
      group.telegramChatId,
      `📘 New topic: ${assignment.strand} — ${assignment.subStrand}\n` +
        `Learning outcome: ${assignment.learningOutcome}`,
    );
  } catch (err) {
    console.error("assignments: telegram announcement failed", err);
  }
}

/** GET — history, including 'suggested' ones. Guardians can read this. */
assignmentsRouter.get("/", requirePermission("assignments:read"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, param(req, "id"));
    const data = await db
      .select()
      .from(assignments)
      .where(eq(assignments.studentUserId, param(req, "id")))
      .orderBy(desc(assignments.createdAt));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** POST — tutor-authored, lands directly at status='active' (§5). */
assignmentsRouter.post("/", requirePermission("assignments:write"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, param(req, "id"));
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");

    const studentId = param(req, "id");
    const assignment = await db.transaction(async (tx) => {
      // Pause any currently active assignment for this student.
      await tx
        .update(assignments)
        .set({ status: "paused" })
        .where(
          and(
            eq(assignments.studentUserId, studentId),
            eq(assignments.status, "active"),
          ),
        );

      const [created] = await tx
        .insert(assignments)
        .values({
          studentUserId: studentId,
          ...parsed.data,
          source: "tutor",
          status: "active",
        })
        .returning();
      return created!;
    });

    void announceToTelegram(studentId, assignment);
    res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

/** POST :assignmentId/accept — suggested -> active (§9.2 step 4). */
assignmentsRouter.post(
  "/:assignmentId/accept",
  requirePermission("assignments:write"),
  async (req, res, next) => {
    try {
      await scopeStudent(req.user!, param(req, "id"));
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, param(req, "assignmentId")))
        .limit(1);

      if (!row || row.studentUserId !== param(req, "id")) throw notFound("Assignment not found");
      if (row.status !== "suggested") throw badRequest("Only a suggested assignment can be accepted");

      const accepted = await activate(param(req, "id"), row.id);
      if (accepted) {
        void announceToTelegram(param(req, "id"), accepted);
      }
      res.json({ assignment: accepted });
    } catch (err) {
      next(err);
    }
  },
);

/** POST :assignmentId/dismiss — suggested -> dismissed. */
assignmentsRouter.post(
  "/:assignmentId/dismiss",
  requirePermission("assignments:write"),
  async (req, res, next) => {
    try {
      await scopeStudent(req.user!, param(req, "id"));
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, param(req, "assignmentId")))
        .limit(1);

      if (!row || row.studentUserId !== param(req, "id")) throw notFound("Assignment not found");
      if (row.status !== "suggested") throw badRequest("Only a suggested assignment can be dismissed");

      const [updated] = await db
        .update(assignments)
        .set({ status: "dismissed" })
        .where(eq(assignments.id, row.id))
        .returning();

      res.json({ assignment: updated });
    } catch (err) {
      next(err);
    }
  },
);
