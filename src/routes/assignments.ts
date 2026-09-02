import { Router } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.js";
import { assignments } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { scopeStudent } from "../middleware/scope-student.js";

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

/** GET — history, including 'suggested' ones. Guardians can read this. */
assignmentsRouter.get("/", requirePermission("assignments:read"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, req.params.id!);
    const data = await db
      .select()
      .from(assignments)
      .where(eq(assignments.studentUserId, req.params.id!))
      .orderBy(desc(assignments.createdAt));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** POST — tutor-authored, lands directly at status='active' (§5). */
assignmentsRouter.post("/", requirePermission("assignments:write"), async (req, res, next) => {
  try {
    await scopeStudent(req.user!, req.params.id!);
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid body");

    const [created] = await db
      .insert(assignments)
      .values({
        studentUserId: req.params.id!,
        ...parsed.data,
        source: "tutor",
        status: "suggested", // flipped to active by activate(), pausing the prior one
      })
      .returning();

    const assignment = await activate(req.params.id!, created!.id);

    // TODO(phase-5): announce the new topic into the chat group so the student
    // sees it in Telegram rather than it being a silent DB write (§7).
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
      await scopeStudent(req.user!, req.params.id!);
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, req.params.assignmentId!))
        .limit(1);

      if (!row || row.studentUserId !== req.params.id) throw notFound("Assignment not found");
      if (row.status !== "suggested") throw badRequest("Only a suggested assignment can be accepted");

      res.json({ assignment: await activate(req.params.id!, row.id) });
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
      await scopeStudent(req.user!, req.params.id!);
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, req.params.assignmentId!))
        .limit(1);

      if (!row || row.studentUserId !== req.params.id) throw notFound("Assignment not found");
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
